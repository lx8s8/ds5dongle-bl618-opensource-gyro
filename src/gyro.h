#pragma once

#include <stdbool.h>
#include <stdint.h>

#define GYRO_CONFIG_VERSION 2
#define GYRO_CONFIG_SIZE 40
#define GYRO_REPORT_SIZE 63
#define GYRO_REPORT_CONFIG 0xFC
#define GYRO_REPORT_STATUS 0xFD
#define GYRO_REPORT_PROFILES 0xFA
#define GYRO_REPORT_DIAGNOSTICS 0xFE

enum { GYRO_OFF, GYRO_MOUSE, GYRO_RIGHT_STICK };
enum { GYRO_ALWAYS, GYRO_HOLD, GYRO_TOGGLE, GYRO_HOLD_OFF };
enum { GYRO_AXIS_YAW, GYRO_AXIS_ROLL, GYRO_AXIS_PLAYER_SPACE };
enum { GYRO_INVERT_X = 1, GYRO_INVERT_Y = 2, GYRO_SUPPRESS = 4,
       GYRO_REQUIRE_ALL = 8, GYRO_AUTO_BIAS = 16, GYRO_ADAPTIVE_SMOOTH = 32,
       GYRO_FIRE_BIAS = 64 };
enum { GYRO_STATUS_CONNECTED = 1, GYRO_STATUS_ACTIVE = 2,
       GYRO_STATUS_CALIBRATING = 4, GYRO_STATUS_CALIBRATED = 8,
       GYRO_STATUS_FACTORY = 16, GYRO_STATUS_CAL_FAILED = 32,
       GYRO_STATUS_STILL = 64, GYRO_STATUS_AUTO_BIAS = 128 };

/* Button mask: 0..18 = remap's physical buttons/D-pad; 19/20 = Edge Fn,
 * 21/22 = Edge paddles; 23 = either touch contact (independent of tp_mode). */
#define GYRO_BUTTON_MASK 0x00FFFFFFu

struct gyro_config {
    uint8_t output, activation, trigger, threshold, flags, horizontal_axis;
    uint8_t smoothing_ms;
    uint16_t hold_ms, sensitivity_x, sensitivity_y, mouse_cpd;
    uint16_t noise_dps, max_turn_dps, stick_deadzone, stick_power;
    uint16_t accel_multiplier, accel_start_dps, accel_end_dps;
    uint32_t buttons;
    uint8_t stick_blend; /* 0 additive, 1 replace while active (wire p[34] bit0) */
    uint8_t profile_source; /* 0 any, 1 Edge native, 2 dongle remap (wire p[35] bits0-1) */
    uint8_t profile_mask;   /* native: triangle/square/cross/circle; dongle: 0/1 */
    uint8_t release_threshold;
    uint16_t ads_multiplier; /* L2 sensitivity /100, independent of gate */
    /* Optional generic "hold R2 -> constant downward bias" for offline/testing
     * use. Packed into spare bits: p[34] bits1-7 = half deg/s (0..63.5 deg/s),
     * p[35] bits2-7 = ramp time in 50 ms steps (0..3150 ms). Only used when
     * GYRO_FIRE_BIAS is set; no per-weapon data exists in the firmware. */
    uint8_t fire_bias_half_dps, fire_ramp_50ms;
};

/* Pure C engine; one owner (usb_task). Units on wire: sensitivity, mouse_cpd,
 * noise_dps, stick_power and accel_multiplier use /100; stick_deadzone /1000.
 * The runtime may persist an explicitly measured bias for the same controller. */
void gyro_init(void);
void gyro_defaults(uint8_t out[GYRO_CONFIG_SIZE]);
bool gyro_set_config(const uint8_t *data, uint16_t len);
bool gyro_validate_config(const uint8_t *data, uint16_t len);
void gyro_get_config(uint8_t out[GYRO_CONFIG_SIZE]);
void gyro_reset_stream(bool forget_calibration);
bool gyro_set_factory_calibration(const uint8_t *data, uint16_t len);
void gyro_start_calibration(void);
void gyro_clear_calibration(void);
bool gyro_get_calibration(float bias[3]);
bool gyro_restore_calibration(const float bias[3]);
void gyro_process(const uint8_t raw[63], uint8_t output[63],
                  uint32_t host_us, bool edge);
void gyro_idle(uint32_t host_us);
void gyro_get_status(uint8_t out[GYRO_REPORT_SIZE]);
void gyro_mouse_peek(int8_t *dx, int8_t *dy);
void gyro_mouse_consume(int8_t dx, int8_t dy);
void gyro_set_dongle_profile(uint8_t profile);
uint32_t gyro_buttons(const uint8_t *payload, bool edge);
void gyro_suppress_buttons(uint8_t *payload, uint32_t mask);
void gyro_set_modifiers(bool paused, uint16_t fine_multiplier);
