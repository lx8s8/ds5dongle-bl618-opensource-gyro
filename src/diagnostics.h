#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Task-owned counters, except queue counters (USB ISR, 32-bit atomic reads).
 * These measure the receiver, not Bluetooth radio loss or end-to-end latency. */
void diagnostics_init(void);
void diagnostics_input(uint32_t now_us);
void diagnostics_process(uint32_t elapsed_us);
void diagnostics_usb_busy(void);
void diagnostics_queue(bool accepted, uint8_t depth);
void diagnostics_save(uint32_t elapsed_us, bool success);
void diagnostics_get(uint8_t out[63]);
