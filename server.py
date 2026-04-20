#!/usr/bin/env python3
"""pinna server -- live DOA + transcription with WebSocket streaming.

Runs the ReSpeaker XVF3800 capture pipeline, polls DOA every ~300ms,
uses Silero VAD to segment continuous audio into utterances, runs MLX
Whisper on each complete utterance, clusters utterances by DOA to
produce stable speaker_ids, and streams everything to a browser over
WebSocket. Also serves the viz/ static directory over HTTP.

Usage:
    sudo ./.venv/bin/python server.py              # live from mic
    sudo ./.venv/bin/python server.py --no-whisper # DOA only, skip STT

Live-only: if the ReSpeaker XVF3800 is not present, the server errors
out rather than falling back to synthetic data.

Ports:
    8080 -- HTTP (serves viz/)
    8765 -- WebSocket (JSON events)
"""

import argparse
import asyncio
import json
import math
import os
import queue
import struct
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np

try:
    import sounddevice as sd
    HAS_SD = True
except Exception:
    HAS_SD = False

try:
    import usb.core
    import usb.util
    HAS_USB = True
except Exception:
    HAS_USB = False

try:
    import websockets
    HAS_WS = True
except Exception:
    HAS_WS = False

# XVF3800 USB identifiers
VID = 0x2886
PID = 0x001A

# Audio config
SAMPLE_RATE = 16000
CHANNELS = 2  # beamformed + reference
BLOCK_SIZE = 4800  # 300ms blocks

# DOA clustering: utterances within this many degrees count as the same speaker
SPEAKER_CLUSTER_TOLERANCE_DEG = 20.0

# ----------------------------------------------------------------------
# Silero VAD segmentation parameters
# ----------------------------------------------------------------------
# Silero VAD at 16 kHz expects 512-sample frames (32 ms per frame).
VAD_FRAME_SAMPLES = 512
VAD_FRAME_MS = VAD_FRAME_SAMPLES * 1000 // SAMPLE_RATE  # 32 ms

# Probability threshold for a frame to count as speech.
VAD_SPEECH_THRESHOLD = 0.25

# Consecutive speech frames required before committing to an utterance (~64 ms).
VAD_MIN_SPEECH_FRAMES = 2

# Consecutive silence frames required to close an utterance (~640 ms pause).
VAD_MIN_SILENCE_FRAMES = 20

# Pad this many frames of pre-speech audio into the utterance so onsets
# are not clipped (~1.12 s -- covers the detection delay plus soft onsets).
VAD_PADDING_FRAMES_BEFORE = 35

# Pad this many frames of trailing audio after speech ends (~160 ms).
VAD_PADDING_FRAMES_AFTER = 5

# Force-close a single utterance if it gets this long (guards against
# runaway captures when VAD keeps re-triggering).
VAD_MAX_UTTERANCE_SEC = 15.0

# When the DOA trajectory across an utterance spans more than this many
# degrees, mark it overlap_suspected so the UI can hint at multi-speaker.
OVERLAP_TRAJECTORY_SPAN_DEG = 30.0

# RMS sensitivity is kept around for the UI slider (DOA event visualization
# only). It no longer gates transcription -- VAD does that now.
SILENCE_RMS_THRESHOLD = 120.0
RUNTIME_CONFIG = {
    "rms_threshold": SILENCE_RMS_THRESHOLD,
    "min_beam_energy": 0.0,
    "vad_threshold": VAD_SPEECH_THRESHOLD,
}
_CONFIG_LOCK = threading.Lock()


def get_runtime_config():
    with _CONFIG_LOCK:
        return dict(RUNTIME_CONFIG)


def update_runtime_config(**kwargs):
    with _CONFIG_LOCK:
        for k, v in kwargs.items():
            if k in RUNTIME_CONFIG and isinstance(v, (int, float)):
                RUNTIME_CONFIG[k] = float(v)
        return dict(RUNTIME_CONFIG)


WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo"

SCRIPT_DIR = Path(__file__).parent
VIZ_DIR = SCRIPT_DIR / "viz"


