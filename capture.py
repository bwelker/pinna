#!/usr/bin/env python3
"""pinna -- Spatial audio capture with DOA from ReSpeaker XVF3800.

Captures beamformed audio from the XVF3800 4-Mic Array while polling
Direction of Arrival (DOA) data. Outputs timestamped audio segments
with speaker angle annotations for diarization.

Usage:
    sudo python3 capture.py [--duration 60] [--output /path/to/output]
"""

import argparse
import asyncio
import json
import math
import os
import struct
import sys
import time
import wave
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd

# DOA access via pyusb
try:
    import usb.core
    import usb.util
    HAS_USB = True
except ImportError:
    HAS_USB = False
    print("WARNING: pyusb not available -- DOA disabled")


# XVF3800 USB identifiers
VID = 0x2886
PID = 0x001A

# Audio config
SAMPLE_RATE = 16000
CHANNELS = 2  # beamformed + reference
BLOCK_SIZE = 4800  # 300ms blocks


# XMOS servicer protocol (XVF3800 firmware 2.x)
# Reference: https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/blob/master/python_control/xvf_host.py
_CONTROL_SUCCESS = 0
_SERVICER_COMMAND_RETRY = 64
_AEC_AZIMUTH_VALUES = (33, 75, 4)  # resid=33 (AEC), cmdid=75, 4 float32 values (radians)

# Counter so we only print the first N USB errors (avoids log flood while
# still making the failure visible).
_DOA_ERR_COUNT = 0
_DOA_ERR_LIMIT = 10


def get_doa_device():
    """Find the XVF3800 USB device. Do NOT reset or set_configuration on
    macOS -- CoreAudio has the audio interfaces and reset will knock the
    device off the bus (requires physical unplug/replug to recover)."""
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        return None
    return dev


def read_doa(dev):
    """Read 4-beam azimuth from XVF3800 via vendor control transfer.
    Returns [beam1_deg, beam2_deg, free_deg, auto_deg] in degrees.
    Returns [0,0,0,0] on failure."""
    global _DOA_ERR_COUNT
    if dev is None:
        return [0.0, 0.0, 0.0, 0.0]

    resid, cmdid, num = _AEC_AZIMUTH_VALUES
    length = num * 4 + 1  # 4 floats + 1 status byte

    try:
        for _ in range(50):
            resp = dev.ctrl_transfer(
                usb.util.CTRL_IN | usb.util.CTRL_TYPE_VENDOR | usb.util.CTRL_RECIPIENT_DEVICE,
                0,                # bRequest
                0x80 | cmdid,     # wValue
                resid,            # wIndex
                length,           # wLength
                500,              # timeout (ms)
            )
            status = resp[0]
            if status == _CONTROL_SUCCESS:
                payload = bytes(resp[1:])
                rads = struct.unpack("<" + "f" * num, payload[:num * 4])
                return [round(math.degrees(r), 1) for r in rads]
            if status == _SERVICER_COMMAND_RETRY:
                time.sleep(0.01)
                continue
            raise RuntimeError(f"unexpected status 0x{status:02X}")
        raise RuntimeError("servicer retry timeout")
    except Exception as e:
        if _DOA_ERR_COUNT < _DOA_ERR_LIMIT:
            print(f"[doa] read error: {e}", file=sys.stderr)
            _DOA_ERR_COUNT += 1
            if _DOA_ERR_COUNT == _DOA_ERR_LIMIT:
                print(f"[doa] suppressing further errors after {_DOA_ERR_LIMIT}",
                      file=sys.stderr)
        return [0.0, 0.0, 0.0, 0.0]


def find_respeaker_device():
    """Find the ReSpeaker device index for sounddevice."""
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        if 'respeaker' in d['name'].lower() or 'xvf' in d['name'].lower():
            return i
    return None


def main():
    parser = argparse.ArgumentParser(description="Pinna spatial audio capture")
    parser.add_argument("--duration", type=int, default=60, help="Capture duration in seconds")
    parser.add_argument("--output", type=str, default="./pinna-capture", help="Output directory")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Find audio device
    dev_idx = find_respeaker_device()
    if dev_idx is None:
        print("ERROR: ReSpeaker not found")
        sys.exit(1)
    print(f"Audio device: {sd.query_devices(dev_idx)['name']}")

    # Find USB control device for DOA
    usb_dev = get_doa_device() if HAS_USB else None
    if usb_dev:
        print(f"DOA device: VID={VID:#06x} PID={PID:#06x}")
        angles = read_doa(usb_dev)
        print(f"Initial DOA: {angles}")
    else:
        print("DOA: not available")

    # Prepare output
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    wav_path = output_dir / f"pinna-{timestamp}.wav"
    doa_path = output_dir / f"pinna-{timestamp}-doa.jsonl"

    # Capture
    print(f"\nCapturing {args.duration}s -> {wav_path}")
    print("Press Ctrl+C to stop early\n")

    audio_buffer = []
    doa_log = []
    start_time = time.time()

    def audio_callback(indata, frames, time_info, status):
        if status:
            print(f"Audio status: {status}")
        audio_buffer.append(indata.copy())

    try:
        with sd.InputStream(device=dev_idx, samplerate=SAMPLE_RATE,
                          channels=CHANNELS, dtype='int16',
                          blocksize=BLOCK_SIZE, callback=audio_callback):
            while time.time() - start_time < args.duration:
                # Poll DOA every 300ms
                time.sleep(0.3)
                elapsed = time.time() - start_time
                angles = read_doa(usb_dev) if usb_dev else [0,0,0,0]
                entry = {"t": round(elapsed, 1), "doa": angles}
                doa_log.append(entry)

                # Print status
                if int(elapsed) % 5 == 0 and elapsed - int(elapsed) < 0.3:
                    print(f"  {int(elapsed)}s | DOA: {angles[0]:.0f}° {angles[1]:.0f}° | "
                          f"blocks: {len(audio_buffer)}")

    except KeyboardInterrupt:
        print("\nStopped.")

    # Save audio
    if audio_buffer:
        audio = np.concatenate(audio_buffer)
        with wave.open(str(wav_path), 'w') as wf:
            wf.setnchannels(CHANNELS)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(audio.tobytes())
        print(f"Audio saved: {wav_path} ({len(audio)/SAMPLE_RATE:.1f}s)")

    # Save DOA log
    if doa_log:
        with open(doa_path, 'w') as f:
            for entry in doa_log:
                f.write(json.dumps(entry) + '\n')
        print(f"DOA log saved: {doa_path} ({len(doa_log)} samples)")

    print("Done.")


if __name__ == "__main__":
    main()
