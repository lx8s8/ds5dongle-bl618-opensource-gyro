"""Parse actual HID descriptors: verify byte lengths and advertised gyro reports."""
import pathlib
import re
import os
import shlex
import subprocess
import tempfile

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
    assert reports[0xF3] == reports[0xFA] == reports[0xFE] == reports[0xFC] == reports[0xFD] == 63 * 8
    print(f'{suffix}: {len(data)} descriptor bytes, gyro feature reports 63 bytes each')

# Compile the real configuration initializer and polling-rate function, without
# the SDK. Parse descriptor boundaries instead of assuming writable offsets.
# Gamepad OUT uses EP0; a second interrupt endpoint would overlap interface 4.
names = ('USBD_MAX_POWER', 'USB_KBD_DESC_SIZE', 'USB_HID_ONLY_SIZE',
         'USB_AUDIO_DESC_SIZE', 'USB_HID_CONFIG_SIZE',
         'HID_REPORT_DESC_SIZE_DS', 'KBD_REPORT_DESC_SIZE',
         'AUDIO_DESC_OFFSET', 'HID_SECTION_OFFSET',
         'BINTERVAL_GAMEPAD_EP_IN_OFF', 'BINTERVAL_GAMEPAD_EP_OUT_OFF')
defines = '\n'.join(re.findall(
    rf'^#define (?:{"|".join(names)})\b.*$', source, re.M))
array = re.search(r'static uint8_t config_desc\[.*?\] = \{.*?\n\};', source, re.S)[0]
polling = re.search(r'void usb_gamepad_set_polling_rate\(uint8_t mode\)\n\{.*?\n\}', source, re.S)[0]
program = '#include <stdio.h>\n#include "usb_gamepad.h"\n#define LOG_INF(...)\n'
program += defines + '\n' + array + '\n' + polling + '''
int main(void) {
    fwrite(config_desc, 1, sizeof(config_desc), stdout);
    for (unsigned mode = 0; mode < 3; mode++) {
        usb_gamepad_set_polling_rate(mode);
        fwrite(config_desc, 1, sizeof(config_desc), stdout);
    }
    return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='ds5-usb-descriptors-') as directory:
    cfile = pathlib.Path(directory) / 'descriptors.c'
    binary = pathlib.Path(directory) / 'descriptors'
    cfile.write_text(program)
    for fs in (False, True):
        args = shlex.split(os.environ.get('CC', 'cc')) + ['-std=gnu11', '-I',
                str(pathlib.Path(__file__).resolve().parents[1] / 'src')]
        if fs:
            args += ['-DFORCE_FS_MODE=1']
        subprocess.run(args + [str(cfile), '-o', str(binary)], check=True)
        output = subprocess.check_output([str(binary)])
        size = int.from_bytes(output[2:4], 'little')
        assert len(output) == size * 4
        initial = output[:size]
        offset = 9 + 186  # Audio descriptors are injected separately at init.
        descriptors = []
        while offset < size:
            length = initial[offset]
            assert length >= 2 and offset + length <= size
            descriptors.append((offset, initial[offset:offset + length]))
            offset += length
        assert offset == size
        assert [d[1] for _, d in descriptors] == [4, 0x21, 5, 4, 0x21, 5]
        _, gamepad = descriptors[0]
        assert gamepad[2] == 3 and gamepad[4:8] == bytes([1, 3, 0, 0])
        _, keyboard = descriptors[3]
        assert keyboard[2] == 4 and keyboard[4:8] == bytes([1, 3, 0, 0])
        _, hid = descriptors[4]
        assert hid[5:7] == bytes([1, 0x22]), 'keyboard HID must advertise one report descriptor'
        assert int.from_bytes(hid[7:9], 'little') == 138
        gamepad_ep, endpoint = descriptors[2]
        assert endpoint[2:4] == bytes([0x84, 3])
        _, mouse_ep = descriptors[5]
        assert mouse_ep[2:4] == bytes([0x83, 3])
        for mode, interval in enumerate((2, 1, 1) if fs else (5, 4, 3)):
            expected = bytearray(initial)
            expected[gamepad_ep + 6] = interval
            actual = output[size * (mode + 1):size * (mode + 2)]
            assert actual == expected, 'polling rate changed bytes outside gamepad IN bInterval'
        print(f'{"FS" if fs else "HS"}: composite HID and all polling modes preserve descriptor boundaries')
