#pragma once
#include <stdbool.h>
#include <stdint.h>
#define MACRO_REPORT_ID 0xF3
void macro_runtime_init(void);
void macro_runtime_poll(bool connected, uint32_t now_ms);
void macro_runtime_process(const uint8_t raw[63], uint8_t out[63], bool edge, uint8_t profile,
                           uint32_t now_ms);
void macro_runtime_command(const uint8_t *p, uint16_t n);
void macro_runtime_get(uint8_t out[63]);