# ----------------------------------------------------------------------
# DOA + Audio capture (real hardware)
# ----------------------------------------------------------------------

# -- XMOS servicer protocol (XVF3800 firmware 2.x) --
# Reference: https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/blob/master/python_control/xvf_host.py
#
# Transfer:  bmRequestType = CTRL_IN|CTRL_TYPE_VENDOR|CTRL_RECIPIENT_DEVICE (0xC0)
#            bRequest      = 0
#            wValue        = 0x80 | cmdid
#            wIndex        = resid
#            wLength       = (payload bytes) + 1 status byte
# Response first byte is status:
#            0  -> success
#            64 -> SERVICER_COMMAND_RETRY (busy, retry in ~10ms)
# AEC_AZIMUTH_VALUES is (resid=33, cmdid=75, 4 float32 values in radians),
# returning [beam1, beam2, free-running, auto-selected].
#
# macOS caveats:
#   - NEVER call dev.reset() or dev.set_configuration(). CoreAudio owns the
#     audio interfaces (0/1/2); reset will knock the device off the bus and
#     only physical unplug/replug recovers it.
#   - Vendor control transfers to the default pipe coexist fine with the
#     audio streams; no kernel driver detach is needed in the normal case.

_CONTROL_SUCCESS = 0
_SERVICER_COMMAND_RETRY = 64
_AEC_AZIMUTH_VALUES = (33, 75, 4)  # (resid, cmdid, num_float_values)

_DOA_ERR_COUNT = 0
_DOA_ERR_LIMIT = 10


def get_doa_device():
    """Find XVF3800 USB device. Do not reset or reconfigure -- CoreAudio has
    claims on the audio interfaces."""
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    return dev


def read_doa(dev):
    """Read 4 azimuth angles (degrees) from XVF3800 via vendor control read.
    Returns [beam1, beam2, free, auto] in degrees. On error returns zeros and
    prints up to _DOA_ERR_LIMIT diagnostic lines to stderr."""
    global _DOA_ERR_COUNT
    if dev is None:
        return [0.0, 0.0, 0.0, 0.0]

    resid, cmdid, num = _AEC_AZIMUTH_VALUES
    length = num * 4 + 1

    try:
        for _ in range(50):
            resp = dev.ctrl_transfer(
                usb.util.CTRL_IN | usb.util.CTRL_TYPE_VENDOR | usb.util.CTRL_RECIPIENT_DEVICE,
                0,
                0x80 | cmdid,
                resid,
                length,
                500,
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
    if not HAS_SD:
        return None
    devices = sd.query_devices()
    for i, d in enumerate(devices):
        name = d['name'].lower()
        if 'respeaker' in name or 'xvf' in name:
            if d.get('max_input_channels', 0) > 0:
                return i
    return None


# Named beam slot order as returned by XVF3800 AEC_AZIMUTH_VALUES:
# result[0]=status byte, result[1:5]=beam1, result[5:9]=beam2,
# result[9:13]=free, result[13:17]=auto  (each 4 float32 LE radians).
# Verified against /tmp/seeed_xvf/respeaker_get_doa.py (PARAMETERS entry).
BEAM_NAMES = ("beam1", "beam2", "free", "auto")
AUTO_BEAM_IDX = 3  # firmware's own "strongest now" pick


# ----------------------------------------------------------------------
# Speaker clustering by DOA
# ----------------------------------------------------------------------

class SpeakerClusterer:
    """Assigns stable speaker_ids based on angular proximity of utterances."""
    def __init__(self, tolerance_deg=SPEAKER_CLUSTER_TOLERANCE_DEG):
        self.tolerance = tolerance_deg
        self.clusters = []  # list of dicts: {id, center_deg, count}
        self._next_id = 1

    def _ang_dist(self, a, b):
        return abs(((a - b + 180) % 360) - 180)

    def assign(self, angle_deg):
        # find nearest cluster within tolerance
        best = None
        best_d = self.tolerance + 1
        for c in self.clusters:
            d = self._ang_dist(angle_deg, c['center_deg'])
            if d < best_d:
                best_d = d
                best = c
        if best is not None and best_d <= self.tolerance:
            # update running mean
            n = best['count']
            # wraparound-safe mean: shift angle to within 180 of center
            shifted = angle_deg
            diff = ((shifted - best['center_deg'] + 180) % 360) - 180
            new_center = (best['center_deg'] + diff / (n + 1)) % 360
            best['center_deg'] = new_center
            best['count'] = n + 1
            return best['id']
        new_id = self._next_id
        self._next_id += 1
        self.clusters.append({'id': new_id, 'center_deg': angle_deg % 360, 'count': 1})
        return new_id


# ----------------------------------------------------------------------
# Event bus -- workers push JSON-serializable dicts; websocket fans out
# ----------------------------------------------------------------------

class EventBus:
    def __init__(self):
        self._subscribers = set()
        self._lock = threading.Lock()
        self._loop = None

    def attach_loop(self, loop):
        self._loop = loop

    def subscribe(self, q):
        with self._lock:
            self._subscribers.add(q)

    def unsubscribe(self, q):
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, event):
        """Thread-safe publish from any thread -- schedules onto the event loop."""
        if self._loop is None:
            return
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                self._loop.call_soon_threadsafe(q.put_nowait, event)
            except Exception:
                pass


