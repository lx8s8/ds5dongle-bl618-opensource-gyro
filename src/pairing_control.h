#pragma once
#include <stdbool.h>
#include <stdint.h>

/* USB task submits requests; Bluetooth task executes them. */
bool pairing_control_init(void);
bool pairing_control_submit(uint8_t command, uint8_t sequence, const uint8_t data[6]);
void pairing_control_poll(void);
void pairing_control_snapshot(uint8_t out[19]);
bool pairing_control_keep_usb(void);
