#include "gyro.h"
#include "gyro_runtime.h"
#include "ds5_protocol.h"
#include "usb_gamepad.h"
#include "config.h"
#include "remap.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static uint8_t p[63], out[63], c[40], status[63];
static uint32_t timestamp, host;
static struct config_body app_config;
static uint8_t saved[40];
static bool saved_valid, save_fails, endpoint_ready = true;
static int mouse_reports;
static int8_t mouse_dx, mouse_dy;
static uint8_t mouse_buttons;

static void put16(uint8_t *v, int n) { v[0] = (uint8_t)n; v[1] = (uint8_t)(n >> 8); }
static void put32(uint8_t *v, uint32_t n) { put16(v, n); put16(v + 2, n >> 16); }
static void setup(void)
{
    gyro_init(); gyro_defaults(c);
    memset(p, 0, sizeof(p)); p[0] = p[1] = p[2] = p[3] = 128;
    p[7] = 8; p[32] = p[36] = 0x80; put16(p + 23, 8192);
    timestamp = 0; host = 0;
    c[1] = GYRO_MOUSE; c[2] = GYRO_ALWAYS; c[3] = 0; c[7] = 0;
    put16(c + 10, 100); put16(c + 12, 100); put16(c + 14, 100);
    put16(c + 16, 0); put16(c + 20, 0);
    assert(gyro_set_config(c, sizeof(c)));
    memset(&app_config, 0, sizeof(app_config));
    endpoint_ready = true; mouse_reports = 0; remap_init();
}
static void tick(uint32_t us, bool edge)
{
    timestamp += us * 3; host += us;
    put32(p + 27, timestamp); memcpy(out, p, sizeof(out));
    gyro_process(p, out, host, edge);
}
static void peek(int expected_x, int expected_y)
{
    int8_t dx, dy; gyro_mouse_peek(&dx, &dy);
    if (dx != expected_x || dy != expected_y)
        fprintf(stderr, "mouse at host=%u: actual %d,%d expected %d,%d\n", host, dx, dy, expected_x, expected_y);
    assert(dx == expected_x); assert(dy == expected_y);
}
static void test_units_and_axes(void)
{
    setup(); put16(p + 15, 160); put16(p + 17, 320); put16(p + 19, 480);
    tick(1000, false); tick(10000, false);
    gyro_get_status(status);
    assert((int32_t)(status[20] | (status[21] << 8)) == 1000);
    assert((int32_t)(status[24] | (status[25] << 8)) == 2000);
    uint8_t bt[78] = {0x31}; memcpy(bt + 2, p, 63);
    struct ds5_input_state state;
    assert(ds5_parse_bt_input(bt, sizeof(bt), &state) == 0);
    assert(state.gyro_x == 160 && state.gyro_y == 320 && state.gyro_z == 480);
    memset(bt + 2 + 27, 0xFF, 4);
    assert(ds5_parse_bt_input(bt, sizeof(bt), &state) == 0 && state.sensor_timestamp == UINT32_MAX);
    assert(ds5_parse_bt_input(bt, 20, &state) < 0);
}
static void test_mouse_rate_and_fraction(void)
{
    setup(); put16(p + 17, 160); tick(1000, false);
    for (int i = 0; i < 10; i++) tick(10000, false);
    peek(1, 0); gyro_mouse_consume(1, 0); peek(0, 0);
    setup(); put16(p + 17, 160); tick(1000, false);
    for (int i = 0; i < 100; i++) tick(1000, false);
    int8_t dx, dy; gyro_mouse_peek(&dx, &dy); assert(dx == 0 || dx == 1);
    tick(1000, false); peek(1, 0);
    uint8_t before[63]; gyro_get_status(before);
    memcpy(out, p, 63); gyro_process(p, out, host + 100, false); /* duplicate sensor sample */
    peek(1, 0);
    timestamp = UINT32_MAX - 1499; host = 1000;
    gyro_reset_stream(false); tick(100, false); tick(1000, false);
    gyro_get_status(status); assert(status[4] == 0xE8 && status[5] == 3);
}
static void test_gate_and_toggle(void)
{
    setup(); c[2] = GYRO_HOLD; c[3] = 1; put16(c + 8, 100);
    assert(gyro_set_config(c, 40)); put16(p + 17, 16000); p[4] = 63;
    tick(1000, false); peek(0, 0); p[4] = 64;
    tick(1000, false); for (int i = 0; i < 9; i++) tick(10000, false);
    peek(0, 0); tick(10000, false); peek(10, 0);
    p[4] = 0; tick(1000, false); peek(0, 0); assert(out[4] == 0);
    p[4] = 255; tick(1000, false); peek(0, 0); /* must qualify again */
    c[2] = GYRO_TOGGLE; put16(c + 8, 0); assert(gyro_set_config(c, 40));
    tick(1000, false); peek(0, 0); /* held through config reset is not a new press */
    p[4] = 0; tick(1000, false); p[4] = 255;
    tick(1000, false); tick(10000, false); peek(11, 0);
    gyro_mouse_consume(11, 0); tick(10000, false); peek(10, 0); /* holding does not retoggle */
    p[4] = 0; tick(10000, false); gyro_mouse_consume(20, 0); peek(0, 0);
    p[4] = 255; tick(1000, false); peek(0, 0);
    gyro_get_status(status); assert(!(status[1] & 2));
    c[2] = GYRO_HOLD_OFF; assert(gyro_set_config(c, 40));
    p[4] = 0; tick(1000, false); tick(10000, false); peek(10, 0);
    p[4] = 255; tick(1000, false); peek(0, 0);
}
static void test_buttons_and_suppression(void)
{
    setup(); c[2] = GYRO_HOLD; put32(c + 30, (1u << 19) | (1u << 21));
    c[5] = GYRO_REQUIRE_ALL | GYRO_SUPPRESS; assert(gyro_set_config(c, 40));
    p[9] = 0xD7; tick(1000, false); gyro_get_status(status); assert(!(status[1] & 2));
    tick(1000, true); gyro_get_status(status); assert(status[1] & 2);
    assert(out[9] == 0x87); /* only chosen Fn-left/paddle-left cleared */
    assert(p[9] == 0xD7); /* original is untouched */
    p[9] = 0x40; tick(1000, true); gyro_get_status(status); assert(!(status[1] & 2));
    c[5] = 0; assert(gyro_set_config(c, 40)); tick(1000, true);
    gyro_get_status(status); assert(status[1] & 2); /* any button */
    c[3] = 1; c[5] = GYRO_SUPPRESS; put32(c + 30, 0); assert(gyro_set_config(c, 40));
    p[4] = 255; p[8] = 0x0C; tick(1000, false);
    assert(out[4] == 0 && !(out[8] & 4) && (out[8] & 8));
    setup(); c[2] = GYRO_HOLD; put32(c + 30, 1u << 23); assert(gyro_set_config(c, 40));
    p[36] = 0; tick(1000, false); gyro_get_status(status); assert(status[1] & 2);
}
static void test_profile_binding(void)
{
    setup(); c[35] = 1; c[36] = 2; assert(gyro_set_config(c, 40));
    put16(p + 17, 16000);
    p[48] = 0x20; tick(1000, false); gyro_get_status(status); assert(!(status[1] & 2));
    tick(1000, true); gyro_get_status(status); assert(status[1] & 2); /* Fn+Square */
    tick(10000, true); peek(11, 0);
    p[48] = 0x30; tick(1000, true); peek(0, 0); /* Fn+Cross turns it off */
    gyro_get_status(status); assert(!(status[1] & 2) && (status[62] & 15) == 3);
    p[48] = 0; tick(1000, true); gyro_get_status(status); assert(!(status[1] & 2));
    c[35] = 2; c[36] = 2; assert(gyro_set_config(c, 40));
    gyro_set_dongle_profile(0); tick(1000, false); gyro_get_status(status); assert(!(status[1] & 2));
    gyro_set_dongle_profile(1); tick(1000, false); gyro_get_status(status); assert(status[1] & 2);
    gyro_set_dongle_profile(0); tick(1000, false); peek(0, 0);
}
static void test_stick_and_drift(void)
{
    setup(); c[1] = GYRO_RIGHT_STICK; c[34] = 1; put16(c + 18, 100);
    put16(c + 20, 100); put16(c + 22, 200); assert(gyro_set_config(c, 40));
    put16(p + 17, 400); tick(1000, false);
    assert(out[2] >= 197 && out[2] <= 199); /* 25% rate -> .1+.9*sqrt(.25) */
    put16(p + 17, 16000); tick(1000, false); assert(out[2] == 255);
    put16(p + 17, -16000); tick(1000, false); assert(out[2] == 1);
    c[1] = GYRO_OFF; assert(gyro_set_config(c, 40)); tick(1000, false); assert(out[2] == p[2]);
    setup(); put16(c + 16, 100); assert(gyro_set_config(c, 40));
    put16(p + 17, 8); tick(1000, false); tick(10000, false); peek(0, 0);
    setup(); c[5] = GYRO_INVERT_X | GYRO_INVERT_Y; assert(gyro_set_config(c, 40));
    put16(p + 15, 1600); put16(p + 17, 1600); tick(1000, false); tick(10000, false); peek(-1, 1);
    setup(); put16(c + 24, 200); put16(c + 26, 0); put16(c + 28, 100);
    assert(gyro_set_config(c, 40)); put16(p + 17, 1600); tick(1000, false); tick(10000, false); peek(2, 0);
}
static void test_calibration(void)
{
    setup(); uint8_t factory[40] = {0};
    for (int i = 0; i < 3; i++) { put16(factory + 6 + i * 4, 8640); put16(factory + 8 + i * 4, -8640); }
    put16(factory + 18, 540); put16(factory + 20, 540);
    assert(gyro_set_factory_calibration(factory, sizeof(factory)));
    factory[6] = factory[7] = factory[8] = factory[9] = 0;
    assert(!gyro_set_factory_calibration(factory, sizeof(factory)));
    put16(p + 17, 16); gyro_start_calibration(); tick(1000, false);
    for (int i = 0; i < 199; i++) tick(10000, false);
    gyro_get_status(status); assert(status[1] & 4); peek(0, 0);
    tick(10000, false); gyro_get_status(status); assert(!(status[1] & 4) && (status[1] & 8));
    tick(10000, false); peek(0, 0); /* corrected 1 deg/s resting offset */
    gyro_start_calibration(); put16(p + 17, 1600); tick(10000, false);
    gyro_get_status(status); assert(status[3] == 0); /* motion rejects the window */
    gyro_clear_calibration(); gyro_get_status(status); assert(!(status[1] & 8));
    assert(status[1] & 16); gyro_reset_stream(true); gyro_get_status(status); assert(!(status[1] & 16));
}
static void test_gap_and_validation(void)
{
    setup(); put16(p + 17, 16000); tick(1000, false); tick(10000, false); peek(10, 0);
    tick(500000, false); peek(0, 0); /* no giant jump after packet loss */
    tick(10000, false); peek(10, 0);
    gyro_idle(host + 100001); peek(0, 0); gyro_get_status(status); assert(!(status[1] & 1));
    uint8_t baseline[40], actual[40]; gyro_get_config(baseline);
    for (int i = 0; i < 40; i++) {
        uint8_t invalid[40]; memcpy(invalid, baseline, 40); invalid[i] = 255;
        if (!gyro_set_config(invalid, 40)) { gyro_get_config(actual); assert(!memcmp(actual, baseline, 40)); }
        else assert(gyro_set_config(baseline, 40));
    }
    assert(!gyro_set_config(c, 39)); assert(!gyro_set_config(NULL, 40));
    c[2] = GYRO_HOLD; c[3] = 0; assert(!gyro_set_config(c, 40));
}
static void test_usb_mouse_merge(void)
{
    setup(); put16(p + 17, 16000); tick(1000, false); tick(10000, false);
    endpoint_ready = false; remap_mouse_tick(p); peek(10, 0); assert(mouse_reports == 0);
    endpoint_ready = true; remap_mouse_tick(p); assert(mouse_reports == 1 && mouse_dx == 10 && mouse_dy == 0); peek(0, 0);
    /* Mouse button mapping works even with touchpad mode disabled. */
    remap_entry_t table[REMAP_BTN_COUNT]; memcpy(table, remap_get_table(), sizeof(table));
    table[REMAP_BTN_CROSS] = (remap_entry_t){ REMAP_TYPE_MOUSE, 0, 0, 0 };
    remap_set((const uint8_t *)table, sizeof(table)); p[7] = 0x28;
    remap_mouse_tick(p); assert(mouse_buttons == 1);
    endpoint_ready = false; p[7] = 8; remap_mouse_tick(p); assert(mouse_buttons == 1);
    endpoint_ready = true; remap_mouse_tick(p); assert(mouse_buttons == 0);
    /* Saturated touch motion must leave excess gyro motion for a later packet. */
    app_config.tp_mode = 2; app_config.tp_mouse_sensitivity = 32;
    p[32] = 0; p[33] = 0; p[34] = 0; p[35] = 0; remap_mouse_tick(p);
    tick(10000, false); p[33] = 200; remap_mouse_tick(p); assert(mouse_dx == 127); peek(10, 0);
    remap_mouse_tick(p); assert(mouse_dx == 10); peek(0, 0);
}
static void test_runtime_commands(void)
{
    setup(); saved_valid = save_fails = false; gyro_runtime_init();
    uint8_t cmd[63] = {1, 7}; memcpy(cmd + 2, c, 40);
    gyro_runtime_command(cmd, sizeof(cmd)); gyro_runtime_get_config(status);
    assert(status[1] == GYRO_MOUSE && status[40] == 1 && status[41] == 0 && status[42] == 7);
    cmd[0] = 2; cmd[1] = 8; gyro_runtime_command(cmd, 63); assert(saved_valid);
    gyro_runtime_init(); gyro_runtime_get_config(status); assert(status[1] == GYRO_MOUSE);
    save_fails = true; gyro_runtime_command(cmd, 63); gyro_runtime_get_config(status); assert(status[41] == 2);
    cmd[0] = 1; cmd[2] = 99; gyro_runtime_command(cmd, 63); gyro_runtime_get_config(status); assert(status[41] == 1 && status[1] == GYRO_MOUSE);
    cmd[0] = 4; gyro_runtime_command(cmd, 63); gyro_runtime_get_config(status); assert(status[1] == GYRO_OFF);
    cmd[0] = 3; gyro_runtime_command(cmd, 63); gyro_runtime_get_status(status); assert(status[1] & 4);
    gyro_runtime_on_disconnect(); gyro_runtime_poll(false, host); gyro_runtime_get_status(status); assert(!(status[1] & 4));
}