# ----------------------------------------------------------------------
# Live capture worker
# ----------------------------------------------------------------------

class LiveCapture(threading.Thread):
    def __init__(self, bus, use_whisper=True, device_idx=None, usb_dev=None):
        super().__init__(daemon=True)
        self.bus = bus
        self.use_whisper = use_whisper
        self.device_idx = device_idx
        self.usb_dev = usb_dev
        self.stop_flag = threading.Event()
        self._audio_q = queue.Queue()   # blocks of np.int16 frames (CHANNELS wide)
        # Queue of completed utterances: (int16 mono samples, start_ts, end_ts)
        self._whisper_q = queue.Queue()
        self._recent_angles = []        # (ts, strongest_angle_deg), for correlating with utterances
        self._recent_lock = threading.Lock()
        self.clusterer = SpeakerClusterer()
        self._whisper_thread = None
        self._vad_thread = None
        # Rolling audio RMS (updated on every audio block, read by DOA loop)
        self._current_rms = 0.0
        self._rms_lock = threading.Lock()

    def run(self):
        print(f"[capture] audio device index: {self.device_idx}")
        print(f"[capture] USB DOA: {'ok' if self.usb_dev else 'unavailable'}")
        print(f"[capture] whisper: {'on' if self.use_whisper else 'off'}")

        # Start whisper worker
        if self.use_whisper:
            self._whisper_thread = threading.Thread(target=self._whisper_worker, daemon=True)
            self._whisper_thread.start()

        # Start VAD segmenter (turns raw audio blocks into utterances)
        self._vad_thread = threading.Thread(target=self._vad_loop, daemon=True)
        self._vad_thread.start()

        # Start DOA poller (interleaved via separate thread but only touches USB)
        doa_thread = threading.Thread(target=self._doa_loop, daemon=True)
        doa_thread.start()

        def audio_cb(indata, frames, time_info, status):
            if status:
                # non-fatal; print and continue
                print(f"[audio] status: {status}", file=sys.stderr)
            # Update rolling RMS from the beamformed channel (ch 0).
            # Cheap per-block compute -- the DOA loop reads this to stamp events.
            try:
                mono = indata[:, 0].astype(np.float32)
                r = float(np.sqrt(np.mean(mono * mono))) if mono.size else 0.0
                with self._rms_lock:
                    self._current_rms = r
            except Exception:
                pass
            # Pass only the beamformed channel on to VAD -- it's all we need.
            self._audio_q.put((indata[:, 0].copy(), time.time()))

        try:
            with sd.InputStream(device=self.device_idx,
                                samplerate=SAMPLE_RATE,
                                channels=CHANNELS,
                                dtype='int16',
                                blocksize=BLOCK_SIZE,
                                callback=audio_cb):
                # Keep this thread alive while the audio stream runs.
                while not self.stop_flag.is_set():
                    time.sleep(0.25)
        except Exception as e:
            print(f"[capture] fatal: {e}", file=sys.stderr)

    def _vad_loop(self):
        """Turn the stream of audio blocks into discrete utterances using Silero VAD.

        Silero VAD operates on 512-sample frames (32ms at 16kHz) and returns a
        per-frame speech probability. We use a simple two-state machine:

          SILENCE: waiting for VAD_MIN_SPEECH_FRAMES consecutive speech frames.
                   When that triggers, we rewind VAD_PADDING_FRAMES_BEFORE
                   frames from the pre-speech ring buffer and start the
                   utterance there (so onsets are not clipped).

          SPEECH:  appending frames to the current utterance. When we see
                   VAD_MIN_SILENCE_FRAMES consecutive non-speech frames, we
                   close the utterance (keeping VAD_PADDING_FRAMES_AFTER of
                   trailing audio) and hand it to Whisper.

        If an utterance exceeds VAD_MAX_UTTERANCE_SEC we force-close it to
        avoid runaway captures.
        """
        try:
            import torch  # silero-vad is a TorchScript model
            from silero_vad import load_silero_vad
        except Exception as e:
            print(f"[vad] import failed ({e}); falling back to torch.hub",
                  file=sys.stderr)
            try:
                import torch
                model, _ = torch.hub.load(
                    repo_or_dir='snakers4/silero-vad',
                    model='silero_vad',
                    trust_repo=True,
                )
            except Exception as e2:
                print(f"[vad] fatal: could not load model: {e2}",
                      file=sys.stderr)
                return
        else:
            model = load_silero_vad()

        # Silero VAD models are single-thread. Serialize access via the GIL
        # plus this thread -- nothing else touches model.
        print(f"[vad] loaded silero-vad ({VAD_FRAME_SAMPLES} samples / "
              f"{VAD_FRAME_MS}ms frames)")

        # Rolling buffer of recent int16 frames for pre-speech padding.
        import collections
        pre_roll = collections.deque(maxlen=VAD_PADDING_FRAMES_BEFORE)
        # First timestamp of each frame in the pre-roll matches its index.
        pre_roll_ts = collections.deque(maxlen=VAD_PADDING_FRAMES_BEFORE)

        # Raw sample accumulator -- audio callback blocks don't land on clean
        # frame boundaries, so we concatenate then slice into 512-sample chunks.
        accum = np.zeros(0, dtype=np.int16)
        # Timestamp of the first sample currently in accum.
        accum_ts = None

        state = "silence"
        speech_run = 0
        silence_run = 0
        utt_frames = []          # list of int16 numpy arrays (512 each)
        utt_start_ts = None
        utt_last_speech_ts = None

        def finalize_utterance(reason):
            """Close the current utterance, trim trailing silence beyond the
            post-pad, and push to the whisper queue."""
            nonlocal utt_frames, utt_start_ts, utt_last_speech_ts
            nonlocal state, speech_run, silence_run
            if utt_frames and utt_start_ts is not None:
                # Trim trailing silence beyond the post-pad allowance.
                # silence_run counts how many trailing silence frames are in
                # utt_frames right now. Keep VAD_PADDING_FRAMES_AFTER of them.
                keep = max(0, len(utt_frames) - max(0, silence_run - VAD_PADDING_FRAMES_AFTER))
                frames_to_use = utt_frames[:keep] if keep > 0 else utt_frames
                if frames_to_use:
                    mono = np.concatenate(frames_to_use).astype(np.int16)
                    dur = len(mono) / float(SAMPLE_RATE)
                    end_ts = utt_start_ts + dur
                    print(f"[vad] utterance closed ({reason}): "
                          f"{dur:.2f}s, {len(frames_to_use)} frames")
                    if self.use_whisper:
                        self._whisper_q.put((mono, utt_start_ts, end_ts))
            utt_frames = []
            utt_start_ts = None
            utt_last_speech_ts = None
            state = "silence"
            speech_run = 0
            silence_run = 0

        max_utt_frames = int(VAD_MAX_UTTERANCE_SEC * SAMPLE_RATE // VAD_FRAME_SAMPLES)

        while not self.stop_flag.is_set():
            try:
                block, block_ts = self._audio_q.get(timeout=0.5)
            except queue.Empty:
                continue

            # Append new samples. block_ts is the time the audio callback fired
            # (end-of-block time); translate to start-of-block for better
            # per-frame timestamping.
            block_start_ts = block_ts - len(block) / float(SAMPLE_RATE)
            if accum.size == 0:
                accum_ts = block_start_ts
            accum = np.concatenate([accum, block]) if accum.size else block.copy()

            # Process every complete 512-sample frame currently in accum.
            while len(accum) >= VAD_FRAME_SAMPLES:
                frame_i16 = accum[:VAD_FRAME_SAMPLES]
                accum = accum[VAD_FRAME_SAMPLES:]
                frame_start_ts = accum_ts or time.time()
                accum_ts = (accum_ts + VAD_FRAME_SAMPLES / float(SAMPLE_RATE)
                            if accum_ts is not None else None)

                # Silero expects float32 in [-1, 1]
                frame_f32 = frame_i16.astype(np.float32) / 32768.0
                try:
                    prob = float(model(torch.from_numpy(frame_f32), SAMPLE_RATE).item())
                except Exception as e:
                    # Keep streaming even if VAD blips; log sparingly.
                    print(f"[vad] frame eval error: {e}", file=sys.stderr)
                    prob = 0.0

                is_speech = prob >= get_runtime_config()["vad_threshold"]

                if state == "silence":
                    # Maintain pre-roll of recent frames for onset padding.
                    pre_roll.append(frame_i16.copy())
                    pre_roll_ts.append(frame_start_ts)
                    if is_speech:
                        speech_run += 1
                        if speech_run >= VAD_MIN_SPEECH_FRAMES:
                            # Commit: open utterance with the pre-roll frames
                            # already buffered (these include the trigger run).
                            utt_frames = list(pre_roll)
                            utt_start_ts = (pre_roll_ts[0] if pre_roll_ts
                                            else frame_start_ts)
                            utt_last_speech_ts = frame_start_ts
                            state = "speech"
                            silence_run = 0
                            pre_roll.clear()
                            pre_roll_ts.clear()
                            print(f"[vad] utterance start @ {utt_start_ts:.3f} "
                                  f"(prob={prob:.2f})")
                    else:
                        speech_run = 0
                else:  # state == "speech"
                    utt_frames.append(frame_i16.copy())
                    if is_speech:
                        silence_run = 0
                        utt_last_speech_ts = frame_start_ts
                    else:
                        silence_run += 1
                        if silence_run >= VAD_MIN_SILENCE_FRAMES:
                            finalize_utterance("silence")
                            continue
                    # Hard cap on utterance length.
                    if len(utt_frames) >= max_utt_frames:
                        finalize_utterance("max-length")

    def _doa_loop(self):
        """Poll DOA every ~300ms, publish events."""
        while not self.stop_flag.is_set():
            time.sleep(0.3)
            try:
                angles = read_doa(self.usb_dev) if self.usb_dev else [0.0, 0.0, 0.0, 0.0]
                # Firmware's "auto" beam (slot 3) is the primary by definition.
                idx = AUTO_BEAM_IDX
                ts = time.time()
                with self._recent_lock:
                    self._recent_angles.append((ts, angles[idx]))
                    # keep last ~20s
                    cutoff = ts - 20.0
                    self._recent_angles = [(t, a) for (t, a) in self._recent_angles if t >= cutoff]
                with self._rms_lock:
                    rms = self._current_rms
                beams = {name: angles[i] for i, name in enumerate(BEAM_NAMES)}
                self.bus.publish({
                    "type": "doa",
                    "angles_deg": angles,
                    "beams": beams,
                    "strongest_idx": idx,
                    "rms": round(rms, 2),
                    "ts": ts,
                })
            except Exception as e:
                print(f"[doa] error: {e}", file=sys.stderr)

    def _whisper_worker(self):
        """Background thread: load Whisper lazily, transcribe VAD-segmented utterances."""
        print("[whisper] loading model... (first time may take a minute)")
        import mlx_whisper  # lazy
        # Warm up with a tiny silent buffer to prime the model
        tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        tmp.close()
        silent = np.zeros(SAMPLE_RATE // 2, dtype=np.int16)
        with wave.open(tmp.name, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(SAMPLE_RATE)
            wf.writeframes(silent.tobytes())
        try:
            _ = mlx_whisper.transcribe(tmp.name,
                                       path_or_hf_repo=WHISPER_MODEL,
                                       language='en',
                                       verbose=False)
            print("[whisper] model ready")
        except Exception as e:
            print(f"[whisper] warm-up failed: {e}", file=sys.stderr)
        finally:
            try:
                os.unlink(tmp.name)
            except Exception:
                pass

        while not self.stop_flag.is_set():
            try:
                mono, utt_start_ts, utt_end_ts = self._whisper_q.get(timeout=0.5)
            except queue.Empty:
                continue

            # No more RMS gate -- VAD has already decided this is speech.
            # Write to temp WAV (mlx_whisper takes a path)
            tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
            tmp.close()
            try:
                with wave.open(tmp.name, 'w') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(SAMPLE_RATE)
                    wf.writeframes(mono.tobytes())
                result = mlx_whisper.transcribe(tmp.name,
                                                path_or_hf_repo=WHISPER_MODEL,
                                                language='en',
                                                verbose=False)
                text = (result.get('text') or '').strip()
                if not text:
                    continue

                # Collect the full DOA trajectory across the utterance window.
                with self._recent_lock:
                    traj = [(t, a) for (t, a) in self._recent_angles
                            if utt_start_ts <= t <= utt_end_ts]

                if traj:
                    angles = [a for (_, a) in traj]
                    # Use the midpoint sample as the "primary" angle; trajectory
                    # is carried separately so the UI can judge the full path.
                    mid_idx = len(traj) // 2
                    angle = traj[mid_idx][1]
                    span = self._angular_span(angles)
                else:
                    angle = 0.0
                    span = 0.0

                overlap_suspected = bool(span > OVERLAP_TRAJECTORY_SPAN_DEG)

                speaker_id = self.clusterer.assign(angle)

                event = {
                    "type": "transcript",
                    "text": text,
                    "speaker_id": speaker_id,
                    "angle_deg": round(angle, 1),
                    "ts": utt_end_ts,
                    "start_ts": utt_start_ts,
                    "end_ts": utt_end_ts,
                    "duration_sec": round(utt_end_ts - utt_start_ts, 2),
                    "doa_trajectory": [[round(t, 3), round(a, 1)] for (t, a) in traj],
                    "doa_span_deg": round(span, 1),
                    "overlap_suspected": overlap_suspected,
                }
                self.bus.publish(event)
            except Exception as e:
                print(f"[whisper] transcribe error: {e}", file=sys.stderr)
            finally:
                try:
                    os.unlink(tmp.name)
                except Exception:
                    pass

    @staticmethod
    def _angular_span(angles):
        """Span of a set of angles in degrees, wrap-aware.
        Returns the smallest arc that contains all angles (0..180)."""
        if not angles:
            return 0.0
        # Convert to unit vectors, then find the arc covering all of them.
        sorted_angs = sorted(a % 360 for a in angles)
        # Gaps between neighbours (closing the wrap at the end).
        gaps = [sorted_angs[(i + 1) % len(sorted_angs)] - sorted_angs[i]
                for i in range(len(sorted_angs) - 1)]
        if len(sorted_angs) > 1:
            gaps.append(360.0 - sorted_angs[-1] + sorted_angs[0])
        if not gaps:
            return 0.0
        return 360.0 - max(gaps)

    def stop(self):
        self.stop_flag.set()


# ----------------------------------------------------------------------
# WebSocket server
# ----------------------------------------------------------------------

async def ws_handler(websocket, bus):
    q = asyncio.Queue()
    bus.subscribe(q)
    peer = getattr(websocket, 'remote_address', '?')
    print(f"[ws] client connected: {peer}")

    async def recv_loop():
        """Handle inbound messages from this client (config updates, etc.)."""
        try:
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("type") == "config":
                    updates = {}
                    if "rms_threshold" in msg:
                        updates["rms_threshold"] = msg["rms_threshold"]
                    if "min_beam_energy" in msg:
                        updates["min_beam_energy"] = msg["min_beam_energy"]
                    if "vad_threshold" in msg:
                        updates["vad_threshold"] = msg["vad_threshold"]
                    if updates:
                        new_cfg = update_runtime_config(**updates)
                        print(f"[config] updated via {peer}: {new_cfg}")
                        # Echo the new config back so all tabs sync up
                        bus.publish({"type": "config", **new_cfg, "ts": time.time()})
        except Exception:
            # disconnect -- send_loop will notice
            pass

    async def send_loop():
        # Send a hello so the client knows we're alive, with current config
        cfg = get_runtime_config()
        await websocket.send(json.dumps({
            "type": "hello",
            "ts": time.time(),
            **cfg,
        }))
        while True:
            event = await q.get()
            await websocket.send(json.dumps(event))

    try:
        await asyncio.gather(send_loop(), recv_loop())
    except Exception as e:
        # websockets raises ConnectionClosed on disconnect -- just log
        print(f"[ws] disconnect: {peer} ({e.__class__.__name__})")
    finally:
        bus.unsubscribe(q)


async def run_ws_server(bus, host, port):
    # websockets>=12 passes only the websocket to the handler
    async def _h(ws):
        await ws_handler(ws, bus)
    async with websockets.serve(_h, host, port):
        print(f"[ws] listening on ws://{host}:{port}")
        await asyncio.Future()  # run forever


# ----------------------------------------------------------------------
# HTTP server for static viz/
# ----------------------------------------------------------------------

def start_http_server(host, port):
    import http.server
    import socketserver

    os.chdir(VIZ_DIR)

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            # quiet the access log
            sys.stderr.write(f"[http] {self.address_string()} {fmt % args}\n")

    class ReusableTCPServer(socketserver.ThreadingTCPServer):
        allow_reuse_address = True

    httpd = ReusableTCPServer((host, port), Handler)

    def serve():
        print(f"[http] serving {VIZ_DIR} on http://{host}:{port}")
        httpd.serve_forever()

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return httpd


# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="pinna live server")
    parser.add_argument("--no-whisper", action="store_true", help="Disable transcription (DOA only)")
    parser.add_argument("--http-port", type=int, default=8080)
    parser.add_argument("--ws-port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    if not HAS_WS:
        print("ERROR: websockets not installed. pip install websockets", file=sys.stderr)
        sys.exit(1)
    if not HAS_SD:
        print("ERROR: sounddevice not installed. pip install sounddevice", file=sys.stderr)
        sys.exit(1)
    if not HAS_USB:
        print("ERROR: pyusb not installed. pip install pyusb", file=sys.stderr)
        sys.exit(1)

    dev_idx = find_respeaker_device()
    if dev_idx is None:
        print("ERROR: ReSpeaker XVF3800 audio device not found. "
              "Plug in the mic and retry.", file=sys.stderr)
        sys.exit(1)
    print(f"[mode] LIVE -- audio device: {sd.query_devices(dev_idx)['name']}")

    usb_dev = get_doa_device()
    if usb_dev is None:
        print("ERROR: ReSpeaker XVF3800 USB control interface not found. "
              "Run with sudo so pyusb can open the device.", file=sys.stderr)
        sys.exit(1)

    bus = EventBus()
    worker = LiveCapture(bus,
                         use_whisper=not args.no_whisper,
                         device_idx=dev_idx,
                         usb_dev=usb_dev)

    # Start HTTP
    httpd = start_http_server(args.host, args.http_port)

    # Start worker
    worker.start()

    # Run the WebSocket server on the main asyncio loop
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    bus.attach_loop(loop)

    try:
        loop.run_until_complete(run_ws_server(bus, args.host, args.ws_port))
    except KeyboardInterrupt:
        print("\n[main] shutting down...")
    finally:
        worker.stop()
        httpd.shutdown()
        loop.close()


if __name__ == "__main__":
    main()
