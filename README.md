# Pinna

Live spatial audio + speech-to-text demo on a $40 dev board, running 100% local on Apple Silicon.

![demo](demo.gif)

Captures audio from a Seeed ReSpeaker XVF3800 4-Mic Array, reads real-time Direction of Arrival (DOA) from the chip, segments speech with Silero VAD, transcribes with MLX Whisper, and renders a conference-room floor plan with live beam cones, color-coded speaker clustering, and keyword alerts. All on-device. No cloud.

Named after the outer ear -- the structure that captures and directs sound.

## Why this exists

The XVF3800 is a great little $40 dev board with one frustrating gap: the official docs and most Python examples reference an old USB control protocol that doesn't work on current firmware. Anybody trying to wire it into a custom pipeline hits the same I/O error and gives up. This repo documents the working protocol (vendor control transfer, command 75, retry-on-busy) and shows what you can build once you have the angles flowing.

## Hardware

- **Microphone:** Seeed Studio ReSpeaker XVF3800 4-Mic Array (USB)
  - VID `0x2886`, PID `0x001A`
  - Tested on firmware `2.06`
  - Standard 2-channel beamformed firmware (a 6-channel raw-mic variant exists for software beamforming; not used here)
- **Host:** Apple Silicon Mac (Mac Studio M2 Ultra in development; should work on any M-series)
- **OS:** macOS. Linux probably works for the audio + DOA pieces but the MLX Whisper STT path is Apple-specific.

## Quickstart

```bash
brew install libusb
git clone https://github.com/bwelker/pinna.git
cd pinna
python3.12 -m venv .venv
./.venv/bin/pip install sounddevice numpy mlx-whisper pyusb websockets silero-vad
sudo ./run-demo.sh
```

The demo opens `http://localhost:8080` automatically. First run downloads the Whisper model (~1.5 GB) and the Silero VAD model (~1.5 MB).

`sudo` is required for `pyusb` to access the XMOS vendor control endpoint on macOS. There is no way around this.

## What's in the UI

- **Floor plan** with the ReSpeaker placed at a known position on a conference room table. Animated cones show where each of the 4 firmware-tracked beams is pointing in real time.
- **Two-tab sidebar:**
  - *Controls:* sensitivity slider (RMS gate), calibrate (manual offset + mirror toggle, or two-point click-and-clap), beam toggles with descriptions, editable keyword list with per-keyword alert sound (5 macOS sounds bundled).
  - *Transcript:* full-height live transcript with speaker color-coding by DOA cluster, keyword highlights, and red-flash alerts.
- **Calibration:** click "Auto Calibrate", then click two spots on the floor plan and clap from each. The app captures the mic's reported angles and computes both rotation offset and handedness in a single pass.

The conference room PNG (`viz/assets/confroom.png`) is a 14'4" x 14'4" generic room layout. Swap with your own floor plan and update `MIC_POS_PX` / `TEAMS_POS_PX` constants in `viz/app.js`.

## DOA Protocol

The XVF3800 exposes Direction of Arrival via USB **vendor** control transfers (XMOS servicer protocol, NOT USB audio class). The combination that works on firmware 2.06:

```python
import struct, math, usb.core, usb.util, time

dev = usb.core.find(idVendor=0x2886, idProduct=0x001A)

# AEC_AZIMUTH_VALUES: resid=33 (AEC block), cmdid=75
# Response: 1 status byte + 4*float32 (radians)
# Status: 0 = success, 64 = SERVICER_COMMAND_RETRY (busy, try again)
for _ in range(50):
    resp = dev.ctrl_transfer(
        usb.util.CTRL_IN | usb.util.CTRL_TYPE_VENDOR | usb.util.CTRL_RECIPIENT_DEVICE,
        0,              # bRequest
        0x80 | 75,      # wValue = 0x80 | cmdid (read bit set)
        33,             # wIndex = resid
        17,             # wLength = 4*4 + 1
        500,            # timeout ms
    )
    if resp[0] == 0:
        angles = struct.unpack("<ffff", bytes(resp[1:17]))
        print([math.degrees(a) for a in angles])
        break
    if resp[0] == 64:
        time.sleep(0.01); continue
    raise RuntimeError(f"status 0x{resp[0]:02X}")
```

The 4 beam slots returned:
- `beam1`, `beam2` -- "locked tracking" beams, each holds onto a detected voice for several seconds. Designed for two-participant conference calls.
- `free` -- a continuously scanning beam looking for new sources.
- `auto` -- the firmware's pick of the strongest beam right now. Use this as the primary direction in single-speaker UIs.

Other useful resource/command pairs from the XMOS servicer table:
- `DOA_VALUE` -- resid 20, cmdid 18, returns a single auto-selected angle.
- `AEC_SPENERGY_VALUES` -- resid 33, cmdid 80, returns per-beam speech energy. Useful for picking the most "active" beam yourself.

Reference (the file that unlocked this): [respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/python_control/xvf_host.py](https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/blob/master/python_control/xvf_host.py).

## macOS gotchas

- **Never call `dev.reset()` or `dev.set_configuration()` on this device.** CoreAudio owns interfaces 0/1/2; a reset knocks the device off the USB bus and recovery requires a physical unplug/replug.
- **Don't `detach_kernel_driver()` on the audio interfaces.** Only interface #3 (class `0xFF`, vendor-specific) is safe to touch. In practice, vendor control transfers on the default pipe coexist fine with an open `sounddevice.InputStream` -- no interface claim needed.
- **Two pyusb processes can't share the control interface.** If you run `test_doa.py` while `server.py` is live, the second process will silently steal the interface and the first will start returning all zeros. Restart the server to recover.

## Files

- `server.py` -- main backend: audio capture, DOA polling, Silero VAD, MLX Whisper, WebSocket fan-out, static HTTP server.
- `capture.py` -- standalone capture utility (writes WAV + DOA JSONL to disk).
- `test_doa.py` -- protocol probe and 40-iteration DOA validator.
- `run-demo.sh` -- launcher (handles sudo, opens browser).
- `viz/` -- HTML/JS/CSS frontend.

## Known limits

- Single audio stream from the firmware's beamformed output. Two people talking simultaneously gets one transcript (whichever the firmware picks as dominant). True per-speaker separation requires the 6-channel raw-mic firmware variant + software beamforming; not implemented yet.
- Whisper large-v3-turbo is good but not conversational-streaming grade. Faster-whisper or whisperkit would be lighter for some use cases.
- The "auto" beam can flicker between two equally-loud sources. Heuristic improvements welcome.

## License

Apache 2.0 -- see [LICENSE](LICENSE).
