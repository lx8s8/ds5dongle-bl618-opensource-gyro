"""Exercise the real USB sender with completion IRQs injected during copying."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'src/usb_gamepad.c').read_text()


def function(name):
    return re.search(
        rf'(?:static )?(?:void|int) {name}\([^;]*?\)\n\{{.*?\n\}}',
        source, re.S)[0]


program = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define DS5_USB_INPUT_PAYLOAD_LEN 63
#define DS5_USB_REPORT_ID_INPUT 1
#define USB_GAMEPAD_EP_IN 0x84
#define LOG_INF(...)
static bool usb_configured, ep_in_busy, pending_active, first_usb_send_logged;
static uint8_t usb_in_buf[64], pending_payload[63], transmitted[16][64];
static unsigned sends, copy_count, irq_copy, errors;
static bool irq_enabled = true, irq_pending;
static void hid_ep_in_handler(uint8_t busid, uint8_t ep, uint32_t nbytes);

static uintptr_t bflb_irq_save(void) {
    uintptr_t previous = irq_enabled;
    irq_enabled = false;
    return previous;
}
static void bflb_irq_restore(uintptr_t previous) {
    irq_enabled = previous;
    if (irq_enabled && irq_pending) {
        irq_pending = false;
        hid_ep_in_handler(0, USB_GAMEPAD_EP_IN, 64);
    }
}
static int usbd_ep_start_write(unsigned busid, unsigned ep, uint8_t *p, unsigned n) {
    (void)busid; (void)ep;
    assert(n == 64 && sends < 16);
    if (errors) { errors--; return -1; }
    memcpy(transmitted[sends++], p, n);
    return 0;
}
static void *interruptible_memcpy(void *dst, const void *src, size_t n) {
    unsigned this_copy = ++copy_count;
    for (size_t i = 0; i < n; i++) {
        ((uint8_t *)dst)[i] = ((const uint8_t *)src)[i];
        if (this_copy == irq_copy && i == n / 2) {
            irq_copy = 0;
            if (irq_enabled) hid_ep_in_handler(0, USB_GAMEPAD_EP_IN, 64);
            else irq_pending = true;
        }
    }
    return dst;
}
#undef memcpy
#define memcpy interruptible_memcpy
'''
program += '\n'.join(function(name) for name in (
    'try_send_pending', 'hid_ep_in_handler', 'usb_gamepad_send_raw_input'))
program += r'''
#undef memcpy
static void reset(void) {
    usb_configured = ep_in_busy = pending_active = first_usb_send_logged = false;
    sends = copy_count = irq_copy = errors = 0;
    irq_enabled = true; irq_pending = false;
    memset(usb_in_buf, 0, sizeof(usb_in_buf));
    memset(pending_payload, 0, sizeof(pending_payload));
}
static void assert_frame(unsigned i, uint8_t value) {
    assert(transmitted[i][0] == 1);
    for (unsigned j = 1; j < 64; j++) {
        if (transmitted[i][j] != value)
            fprintf(stderr, "torn USB frame %u at byte %u: %u != %u\n",
                    i, j, transmitted[i][j], value);
        assert(transmitted[i][j] == value);
    }
}
int main(void) {
    uint8_t a[63], b[63]; memset(a, 21, 63); memset(b, 231, 63);
    for (unsigned injection = 1; injection <= 2; injection++) {
        reset(); usb_configured = true;
        usb_gamepad_send_raw_input(a); assert(sends == 1); assert_frame(0, 21);
        /* Completion of the previous transfer interrupts publishing the next
         * frame (copy 1), or attempting to start an idle endpoint (copy 2). */
        copy_count = 0; irq_copy = injection;
        if (injection == 2) ep_in_busy = false;
        usb_gamepad_send_raw_input(b);
        assert(sends >= 2);
        for (unsigned i = 1; i < sends; i++) assert_frame(i, 231);
        assert(irq_enabled && !irq_pending);
    }
    reset(); usb_configured = true;
    usb_gamepad_send_raw_input(a);
    usb_gamepad_send_raw_input(b); assert(sends == 1);
    hid_ep_in_handler(0, USB_GAMEPAD_EP_IN, 64);
    assert(sends == 2); assert_frame(1, 231); /* latest wins, no stale FIFO */
    reset(); usb_gamepad_send_raw_input(a); assert(sends == 0);
    usb_configured = true; errors = 1;
    usb_gamepad_send_raw_input(b); assert(sends == 0 && !ep_in_busy);
    usb_gamepad_send_raw_input(b); assert(sends == 1); assert_frame(0, 231);
    /* Saving/restoring IRQ state must not enable an already masked caller. */
    irq_enabled = false; usb_gamepad_send_raw_input(a); assert(!irq_enabled);
    puts("USB input: completion interleavings, latest frame, retry, IRQ state passed");
}
'''
with tempfile.TemporaryDirectory(prefix='ds5-usb-input-') as directory:
    cfile, binary = Path(directory) / 'input.c', Path(directory) / 'input'
    cfile.write_text(program)
    flags = shlex.split(os.environ.get('CFLAGS', '-O1 -g'))
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + flags + [
        '-std=c11', str(cfile), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
