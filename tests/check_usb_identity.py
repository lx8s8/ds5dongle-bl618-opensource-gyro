"""Compile actual device identity and mode-switch code for standard and Edge."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'src/usb_gamepad.c').read_text()
device = re.search(r'static uint8_t device_desc\[\] = \{.*?\n\};', source, re.S)[0]
mode = re.search(r'void usb_gamepad_set_dse_mode\(bool dse\)\n\{.*?\n\}', source, re.S)[0]
strings = re.search(r'static const char \*desc_string_cb\(.*?\n\{.*?\n\}', source, re.S)[0]
defines = '\n'.join(re.findall(
    r'^#define (?:DEVICE_DESC_PID_OFF|CONFIG_DESC_WDLEN_OFF|AUDIO_DESC_OFFSET|HID_SECTION_OFFSET|USB_AUDIO_DESC_SIZE|HID_REPORT_DESC_SIZE_DS|HID_REPORT_DESC_SIZE_DSE)\b.*$', source, re.M))
program = '''
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "usb_gamepad.h"
#include "ds5_protocol.h"
#define LOG_INF(...)
static bool current_dse_mode, serial_init;
static char serial_str[24];
static uint8_t config_desc[245];
static void bflb_efuse_get_chipid(uint8_t *p) { memset(p, 0, 8); }
'''+defines+'\n'+device+'\n'+strings+'\n'+mode+'''
int main(void) {
    assert(device_desc[8] == 0x4c && device_desc[9] == 0x05);
    assert(device_desc[10] == 0xe6 && device_desc[11] == 0x0c);
    for (unsigned edge = 0; edge < 2; edge++) {
        usb_gamepad_set_dse_mode(edge);
        assert((device_desc[10] | device_desc[11] << 8) == (edge ? 0x0df2 : 0x0ce6));
        assert(strcmp(desc_string_cb(0, 1), "Sony Interactive Entertainment") == 0);
        assert(strcmp(desc_string_cb(0, 2), edge ? "DualSense Edge Wireless Controller" : "DualSense Wireless Controller") == 0);
        unsigned length = config_desc[CONFIG_DESC_WDLEN_OFF] | config_desc[CONFIG_DESC_WDLEN_OFF + 1] << 8;
        assert(length == (edge ? 477 : 361));
    }
    puts("Sony identity: 054C:0CE6 / 054C:0DF2, names and mode-specific HID lengths passed");
}
'''
with tempfile.TemporaryDirectory(prefix='ds5-identity-') as directory:
    cfile, binary = Path(directory) / 'identity.c', Path(directory) / 'identity'
    cfile.write_text(program)
    for fs in (False, True):
        flags = ['-DFORCE_FS_MODE=1'] if fs else []
        subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + [
            '-std=c11', '-I', str(root / 'src'), *flags, str(cfile), '-o', str(binary)], check=True)
        subprocess.run([str(binary)], check=True)
