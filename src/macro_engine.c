#include "macro_engine.h"
#include <string.h>

static uint16_t get16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static uint32_t get32(const uint8_t *p) { return get16(p) | ((uint32_t)get16(p + 2) << 16); }
static bool due(uint32_t now, uint32_t deadline) { return (int32_t)(now - deadline) >= 0; }
uint16_t macro_crc16(const uint8_t *p, size_t n) {
    uint16_t c = 0xFFFF;
    while (n--) {
        c ^= (uint16_t)*p++ << 8;
        for (int i = 0; i < 8; i++)
            c = (uint16_t)((c << 1) ^ (c & 0x8000 ? 0x1021 : 0));
    }
    return c;
}
bool macro_validate(const uint8_t *p, size_t n) {
    if (!p || n < MACRO_HEADER_SIZE + 2 || n > MACRO_MAX_BYTES || get32(p) != 0x4D414331u || p[4] != 1 ||
        p[5] > MACRO_TOGGLE || p[7] || get16(p + 10) > MACRO_MAX_STEPS ||
        n != MACRO_HEADER_SIZE + (size_t)get16(p + 10) * 6 + 2 || macro_crc16(p, n - 2) != get16(p + n - 2) ||
        !memchr(p + 12, 0, 24))
        return false;
    for (unsigned i = 0; i < get16(p + 10); i++) {
        const uint8_t *s = p + MACRO_HEADER_SIZE + i * 6;
        if (s[0] > 3 || s[2] > 1 || s[3] || (s[0] == 1 && !s[1]) || (s[0] == 2 && s[1] > 4) ||
            (s[0] == 3 && s[1] > 18 && (s[1] < 31 || s[1] > 34)))
            return false;
    }
    return true;
}
bool macro_bindings_validate(const uint8_t *p, size_t n) {
    if (!p || n != MACRO_BINDING_BYTES)
        return false;
    for (int i = 0; i < MACRO_BINDINGS; i++) {
        const uint8_t *b = p + i * MACRO_BINDING_SIZE;
        if (get32(b) & ~0xFFFFFFu || b[4] >= MACRO_SLOTS || b[5] > MACRO_TRIPLE || b[6] > 15 || b[7] > 3 ||
            get16(b + 8) > 3000 || get16(b + 10) > 1000)
            return false;
        if ((b[7] & 1) &&
            (!get32(b) || (b[5] == MACRO_LONG && !get16(b + 8)) || (b[5] >= MACRO_DOUBLE && !get16(b + 10))))
            return false;
    }
    return true;
}
static void clear_outputs(macro_engine *e) {
    memset(e->held_keys, 0, sizeof(e->held_keys));
    e->pad = 0;
    e->mouse_buttons = 0;
    e->wheel = 0;
}
void macro_engine_init(macro_engine *e) {
    memset(e, 0, sizeof(*e));
    e->slot = e->source = e->profile = 255;
}
void macro_engine_stop(macro_engine *e) {
    e->active = e->waiting = false;
    e->slot = e->source = 255;
    clear_outputs(e);
}
bool macro_engine_set_bindings(macro_engine *e, const uint8_t *p, size_t n) {
    if (!macro_bindings_validate(p, n))
        return false;
    macro_engine_stop(e);
    memcpy(e->bindings, p, n);
    memset(e->keys, 0, sizeof(e->keys));
    e->input_valid = false;
    e->suppress = 0;
    return true;
}
static void step(macro_engine *e, unsigned index) {
    const uint8_t *s = e->program + MACRO_HEADER_SIZE + index * 6;
    switch (s[0]) {
    case 1:
        if (s[2])
            e->held_keys[s[1] / 8] |= (uint8_t)(1u << (s[1] % 8));
        else
            e->held_keys[s[1] / 8] &= (uint8_t)~(1u << (s[1] % 8));
        break;
    case 2:
        if (s[1] < 3) {
            if (s[2])
                e->mouse_buttons |= (uint8_t)(1u << s[1]);
            else
                e->mouse_buttons &= (uint8_t)~(1u << s[1]);
        } else if (s[2] && e->wheel < 127 && e->wheel > -127)
            e->wheel += s[1] == 3 ? 1 : -1;
        break;
    case 3:
        if (s[2])
            e->pad |= (uint64_t)1 << s[1];
        else
            e->pad &= ~((uint64_t)1 << s[1]);
        break;
    default:
        break; /* END is a timed no-op, compatible with DS5DongleRE. */
    }
}
bool macro_engine_start(macro_engine *e, uint8_t slot, uint8_t source, const uint8_t *p, size_t n,
                        uint32_t now) {
    if (!e->connected || !e->input_valid || now - e->last_input_ms > 100 || slot >= MACRO_SLOTS ||
        (source >= MACRO_BINDINGS && source != 255) || !macro_validate(p, n))
        return false;
    if (e->active) {
        if (e->slot == slot && e->mode == MACRO_TOGGLE) {
            macro_engine_stop(e);
            return true;
        }
        return false;
    }
    if (!get16(p + 10))
        return false;
    /* Unbound test playback is once-only, never an orphaned hold loop. */
    if ((source == 255 && p[5] != MACRO_ONCE) || (p[5] == MACRO_HOLD && !e->keys[source].down))
        return false;
    memcpy(e->program, p, n);
    e->program_size = (uint16_t)n;
    e->count = get16(p + 10);
    e->active = true;
    e->waiting = false;
    e->slot = slot;
    e->source = source;
    e->mode = p[5];
    e->repeat_left = p[6] ? p[6] : 1;
    clear_outputs(e);
    step(e, 0);
    e->step = 1;
    e->next_ms = now + (get16(p + MACRO_HEADER_SIZE + 4) ? get16(p + MACRO_HEADER_SIZE + 4) : 1);
    return true;
}
int macro_engine_input(macro_engine *e, uint32_t buttons, uint8_t profile, uint32_t now, uint8_t *source) {
    bool changed = !e->input_valid || e->profile != profile;
    if (changed) {
        macro_engine_stop(e);
        memset(e->keys, 0, sizeof(e->keys));
    }
    e->profile = profile;
    e->connected = e->input_valid = true;
    e->raw_buttons = buttons;
    e->last_input_ms = now;
    e->suppress = 0;
    int result = -1;
    for (int i = 0; i < MACRO_BINDINGS; i++) {
        const uint8_t *b = e->bindings + i * MACRO_BINDING_SIZE;
        macro_key_state *k = &e->keys[i];
        bool enabled = (b[7] & 1) && (!b[6] || (profile < 4 && (b[6] & (1u << profile))));
        uint32_t mask = get32(b);
        bool down = enabled && (buttons & mask) == mask;
        if (enabled && (b[7] & 2))
            e->suppress |= mask;
        /* Reconnect/profile changes require release before re-arming. */
        if (changed && down) {
            k->down = k->fired = true;
            k->since = now;
            continue;
        }
        bool fire = false;
        if (down && !k->down) {
            k->since = now;
            k->fired = false;
            if (!k->tapping || now - k->last_tap > get16(b + 10))
                k->taps = 0;
            k->last_tap = now;
            k->tapping = true;
            k->taps++;
            fire = b[5] == MACRO_PRESS || (b[5] == MACRO_DOUBLE && k->taps == 2) ||
                   (b[5] == MACRO_TRIPLE && k->taps == 3);
            if (fire && b[5] >= MACRO_DOUBLE)
                k->taps = 0;
        }
        if (down && !k->fired && b[5] == MACRO_LONG && now - k->since >= get16(b + 8)) {
            fire = true;
            k->fired = true;
        }
        if (!down && k->down && b[5] == MACRO_RELEASE && enabled && !k->fired)
            fire = true;
        if (!down)
            k->fired = false;
        k->down = down;
        if (fire && result < 0) {
            result = b[4];
            *source = (uint8_t)i;
        }
    }
    if (e->active && e->mode == MACRO_HOLD && (e->source >= MACRO_BINDINGS || !e->keys[e->source].down))
        macro_engine_stop(e);
    return result;
}
void macro_engine_tick(macro_engine *e, uint32_t now, bool connected) {
    e->connected = connected;
    if (!connected || !e->input_valid || now - e->last_input_ms > 100) {
        macro_engine_stop(e);
        e->input_valid = false;
        e->suppress = 0;
        return;
    }
    if (!e->active || !due(now, e->next_ms))
        return;
    /* One timed edge per USB-task turn: a stalled task must not compress a
     * key-down and key-up into an invisible zero-length pulse. */
    if (e->waiting) {
        e->waiting = false;
        e->step = 0;
    }
    if (e->step < e->count) {
        unsigned i = e->step++;
        step(e, i);
        uint16_t dt = get16(e->program + MACRO_HEADER_SIZE + i * 6 + 4);
        e->next_ms = now + (dt ? dt : 1);
        return;
    }
    clear_outputs(e);
    if (e->mode != MACRO_ONCE || e->repeat_left > 1) {
        if (e->mode == MACRO_ONCE)
            e->repeat_left--;
        e->waiting = true;
        e->next_ms = now + (uint32_t)get16(e->program + 8) + 1;
    } else
        macro_engine_stop(e);
}
void macro_engine_keyboard(const macro_engine *e, uint8_t out[8]) {
    memset(out, 0, 8);
    int n = 2;
    for (int k = 224; k <= 231; k++)
        if (e->held_keys[k / 8] & (1u << (k % 8)))
            out[0] |= (uint8_t)(1u << (k - 224));
    for (int k = 1; k < 256; k++) {
        if (k >= 224 && k <= 231)
            continue;
        if (e->held_keys[k / 8] & (1u << (k % 8))) {
            if (n < 8)
                out[n++] = (uint8_t)k;
            else {
                memset(out + 2, 1, 6);
                break;
            }
        }
    }
}
void macro_engine_apply(const macro_engine *e, uint8_t p[63]) {
    uint64_t b = e->pad;
    p[7] |= (uint8_t)((b & 15) << 4);
    p[8] |= (uint8_t)((b >> 4) & 255);
    p[9] |= (uint8_t)(((b >> 12) & 7) | (((b >> 31) & 15) << 4));
    if (b & (1u << 6))
        p[4] = 255;
    if (b & (1u << 7))
        p[5] = 255;
    int x = 0, y = 0;
    uint8_t h = p[7] & 15;
    if (h < 8) {
        static const int8_t xs[] = {0, 1, 1, 1, 0, -1, -1, -1}, ys[] = {-1, -1, 0, 1, 1, 1, 0, -1};
        x = xs[h];
        y = ys[h];
    }
    if (b & (1u << 15))
        y--;
    if (b & (1u << 16))
        y++;
    if (b & (1u << 17))
        x--;
    if (b & (1u << 18))
        x++;
    if (b & (15u << 15)) {
        x = (x > 0) - (x < 0);
        y = (y > 0) - (y < 0);
        static const uint8_t hats[] = {7, 0, 1, 6, 8, 2, 5, 4, 3};
        p[7] = (p[7] & 0xF0) | hats[(y + 1) * 3 + x + 1];
    }
}
