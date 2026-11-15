#include "hid_mix.h"
#include "macro_engine.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint8_t blob[MACRO_MAX_BYTES], rules[MACRO_BINDING_BYTES];
static void p16(uint8_t *p, unsigned n) {
    p[0] = (uint8_t)n;
    p[1] = (uint8_t)(n >> 8);
}
static size_t program(unsigned mode, unsigned count) {
    memset(blob, 0, sizeof blob);
    blob[0] = 0x31;
    blob[1] = 0x43;
    blob[2] = 0x41;
    blob[3] = 0x4D;
    blob[4] = 1;
    blob[5] = (uint8_t)mode;
    blob[6] = 1;
    p16(blob + 10, count);
    memcpy(blob + 12, "test", 5);
    return 36 + count * 6 + 2;
}
static void event(unsigned i, unsigned act, unsigned key, unsigned edge, unsigned dt) {
    uint8_t *s = blob + 36 + i * 6;
    s[0] = act;
    s[1] = key;
    s[2] = edge;
    p16(s + 4, dt);
}
static void seal(size_t n) { p16(blob + n - 2, macro_crc16(blob, n - 2)); }
static void ready(macro_engine *e, uint32_t t) {
    uint8_t source;
    macro_engine_init(e);
    assert(macro_engine_input(e, 0, 0, t, &source) == -1);
}
static void validate_and_play(void) {
    macro_engine e;
    ready(&e, 0);
    size_t n = program(0, 4);
    event(0, 1, 224, 1, 5);
    event(1, 1, 4, 1, 5);
    event(2, 3, 1, 1, 5);
    event(3, 1, 4, 0, 5);
    seal(n);
    assert(macro_validate(blob, n));
    assert(macro_engine_start(&e, 0, 255, blob, n, 0));
    uint8_t keys[8];
    macro_engine_keyboard(&e, keys);
    assert(keys[0] == 1 && !keys[2]);
    macro_engine_tick(&e, 5, true);
    macro_engine_keyboard(&e, keys);
    assert(keys[0] == 1 && keys[2] == 4);
    macro_engine_tick(&e, 10, true);
    uint8_t p[63];
    memset(p, 0x45, 63);
    p[7] = 8;
    uint8_t before[63];
    memcpy(before, p, 63);
    macro_engine_apply(&e, p);
    assert(p[7] == 0x28);
    for (int i = 0; i < 63; i++)
        if (i != 7 && i != 8 && i != 9 && i != 4 && i != 5)
            assert(p[i] == before[i]);
    macro_engine_tick(&e, 15, true);
    macro_engine_tick(&e, 20, true);
    assert(!e.active && !e.pad);
    macro_engine_keyboard(&e, keys);
    for (int i = 0; i < 8; i++)
        assert(!keys[i]);
    blob[n - 1] ^= 1;
    assert(!macro_validate(blob, n));
    seal(n);
    blob[39] = 1;
    seal(n);
    assert(!macro_validate(blob, n));
    blob[39] = 0;
    seal(n);
    assert(!macro_validate(blob, n - 1));
    for (size_t i = 0; i < n; i++) {
        blob[i] ^= 128;
        assert(!macro_validate(blob, n));
        blob[i] ^= 128;
    }
}
static void bindings_and_loss(void) {
    macro_engine e;
    ready(&e, 100);
    memset(rules, 0, sizeof rules);
    rules[0] = 1;
    rules[7] = 1 | 2;
    p16(rules + 8, 30);
    p16(rules + 10, 100);
    assert(macro_engine_set_bindings(&e, rules, sizeof rules));
    {
        uint8_t source;
        macro_engine_input(&e, 0, e.profile, 100, &source);
    }
    uint8_t source = 255;
    assert(macro_engine_input(&e, 1, 0, 101, &source) == 0 && source == 0);
    assert(e.suppress == 1);
    size_t n = program(MACRO_HOLD, 1);
    event(0, 3, 1, 1, 10);
    seal(n);
    assert(macro_engine_start(&e, 0, source, blob, n, 101));
    assert(macro_engine_input(&e, 0, 0, 102, &source) == -1 && !e.active && !e.pad);
    assert(macro_engine_input(&e, 1, 0, 103, &source) == 0);
    assert(macro_engine_start(&e, 0, source, blob, n, 103));
    macro_engine_input(&e, 1, 1, 104, &source);
    assert(!e.active);
    assert(macro_engine_input(&e, 1, 1, 105, &source) == -1); /* no retrigger held after profile change */
    macro_engine_input(&e, 0, 1, 106, &source);
    assert(macro_engine_input(&e, 1, 1, 107, &source) == 0);
    assert(macro_engine_start(&e, 0, source, blob, n, 107));
    macro_engine_tick(&e, 208, true);
    assert(!e.active && !e.input_valid);
    macro_engine_input(&e, 1, 1, 209, &source);
    assert(!e.active);
    macro_engine_tick(&e, 210, false);
    assert(!e.input_valid);
}
static void gestures_toggle_wrap(void) {
    macro_engine e;
    uint8_t source;
    memset(rules, 0, sizeof rules);
    rules[0] = 2;
    rules[4] = 3;
    rules[5] = MACRO_LONG;
    rules[7] = 1;
    p16(rules + 8, 20);
    p16(rules + 10, 100);
    ready(&e, UINT32_MAX - 50);
    assert(macro_engine_set_bindings(&e, rules, sizeof rules));
    {
        uint8_t source;
        macro_engine_input(&e, 0, e.profile, UINT32_MAX - 50, &source);
    }
    assert(macro_engine_input(&e, 2, 0, UINT32_MAX - 10, &source) == -1);
    assert(macro_engine_input(&e, 2, 0, 10, &source) == 3);
    size_t n = program(MACRO_TOGGLE, 1);
    event(0, 2, 0, 1, 10);
    seal(n);
    assert(macro_engine_start(&e, 3, source, blob, n, 10));
    macro_engine_tick(&e, 20, true);
    assert(e.active && e.waiting);
    macro_engine_tick(&e, 21, true);
    assert(e.mouse_buttons == 1);
    assert(macro_engine_start(&e, 3, source, blob, n, 22));
    assert(!e.active && !e.mouse_buttons);
    rules[5] = MACRO_DOUBLE;
    assert(macro_engine_set_bindings(&e, rules, sizeof rules));
    {
        uint8_t source;
        macro_engine_input(&e, 0, e.profile, 100, &source);
    }
    macro_engine_input(&e, 0, 0, 23, &source);
    assert(macro_engine_input(&e, 2, 0, 24, &source) == -1);
    macro_engine_input(&e, 0, 0, 25, &source);
    assert(macro_engine_input(&e, 2, 0, 26, &source) == 3);
    rules[5] = MACRO_RELEASE;
    assert(macro_engine_set_bindings(&e, rules, sizeof rules));
    {
        uint8_t source;
        macro_engine_input(&e, 0, e.profile, 100, &source);
    }
    macro_engine_input(&e, 2, 0, 30, &source);
    assert(macro_engine_input(&e, 0, 0, 31, &source) == 3);
}
static void loops_and_rollover(void) {
    macro_engine e;
    ready(&e, UINT32_MAX - 5);
    size_t n = program(0, 1);
    event(0, 3, 2, 1, 10);
    blob[6] = 2;
    p16(blob + 8, 3);
    seal(n);
    assert(macro_engine_start(&e, 0, 255, blob, n, UINT32_MAX - 5));
    macro_engine_tick(&e, 4, true);
    assert(e.waiting && !e.pad);
    macro_engine_tick(&e, 8, true);
    assert(e.pad == 4);
    macro_engine_tick(&e, 18, true);
    assert(!e.active);
    ready(&e, 100);
    n = program(0, 8);
    for (int i = 0; i < 8; i++)
        event(i, 1, (unsigned)(4 + i), 1, 1);
    seal(n);
    assert(macro_engine_start(&e, 0, 255, blob, n, 100));
    for (int i = 1; i < 8; i++)
        macro_engine_tick(&e, 100 + i, true);
    uint8_t k[8];
    macro_engine_keyboard(&e, k);
    for (int i = 2; i < 8; i++)
        assert(k[i] == 1);
    macro_engine_stop(&e);
    macro_engine_keyboard(&e, k);
    for (int i = 0; i < 8; i++)
        assert(!k[i]);
}
static void mixer(void) {
    hid_mix_init();
    uint8_t out[9], a[8] = {1, 0, 4}, b[8] = {2, 0, 5};
    hid_mix_keyboard(a);
    hid_mix_macro(b, 1, 0);
    assert(hid_mix_peek(out) == 9 && out[0] == 1 && out[1] == 3 && out[3] == 4 && out[4] == 5);
    uint8_t again[9];
    assert(hid_mix_peek(again) == 9 && !memcmp(out, again, 9)); /* failed USB start does not consume */
    hid_mix_accept();
    assert(hid_mix_peek(out) == 5 && out[1] == 1);
    hid_mix_accept();
    memset(b, 0, 8);
    hid_mix_macro(b, 0, 0);
    assert(hid_mix_peek(out) == 9 && out[1] == 1 && out[3] == 4 && !out[4]);
    hid_mix_accept();
    assert(hid_mix_peek(out) == 5 && !out[1]);
    hid_mix_accept();
    hid_mix_mouse(0, 127, 0, 0);
    hid_mix_mouse(0, 127, 0, 0);
    assert(hid_mix_peek(out) == 5 && out[2] == 127);
    hid_mix_accept();
    assert(hid_mix_peek(out) == 5 && out[2] == 127);
    hid_mix_accept();
    assert(!hid_mix_peek(out));
    hid_mix_mouse(1, 100, 0, 0);
    hid_mix_tick(UINT32_MAX - 5);
    hid_mix_tick(15);
    assert(hid_mix_peek(out) == 5 && out[1] == 1 && out[2] == 0);
    hid_mix_accept();
    hid_mix_mouse(0, 0, 0, 0);
    assert(hid_mix_peek(out) == 5 && !out[1]);
    hid_mix_accept();
    hid_mix_consumer(1);
    assert(hid_mix_peek(out) == 2 && out[0] == 2 && out[1] == 1);
    hid_mix_accept();
    hid_mix_consumer(0);
    assert(hid_mix_peek(out) == 2 && !out[1]);
    hid_mix_accept();
}
int main(void) {
    validate_and_play();
    bindings_and_loss();
    gestures_toggle_wrap();
    loops_and_rollover();
    mixer();
    puts("macros: CRC, timing, gestures, wrap, cancellation, preserved sticks and HID source merging passed");
}
