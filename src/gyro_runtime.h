#pragma once

#include "gyro.h"

/* Platform adapter. All mutations run in usb_task, except init before tasks.
 * The two GET functions only copy published buffers and are safe in USB ISR. */
void gyro_runtime_init(void);
void gyro_runtime_on_disconnect(void);
void gyro_runtime_poll(bool connected, uint32_t now_us);
void gyro_runtime_process(const uint8_t *raw, uint8_t *output,
                          uint32_t now_us, bool edge);
void gyro_runtime_command(const uint8_t *data, uint16_t len);
void gyro_runtime_get_config(uint8_t out[GYRO_REPORT_SIZE]);
void gyro_runtime_get_status(uint8_t out[GYRO_REPORT_SIZE]);
