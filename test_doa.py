#!/usr/bin/env python3
"""test_doa.py -- verify the correct DOA read protocol for XVF3800.

Based on Seeed's reference code at:
    https://github.com/respeaker/reSpeaker_XVF3800_USB_4MIC_ARRAY/tree/master/python_control

WHAT WAS WRONG BEFORE:
  - bmRequestType was 0x21 / 0xA1 (class/interface). CORRECT is
    CTRL_TYPE_VENDOR|CTRL_RECIPIENT_DEVICE -> 0x40 (OUT) / 0xC0 (IN).
  - cmdid for AEC_AZIMUTH_VALUES was 203. CORRECT value is 75. (The old
    README note was for a different firmware or a wrong copy.)
  - Old code did a SEPARATE write-then-read. The XMOS servicer protocol is
    a single IN transfer with wValue = (0x80 | cmdid), wIndex = resid.
  - Old code ignored the status byte. Status 64 = SERVICER_COMMAND_RETRY
    means "device busy, retry in ~10ms"; must loop until status 0.

CAVEATS on macOS:
  - NEVER call dev.reset() or dev.set_configuration(). CoreAudio has
    drivers attached to interfaces 0/1/2 (audio class). Resetting causes
    the whole device to fall off the bus and only physical unplug/replug
    recovers it. (Confirmed: happened once during this work.)
  - Never detach_kernel_driver() on the audio interfaces (0/1/2). Only the
    vendor-specific interface (#3, class 0xFF) is safe to touch.
  - Plain vendor control transfers on the default pipe do NOT disturb
    CoreAudio, so we don't even need to claim interface 3 in the normal case.

Usage:  sudo ./.venv/bin/python test_doa.py
"""

import math
import struct
import sys
import time

import usb.core
import usb.util

VID = 0x2886
PID = 0x001A

CONTROL_SUCCESS = 0
SERVICER_COMMAND_RETRY = 64

# Seeed / XMOS xvf_host parameter map -- (resid, cmdid, num_elements, type)
AEC_AZIMUTH_VALUES = (33, 75, 4, "radians")   # 4 floats (beam1, beam2, free, auto)
DOA_VALUE          = (20, 18, 2, "uint16")    # [doa_deg, ???]
VERSION            = (48, 0, 3, "uint8")      # major, minor, patch
AEC_SPENERGY_VALUES = (33, 80, 4, "float")    # speech energy per beam


def xmos_read(dev, resid, cmdid, num_elements, dtype, max_retries=50, timeout=500):
    """Single vendor IN control transfer to the XMOS servicer.
    Returns a list of decoded values (length num_elements)."""
    if dtype == "uint8":
        length = num_elements + 1
    elif dtype in ("float", "radians", "uint32", "int32"):
        length = num_elements * 4 + 1
    elif dtype == "uint16":
        length = num_elements * 2 + 1
    else:
        raise ValueError(f"unsupported dtype {dtype}")

    bmRequestType = (usb.util.CTRL_IN
                     | usb.util.CTRL_TYPE_VENDOR
                     | usb.util.CTRL_RECIPIENT_DEVICE)
    bRequest = 0
    wValue = 0x80 | cmdid
    wIndex = resid

    last_status = None
    for attempt in range(max_retries):
        response = dev.ctrl_transfer(bmRequestType, bRequest, wValue, wIndex,
                                     length, timeout)
        status = response[0]
        last_status = status
        if status == CONTROL_SUCCESS:
            payload = bytes(response[1:])
            return _decode(payload, num_elements, dtype)
        if status == SERVICER_COMMAND_RETRY:
            time.sleep(0.01)
            continue
        raise RuntimeError(f"unexpected status byte 0x{status:02X}")
    raise RuntimeError(f"too many retries (last_status={last_status})")


