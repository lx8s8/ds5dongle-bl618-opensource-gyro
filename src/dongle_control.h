#pragma once
#include <stdint.h>

enum { DONGLE_CONFIG_CHANGED = 1, DONGLE_RESET = 2 };
/* Execute/publish only in usb_task; GET copies immutable ISR snapshots. */
void dongle_control_init(void);
void dongle_control_publish(void);
uint8_t dongle_control_command(uint8_t report_id, const uint8_t *data, uint16_t len);
uint16_t dongle_control_get(uint8_t report_id, uint8_t *out);
