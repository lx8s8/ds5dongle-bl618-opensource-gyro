"""Parse actual HID descriptors: verify byte lengths and advertised gyro reports."""
import pathlib
import re

source = (pathlib.Path(__file__).resolve().parents[1] / 'src/usb_gamepad.c').read_text()
for suffix in ('ds', 'dse'):
    match = re.search(rf'hid_report_desc_{suffix}\[.*?\] = \{{(.*?)\n\}};', source, re.S)
    body = re.sub(r'/\*.*?\*/', '', match[1], flags=re.S)
    data = bytes(int(n, 16) for n in re.findall(r'0x([0-9A-Fa-f]+)', body))
    declared = int(re.search(rf'#define HID_REPORT_DESC_SIZE_{suffix.upper()}\s+(\d+)', source)[1])
    assert len(data) == declared, (suffix, len(data), declared)
    offset, report, size, count = 0, None, None, None
    reports = {}
    while offset < len(data):
        item = data[offset]
        length = (0, 1, 2, 4)[item & 3]
        value = int.from_bytes(data[offset + 1:offset + 1 + length], 'little')
        tag = item & 0xFC
        if tag == 0x84: report = value
        elif tag == 0x74: size = value
        elif tag == 0x94: count = value
        elif tag == 0xB0: reports[report] = reports.get(report, 0) + size * count
        offset += length + 1
    assert reports[0xFA] == reports[0xFE] == reports[0xFC] == reports[0xFD] == 63 * 8
    print(f'{suffix}: {len(data)} descriptor bytes, gyro feature reports 63 bytes each')