def _decode(payload, num_elements, dtype):
    if dtype == "uint8":
        return list(payload[:num_elements])
    if dtype in ("float", "radians"):
        return list(struct.unpack("<" + "f" * num_elements, payload[:num_elements * 4]))
    if dtype == "uint32":
        return list(struct.unpack("<" + "I" * num_elements, payload[:num_elements * 4]))
    if dtype == "int32":
        return list(struct.unpack("<" + "i" * num_elements, payload[:num_elements * 4]))
    if dtype == "uint16":
        return list(struct.unpack("<" + "H" * num_elements, payload[:num_elements * 2]))
    raise ValueError(dtype)


def main():
    dev = usb.core.find(idVendor=VID, idProduct=PID)
    if dev is None:
        print("ERROR: XVF3800 not found -- is it plugged in?", file=sys.stderr)
        sys.exit(1)
    print(f"Found XVF3800, bcdDevice=0x{dev.bcdDevice:04X}")

    # Sanity: firmware version (should not need any driver detach)
    try:
        v = xmos_read(dev, *VERSION)
        print(f"VERSION: {v[0]}.{v[1]}.{v[2]}")
    except usb.core.USBError as e:
        print(f"VERSION read failed ({e}); attempting to claim interface #3")
        if _claim_vendor_interface(dev):
            v = xmos_read(dev, *VERSION)
            print(f"VERSION after claim: {v[0]}.{v[1]}.{v[2]}")
        else:
            print("giving up")
            sys.exit(2)

    # DOA_VALUE (single auto-selected angle + flag)
    print("\n-- DOA_VALUE --")
    try:
        res = xmos_read(dev, *DOA_VALUE)
        print(f"DOA_VALUE: auto_deg={res[0]}  flag={res[1]}")
    except Exception as e:
        print(f"DOA_VALUE failed: {e}")

    # AEC_SPENERGY_VALUES -- per-beam speech energy (sanity check)
    print("\n-- AEC_SPENERGY_VALUES --")
    try:
        e = xmos_read(dev, *AEC_SPENERGY_VALUES)
        print(f"SPENERGY: {e}")
    except Exception as exc:
        print(f"SPENERGY failed: {exc}")

    # AEC_AZIMUTH_VALUES (4 beams in radians) -- the main event
    print("\n-- AEC_AZIMUTH_VALUES (40 iterations @ 300ms; clap/move to see changes) --")
    prev = None
    changes = 0
    errors = 0
    for i in range(40):
        try:
            rads = xmos_read(dev, *AEC_AZIMUTH_VALUES)
            degs = [round(math.degrees(r), 1) for r in rads]
            if prev is not None and any(abs(degs[j] - prev[j]) > 0.1 for j in range(4)):
                changes += 1
            prev = degs
            print(f"[{i:02d}] beam1={degs[0]:>6}  beam2={degs[1]:>6}  "
                  f"free={degs[2]:>6}  auto={degs[3]:>6}")
        except Exception as exc:
            errors += 1
            print(f"[{i:02d}] ERROR: {exc}")
        time.sleep(0.3)
    print(f"\nSummary: {changes}/39 frames changed, {errors} errors")


def _claim_vendor_interface(dev):
    """Find interface with bInterfaceClass=0xFF and claim it (detach kernel
    driver first if needed). Returns True on success."""
    try:
        cfg = dev.get_active_configuration()
    except usb.core.USBError as e:
        print(f"[claim] get_active_configuration failed: {e}")
        return False
    target = None
    for intf in cfg:
        if intf.bInterfaceClass == 0xFF:
            target = intf
            break
    if target is None:
        print("[claim] no vendor-specific interface (0xFF) found")
        return False
    num = target.bInterfaceNumber
    try:
        if dev.is_kernel_driver_active(num):
            dev.detach_kernel_driver(num)
            print(f"[claim] detached kernel driver from interface {num}")
    except (NotImplementedError, usb.core.USBError) as e:
        print(f"[claim] detach skipped: {e}")
    try:
        usb.util.claim_interface(dev, num)
        print(f"[claim] claimed interface {num}")
        return True
    except usb.core.USBError as e:
        print(f"[claim] claim failed: {e}")
        return False


if __name__ == "__main__":
    main()
