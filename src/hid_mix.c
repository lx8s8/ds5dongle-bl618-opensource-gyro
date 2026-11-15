#include "hid_mix.h"
#include <string.h>
static uint8_t base[8], macro[8], mouse_base, mouse_macro, consumer;
static bool dirty[3];
static int32_t movement[3];
static uint8_t selected, cursor;
static int8_t sent[3];
static bool movement_clock;
static uint32_t movement_since;
void hid_mix_tick(uint32_t now) {
    if (!movement[0] && !movement[1] && !movement[2]) {
        movement_clock = false;
        return;
    }
    if (!movement_clock) {
        movement_clock = true;
        movement_since = now;
    } else if (now - movement_since >= 20) {
        /* Relative motion expires; button release states never expire. A
         * host that pauses this endpoint must not receive seconds of motion. */
        memset(movement, 0, sizeof movement);
        movement_clock = false;
    }
}
void hid_mix_resend(void) { dirty[0] = dirty[1] = dirty[2] = true; }
void hid_mix_init(void) {
    memset(base, 0, 8);
    memset(macro, 0, 8);
    memset(dirty, 0, sizeof dirty);
    memset(movement, 0, sizeof movement);
    mouse_base = mouse_macro = consumer = selected = cursor = 0;
    movement_clock = false;
}
void hid_mix_keyboard(const uint8_t p[8]) {
    if (memcmp(base, p, 8)) {
        memcpy(base, p, 8);
        dirty[0] = true;
    }
}
void hid_mix_consumer(uint8_t bits) {
    if (bits != consumer) {
        consumer = bits;
        dirty[1] = true;
    }
}
static void add(unsigned i, int n) {
    int32_t v = movement[i] + n;
    movement[i] = v > 32767 ? 32767 : v < -32767 ? -32767 : v;
    if (n)
        dirty[2] = true;
}
void hid_mix_mouse(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel) {
    if (mouse_base != buttons)
        dirty[2] = true;
    mouse_base = buttons;
    add(0, dx);
    add(1, dy);
    add(2, wheel);
}
void hid_mix_macro(const uint8_t p[8], uint8_t buttons, int8_t wheel) {
    if (memcmp(macro, p, 8)) {
        memcpy(macro, p, 8);
        dirty[0] = true;
    }
    if (mouse_macro != buttons)
        dirty[2] = true;
    mouse_macro = buttons;
    add(2, wheel);
}
unsigned hid_mix_peek(uint8_t out[9]) {
    for (unsigned n = 0; n < 3; n++) {
        unsigned i = (cursor + n) % 3;
        if (!dirty[i])
            continue;
        selected = (uint8_t)i;
        memset(out, 0, 9);
        out[0] = (uint8_t)(i + 1);
        if (i == 0) {
            out[1] = base[0] | macro[0];
            unsigned count = 0;
            bool overflow = false;
            for (unsigned s = 0; s < 2; s++)
                for (unsigned k = 2; k < 8; k++) {
                    uint8_t key = (s ? macro : base)[k];
                    if (!key)
                        continue;
                    if (key == 1) {
                        overflow = true;
                        continue;
                    }
                    bool duplicate = false;
                    for (unsigned j = 0; j < count; j++)
                        if (out[3 + j] == key)
                            duplicate = true;
                    if (!duplicate) {
                        if (count < 6)
                            out[3 + count++] = key;
                        else
                            overflow = true;
                    }
                }
            if (overflow)
                memset(out + 3, 1, 6);
            return 9;
        }
        if (i == 1) {
            out[1] = consumer;
            return 2;
        }
        out[1] = mouse_base | mouse_macro;
        for (unsigned j = 0; j < 3; j++) {
            sent[j] = (int8_t)(movement[j] > 127 ? 127 : movement[j] < -127 ? -127 : movement[j]);
            out[2 + j] = (uint8_t)sent[j];
        }
        return 5;
    }
    return 0;
}
void hid_mix_accept(void) {
    dirty[selected] = false;
    cursor = (uint8_t)((selected + 1) % 3);
    if (selected == 2)
        for (unsigned i = 0; i < 3; i++) {
            movement[i] -= sent[i];
            if (movement[i])
                dirty[2] = true;
        }
}
