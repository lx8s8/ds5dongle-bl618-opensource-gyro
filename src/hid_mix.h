#pragma once
#include <stdbool.h>
#include <stdint.h>
/* Task-owned persistent states. USB adapter guards peek/accept with IRQ save. */
void hid_mix_init(void);
void hid_mix_resend(void);
void hid_mix_tick(uint32_t now_ms);
void hid_mix_keyboard(const uint8_t report[8]);
void hid_mix_consumer(uint8_t bits);
void hid_mix_mouse(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel);
void hid_mix_macro(const uint8_t keyboard[8], uint8_t buttons, int8_t wheel);
unsigned hid_mix_peek(uint8_t out[9]);
void hid_mix_accept(void);
