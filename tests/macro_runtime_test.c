#include "gyro.h"
#include "link_diag.h"
#include "macro_engine.h"
#include "macro_runtime.h"
#include "macro_storage.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint64_t time_us;
static bool fail_save;
static uint8_t files[16][4096], bindings[MACRO_BINDING_BYTES], keys[8], reply[63], last_pad[63];
static size_t sizes[16];
static unsigned saves;
uint64_t bflb_mtimer_get_time_us(void) { return time_us; }
void link_diag_snapshot(uint8_t *p) {
    memset(p, 0, LINK_DIAG_SIZE);
    memcpy(p, "BTL1", 4);
}
bool macro_storage_init(bool create) { return true; }
bool macro_storage_read(unsigned slot, uint8_t *p, size_t cap, size_t *n) {
    if (slot >= 16 || sizes[slot] > cap)
        return false;
    *n = sizes[slot];
    memcpy(p, files[slot], *n);
    return true;
}
bool macro_storage_write(unsigned slot, const uint8_t *p, size_t n) {
    if (fail_save)
        return false;
    memcpy(files[slot], p, n);
    sizes[slot] = n;
    saves++;
    return true;
}
bool macro_storage_delete(unsigned slot) {
    if (slot >= 16)
        return false;
    sizes[slot] = 0;
    return true;
}
bool macro_storage_bindings_read(uint8_t *p, size_t n) {
    memcpy(p, bindings, n);
    return true;
}
bool macro_storage_bindings_write(const uint8_t *p, size_t n) {
    if (fail_save)
        return false;
    memcpy(bindings, p, n);
    return true;
}
uint32_t macro_storage_free(void) { return 400000; }
void usb_gamepad_set_macro_report(const uint8_t *p, uint8_t buttons, int8_t wheel) { memcpy(keys, p, 8); }
int usb_gamepad_send_raw_input(const uint8_t *p) {
    memcpy(last_pad, p, 63);
    return 0;
}
static void put16(uint8_t *p, unsigned v) {
    p[0] = v;
    p[1] = v >> 8;
}
static void request(unsigned op, unsigned slot, unsigned offset, const uint8_t *p, unsigned n,
                    unsigned expected) {
    static uint8_t sequence;
    uint8_t r[63] = {0};
    r[0] = op;
    r[1] = ++sequence;
    r[2] = slot;
    put16(r + 3, offset);
    r[5] = n;
    if (n)
        memcpy(r + 6, p, n);
    macro_runtime_command(r, 63);
    macro_runtime_get(reply);
    assert(reply[0] == 1 && reply[1] == op && reply[2] == sequence && reply[3] == expected);
}
static void upload(const uint8_t *p, unsigned n) {
    request(2, 0, n, NULL, 0, 0);
    for (unsigned i = 0; i < n; i += 57) {
        unsigned count = n - i > 57 ? 57 : n - i;
        request(3, 0, i, p + i, count, 0);
    }
    request(4, 0, 0, NULL, 0, 0);
}
int main(void) {
    macro_runtime_init();
    request(0, 0, 0, NULL, 0, 0);
    assert(reply[20] == 16 && reply[21] == 16);
    uint8_t blob[50] = {0x31, 0x43, 0x41, 0x4D, 1, 0, 1};
    put16(blob + 10, 2);
    memcpy(blob + 12, "rpc", 4);
    blob[36] = 1;
    blob[37] = 4;
    blob[38] = 1;
    blob[40] = 20;
    blob[42] = 1;
    blob[43] = 4;
    blob[46] = 5;
    put16(blob + 48, macro_crc16(blob, 48));
    assert(macro_validate(blob, 50));
    request(2, 0, 50, NULL, 0, 0);
    request(3, 0, 1, blob, 49, 1);
    request(4, 0, 0, NULL, 0, 1);
    assert(!sizes[0]);
    upload(blob, 50);
    assert(sizes[0] == 50 && saves == 1);
    request(1, 0, 0, NULL, 0, 0);
    assert(reply[7] == 50 && !memcmp(reply + 12, blob, 50));
    fail_save = true;
    request(2, 0, 50, NULL, 0, 0);
    request(3, 0, 0, blob, 50, 0);
    request(4, 0, 0, NULL, 0, 2);
    assert(sizes[0] == 50 && saves == 1);
    fail_save = false;
    uint8_t raw[63] = {0}, out[63];
    raw[0] = 9;
    raw[1] = 19;
    raw[2] = 29;
    raw[3] = 39;
    raw[7] = 8;
    raw[32] = raw[36] = 128;
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 0);
    request(11, 0, 0, NULL, 0, 0);
    assert(keys[2] == 4);
    time_us = 20000;
    macro_runtime_poll(true, 20);
    assert(!keys[2]);
    request(12, 0, 0, NULL, 0, 0);
    uint8_t rules[192] = {0};
    rules[0] = 1;
    rules[7] = 1;
    request(8, 0, 192, NULL, 0, 0);
    for (unsigned i = 0; i < 192; i += 57)
        request(9, 0, i, rules + i, 192 - i > 57 ? 57 : 192 - i, 0);
    request(10, 0, 0, NULL, 0, 0);
    assert(!memcmp(bindings, rules, 192));
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 20);
    raw[7] = 0x18;
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 21);
    assert(keys[2] == 4 && out[0] == 9 && out[1] == 19 && out[2] == 29 && out[3] == 39);
    macro_runtime_poll(false, 22);
    for (int i = 0; i < 8; i++)
        assert(!keys[i]);
    request(15, 0, 1, NULL, 0, 0);
    raw[7] = 8;
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 23);
    raw[7] = 0x18;
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 24);
    assert(!keys[2]);
    request(20, 0, 0, NULL, 0, 0);
    assert(reply[10] == 126 && reply[12] == 9);
    raw[0] = 99;
    memcpy(out, raw, 63);
    macro_runtime_process(raw, out, true, 0, 25);
    request(20, 0, 51, NULL, 0, 0);
    assert(reply[12 + 12] == 9); /* frozen output half belongs to old snapshot */
    request(21, 0, 0, NULL, 0, 0);
    assert(!memcmp(reply + 12, "BTL1", 4));
    request(2, 0, 50, NULL, 0, 0);
    blob[38] = 5;
    request(3, 0, 0, blob, 50, 0);
    request(4, 0, 0, NULL, 0, 1);
    assert(files[0][38] == 1);
    puts("macro RPC: sequential upload, corruption/save failure, old-file retention, physical input, "
         "playback, recording pause and coherent diagnostics passed");
}
