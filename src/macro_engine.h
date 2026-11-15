#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* MAC1 layout and single-player model adapted from NiceTimeJob/DS5DongleRE,
 * commit 6f5035d (GPL-3.0). See NOTICE. Decode explicitly: the original C
 * header is 36 bytes, despite its stale 40-byte comment. */
#define MACRO_SLOTS 16
#define MACRO_MAX_BYTES 4096
#define MACRO_MAX_STEPS 640
#define MACRO_HEADER_SIZE 36
#define MACRO_BINDINGS 16
#define MACRO_BINDING_SIZE 12
#define MACRO_BINDING_BYTES (MACRO_BINDINGS * MACRO_BINDING_SIZE)
enum { MACRO_ONCE, MACRO_HOLD, MACRO_TOGGLE };
enum { MACRO_PRESS, MACRO_RELEASE, MACRO_LONG, MACRO_DOUBLE, MACRO_TRIPLE };

typedef struct {
    bool down, fired, tapping;
    uint8_t taps;
    uint32_t since, last_tap;
} macro_key_state;
typedef struct {
    uint8_t program[MACRO_MAX_BYTES], bindings[MACRO_BINDING_BYTES];
    macro_key_state keys[MACRO_BINDINGS];
    uint8_t held_keys[32], mouse_buttons;
    int16_t wheel;
    uint64_t pad;
    uint32_t suppress, raw_buttons, next_ms, last_input_ms;
    uint16_t program_size, step, count, repeat_left;
    uint8_t slot, source, mode, profile;
    bool active, waiting, connected, input_valid;
} macro_engine;

uint16_t macro_crc16(const uint8_t *p, size_t n);
bool macro_validate(const uint8_t *p, size_t n);
bool macro_bindings_validate(const uint8_t *p, size_t n);
void macro_engine_init(macro_engine *e);
void macro_engine_stop(macro_engine *e);
bool macro_engine_set_bindings(macro_engine *e, const uint8_t *p, size_t n);
bool macro_engine_start(macro_engine *e, uint8_t slot, uint8_t source, const uint8_t *p, size_t n,
                        uint32_t now);
/* Called for a fresh physical input only. Return the first matching macro
 * request; a second request never interrupts an unrelated running macro. */
int macro_engine_input(macro_engine *e, uint32_t buttons, uint8_t profile, uint32_t now, uint8_t *source);
void macro_engine_tick(macro_engine *e, uint32_t now, bool connected);
void macro_engine_keyboard(const macro_engine *e, uint8_t report[8]);
void macro_engine_apply(const macro_engine *e, uint8_t payload[63]);