/* Hardware/flash stand-ins. No SDK or connected controller is needed. */
struct config_body *config_get(void) { return &app_config; }
uint64_t bflb_mtimer_get_time_us(void) { return host; }
bool usb_gamepad_kbd_ready(void) { return endpoint_ready; }
int usb_gamepad_send_kbd_report(const uint8_t *data, uint8_t len) { return 0; }
int usb_gamepad_send_mouse_report(uint8_t buttons, int8_t dx, int8_t dy, int8_t wheel)
{
    if (!endpoint_ready) return -1;
    mouse_reports++; mouse_buttons = buttons; mouse_dx = dx; mouse_dy = dy; return 0;
}
int ef_get_env_blob(const char *key, void *data, size_t len, size_t *saved_len) { *saved_len = 0; return -1; }
int ef_set_env_blob(const char *key, const void *data, size_t len) { return 0; }
int bt_settings_get_bin(const char *key, uint8_t *data, size_t len, size_t *saved_len)
{
    *saved_len = saved_valid ? sizeof(saved) : 0;
    if (!saved_valid) return -1;
    assert(len == sizeof(saved)); memcpy(data, saved, len); return 0;
}
int bt_settings_set_bin(const char *key, const uint8_t *data, size_t len)
{
    if (save_fails) return -1;
    assert(len == sizeof(saved)); memcpy(saved, data, len); saved_valid = true; return 0;
}
bool bt_hid_host_get_cached_feature(uint8_t id, const uint8_t **data, uint16_t *len) { return false; }

int main(void)
{
    setbuf(stdout, NULL);
    puts("units/axes"); test_units_and_axes();
    puts("mouse timing"); test_mouse_rate_and_fraction();
    puts("activation"); test_gate_and_toggle();
    puts("buttons"); test_buttons_and_suppression();
    puts("profile binding"); test_profile_binding();
    puts("stick"); test_stick_and_drift();
    puts("calibration"); test_calibration();
    puts("loss/validation"); test_gap_and_validation();
    puts("mouse merge"); test_usb_mouse_merge();
    puts("runtime"); test_runtime_commands();
    puts("gyro: 10 test groups passed"); return 0;
}
