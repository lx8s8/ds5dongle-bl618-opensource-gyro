#!/usr/bin/env python3
"""Fail closed before publishing a manager using pid.codes' test IDs."""
import re
from pathlib import Path


def check_identity(source):
    descriptors = re.findall(r"USB_DEVICE_DESCRIPTOR_INIT\s*\(([^()]*)\)", source)
    if len(descriptors) != 1:
        raise ValueError("Expected one literal boot manager USB descriptor")
    fields = [field.strip() for field in descriptors[0].split(",")]
    if len(fields) != 8:
        raise ValueError("Unexpected boot manager USB descriptor")
    try:
        vid, pid = int(fields[4], 0), int(fields[5], 0)
    except ValueError as exc:
        raise ValueError("Boot manager VID and PID must be literal integers") from exc
    if not 0 < vid <= 0xffff or not 0 < pid <= 0xffff:
        raise ValueError("Invalid boot manager VID or PID")
    if vid == 0x1209 and 1 <= pid <= 0x10:
        raise ValueError("pid.codes test PID is restricted to private testing")


if __name__ == "__main__":
    check_identity((Path(__file__).resolve().parent.parent / "boot/manager/usb_manager.c").read_text())
    print("Manager identity is not a pid.codes private test ID; confirm allocation separately.")
