#include "gyro.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

static struct gyro_config cfg;
static struct {
    bool connected, active, held, qualified, latched, timestamp_valid, toggle_armed;
    bool factory, calibrating, calibrated, trigger_held, ads_held, paused;
    bool cal_clock, cal_failed, stick_moving;
    uint32_t cal_started;
    uint16_t fine_multiplier;
    uint32_t last_sensor, last_host, held_since, dt_us, packets, buttons;
    float scale[3], factory_bias[3], bias[3], rate[3], filtered[2], pending[2];
    int16_t raw[3], accel[3];
    uint8_t stick[2];
    uint8_t dongle_profile, native_profile, selected_profile;
    uint32_t cal_us;
    uint16_t cal_samples;
    float cal_sum[3], cal_min[3], cal_max[3];
} motion;

static uint16_t u16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static int16_t i16(const uint8_t *p) { return (int16_t)u16(p); }
static uint32_t u32(const uint8_t *p)
{
    return (uint32_t)u16(p) | ((uint32_t)u16(p + 2) << 16);
}
static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v)
{
    put16(p, (uint16_t)v); put16(p + 2, (uint16_t)(v >> 16));
}
static float clamp(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

static void encode(const struct gyro_config *c, uint8_t *p)
{
    memset(p, 0, GYRO_CONFIG_SIZE);
    p[0] = GYRO_CONFIG_VERSION;
    p[1] = c->output; p[2] = c->activation; p[3] = c->trigger;
    p[4] = c->threshold; p[5] = c->flags; p[6] = c->horizontal_axis;
    p[7] = c->smoothing_ms;
    put16(p + 8, c->hold_ms);
    put16(p + 10, c->sensitivity_x); put16(p + 12, c->sensitivity_y);
    put16(p + 14, c->mouse_cpd); put16(p + 16, c->noise_dps);
    put16(p + 18, c->max_turn_dps); put16(p + 20, c->stick_deadzone);
    put16(p + 22, c->stick_power); put16(p + 24, c->accel_multiplier);
    put16(p + 26, c->accel_start_dps); put16(p + 28, c->accel_end_dps);
    put32(p + 30, c->buttons); p[34] = c->stick_blend;
    p[35] = c->profile_source; p[36] = c->profile_mask;
    p[37] = c->release_threshold; put16(p + 38, c->ads_multiplier);
}

void gyro_defaults(uint8_t out[GYRO_CONFIG_SIZE])
{
    const struct gyro_config defaults = {
        .output = GYRO_OFF, .activation = GYRO_HOLD, .trigger = 1,
        .threshold = 64, .smoothing_ms = 8,
        .sensitivity_x = 200, .sensitivity_y = 200, .mouse_cpd = 1200,
        .noise_dps = 50, .max_turn_dps = 360, .stick_deadzone = 100,
        .stick_power = 100, .accel_multiplier = 100,
        .accel_start_dps = 30, .accel_end_dps = 180,
        .release_threshold = 64, .ads_multiplier = 100,
    };
    encode(&defaults, out);
}

void gyro_reset_stream(bool forget_calibration)
{
    motion.active = motion.held = motion.qualified = motion.latched = false;
    motion.toggle_armed = false;
    motion.trigger_held = motion.ads_held = false;
    motion.stick_moving = false;
    motion.connected = motion.timestamp_valid = false;
    motion.selected_profile = 255;
    motion.dt_us = 0;
    memset(motion.filtered, 0, sizeof(motion.filtered));
    memset(motion.pending, 0, sizeof(motion.pending));
    motion.cal_us = 0; motion.cal_samples = 0;
    if (forget_calibration) {
        motion.factory = motion.calibrating = motion.calibrated = false;
        motion.cal_clock = motion.cal_failed = false;
        memset(motion.bias, 0, sizeof(motion.bias));
        memset(motion.factory_bias, 0, sizeof(motion.factory_bias));
        for (int i = 0; i < 3; i++) motion.scale[i] = 1.0f / 16.0f;
    }
}

static bool decode(const uint8_t *p, uint16_t len, struct gyro_config *result)
{
    if (!p || len != GYRO_CONFIG_SIZE || (p[0] != 1 && p[0] != GYRO_CONFIG_VERSION))
        return false;
    struct gyro_config c = {
        .output = p[1], .activation = p[2], .trigger = p[3], .threshold = p[4],
        .flags = p[5], .horizontal_axis = p[6], .smoothing_ms = p[7],
        .hold_ms = u16(p + 8), .sensitivity_x = u16(p + 10),
        .sensitivity_y = u16(p + 12), .mouse_cpd = u16(p + 14),
        .noise_dps = u16(p + 16), .max_turn_dps = u16(p + 18),
        .stick_deadzone = u16(p + 20), .stick_power = u16(p + 22),
        .accel_multiplier = u16(p + 24), .accel_start_dps = u16(p + 26),
        .accel_end_dps = u16(p + 28), .buttons = u32(p + 30),
        .stick_blend = p[34],
        .profile_source = p[35], .profile_mask = p[36],
        .release_threshold = p[0] == 1 ? p[4] : p[37],
        .ads_multiplier = p[0] == 1 ? 100 : u16(p + 38),
    };
    if (c.output > GYRO_RIGHT_STICK || c.activation > GYRO_HOLD_OFF ||
        c.trigger > 2 || !c.threshold || (c.flags & ~15u) ||
        c.horizontal_axis > 1 || c.smoothing_ms > 100 || c.hold_ms > 3000 ||
        !c.sensitivity_x || c.sensitivity_x > 10000 ||
        !c.sensitivity_y || c.sensitivity_y > 10000 ||
        !c.mouse_cpd || c.mouse_cpd > 10000 || c.noise_dps > 1000 ||
        !c.max_turn_dps || c.max_turn_dps > 3000 || c.stick_deadzone > 500 ||
        c.stick_power < 25 || c.stick_power > 400 ||
        c.accel_multiplier < 100 || c.accel_multiplier > 1000 ||
        c.accel_start_dps >= c.accel_end_dps || c.accel_end_dps > 2000 ||
        (c.buttons & ~GYRO_BUTTON_MASK) || c.stick_blend > 1 ||
        c.profile_source > 2 || (c.profile_mask & ~15u) ||
        (c.profile_source && !c.profile_mask) ||
        (c.profile_source == 2 && c.profile_mask > 3) ||
        !c.release_threshold || c.release_threshold > c.threshold ||
        !c.ads_multiplier || c.ads_multiplier > 400 ||
        (c.activation != GYRO_ALWAYS && !c.trigger && !c.buttons))
        return false;
    if (p[0] == 1 && (p[37] || p[38] || p[39])) return false;
    *result = c;
    return true;
}

bool gyro_validate_config(const uint8_t *p, uint16_t len)
{
    struct gyro_config c;
    return decode(p, len, &c);
}

bool gyro_set_config(const uint8_t *p, uint16_t len)
{
    struct gyro_config c;
    if (!decode(p, len, &c)) return false;
    cfg = c;
    gyro_reset_stream(false);
    return true;
}

void gyro_init(void)
{
    uint8_t defaults[GYRO_CONFIG_SIZE];
    memset(&motion, 0, sizeof(motion));
    motion.fine_multiplier = 100;
    gyro_defaults(defaults);
    gyro_set_config(defaults, sizeof(defaults));
    gyro_reset_stream(true);
}

void gyro_get_config(uint8_t out[GYRO_CONFIG_SIZE]) { encode(&cfg, out); }

bool gyro_set_factory_calibration(const uint8_t *p, uint16_t len)
{
    /* Feature 0x05 data WITHOUT report ID or BT header. Validate every axis
     * before committing. Scale converts the signed raw sample to deg/s.
     * Protocol reference: SDL_hidapi_ps5.c and Linux hid-playstation.c. */
    if (!p || len < 34) return false;
    float scale[3], bias[3];
    int speed = (int)i16(p + 18) + i16(p + 20);
    if (speed <= 0) return false;
    for (int i = 0; i < 3; i++) {
        bias[i] = i16(p + i * 2);
        int span = (int)i16(p + 6 + i * 4) - i16(p + 8 + i * 4);
        if (span <= 0 || fabsf(bias[i]) > 1024.0f) return false;
        scale[i] = (float)speed / (float)span;
        if (scale[i] < 0.03f || scale[i] > 0.10f) return false;
    }
    memcpy(motion.scale, scale, sizeof(scale));
    memcpy(motion.factory_bias, bias, sizeof(bias));
    motion.factory = true;
    gyro_clear_calibration();
    gyro_reset_stream(false);
    return true;
}

void gyro_start_calibration(void)
{
    gyro_reset_stream(false);
    motion.calibrating = true;
    motion.cal_clock = motion.cal_failed = false;
}

void gyro_clear_calibration(void)
{
    motion.calibrating = motion.calibrated = false;
    motion.cal_clock = motion.cal_failed = false;
    motion.cal_us = 0; motion.cal_samples = 0;
    memset(motion.bias, 0, sizeof(motion.bias));
    memset(motion.filtered, 0, sizeof(motion.filtered));
    memset(motion.pending, 0, sizeof(motion.pending));
}
bool gyro_get_calibration(float bias[3])
{
    if(!motion.calibrated||motion.calibrating)return false;
    memcpy(bias,motion.bias,sizeof motion.bias);return true;
}
bool gyro_restore_calibration(const float bias[3])
{
    for(int i=0;i<3;i++)if(!isfinite(bias[i])||fabsf(bias[i])>20)return false;
    gyro_clear_calibration();memcpy(motion.bias,bias,sizeof motion.bias);motion.calibrated=true;return true;
}

uint32_t gyro_buttons(const uint8_t *p, bool edge)
{
    uint32_t b = (p[7] >> 4) | ((uint32_t)p[8] << 4) |
                 ((uint32_t)(p[9] & 7) << 12);
    uint8_t hat = p[7] & 15;
    if (hat == 0 || hat == 1 || hat == 7) b |= 1u << 15;
    if (hat == 3 || hat == 4 || hat == 5) b |= 1u << 16;
    if (hat == 5 || hat == 6 || hat == 7) b |= 1u << 17;
    if (hat == 1 || hat == 2 || hat == 3) b |= 1u << 18;
    if (edge) b |= (uint32_t)(p[9] >> 4) << 19;
    if (!(p[32] & 0x80) || !(p[36] & 0x80)) b |= 1u << 23;
    return b;
}

static bool condition(void)
{
    if (cfg.trigger && !motion.trigger_held) return false;
    uint32_t selected = motion.buttons & cfg.buttons;
    return !cfg.buttons || ((cfg.flags & GYRO_REQUIRE_ALL) ?
                            selected == cfg.buttons : selected != 0);
}

void gyro_suppress_buttons(uint8_t *p, uint32_t b)
{
    p[7] &= (uint8_t)~((b & 15) << 4);
    p[8] &= (uint8_t)~((b >> 4) & 255);
    p[9] &= (uint8_t)~(((b >> 12) & 7) | (((b >> 19) & 15) << 4));
    /* A diagonal containing a selected direction is neutralised as a whole. */
    if (gyro_buttons(p, false) & b & (15u << 15)) p[7] = (p[7] & 0xF0) | 8;
    if (b & (1u << 6)) { p[4] = 0; p[8] &= ~4u; }
    if (b & (1u << 7)) { p[5] = 0; p[8] &= ~8u; }
    if (b & (1u << 23)) { p[32] |= 0x80; p[36] |= 0x80; }
}

static void calibrate(const float rate[3], uint32_t dt)
{
    float g2 = 0;
    bool still = true;
    for (int i = 0; i < 3; i++) {
        float a = motion.accel[i] / 8192.0f;
        g2 += a * a;
        if (fabsf(rate[i]) > 3.0f) still = false;
    }
    if (!still || g2 < 0.81f || g2 > 1.21f) {
        motion.cal_us = 0; motion.cal_samples = 0;
        return;
    }
    if (!motion.cal_samples) {
        memset(motion.cal_sum, 0, sizeof(motion.cal_sum));
        for (int i = 0; i < 3; i++) motion.cal_min[i] = motion.cal_max[i] = rate[i];
    }
    for (int i = 0; i < 3; i++) {
        motion.cal_min[i] = fminf(motion.cal_min[i], rate[i]);
        motion.cal_max[i] = fmaxf(motion.cal_max[i], rate[i]);
        if (motion.cal_max[i] - motion.cal_min[i] > 0.8f) {
            motion.cal_us = 0; motion.cal_samples = 0;
            return;
        }
        motion.cal_sum[i] += rate[i] * (float)dt;
    }
    motion.cal_us += dt;
    motion.cal_samples++;
    if (motion.cal_us >= 2000000 && motion.cal_samples >= 100) {
        for (int i = 0; i < 3; i++) motion.bias[i] = motion.cal_sum[i] / motion.cal_us;
        motion.calibrating = false; motion.calibrated = true;
    }
}

static void stick_values(float output[2])
{
    float magnitude = sqrtf(motion.filtered[0] * motion.filtered[0] +
                            motion.filtered[1] * motion.filtered[1]);
    output[0] = output[1] = 0;
    if (magnitude == 0) return;
    float v = clamp(magnitude / cfg.max_turn_dps, 0, 1);
    float deadzone = cfg.stick_deadzone / 1000.0f;
    v = deadzone + (1.0f - deadzone) * powf(v, 100.0f / cfg.stick_power);
    /* Invert the game's radial response once, rather than adding the minimum
     * deadzone output separately to both axes (which makes noise a square). */
    for (int i = 0; i < 2; i++) output[i] = motion.filtered[i] / magnitude * v * 127.0f;
}

static void calibration_timeout(uint32_t now_us)
{
    if (!motion.calibrating) return;
    if (!motion.cal_clock) { motion.cal_started = now_us; motion.cal_clock = true; }
    if (now_us - motion.cal_started >= 30000000u) {
        motion.calibrating = false; motion.cal_failed = true;
        motion.cal_us = 0; motion.cal_samples = 0;
    }
}

void gyro_process(const uint8_t raw[63], uint8_t out[63], uint32_t host_us, bool edge)
{
    calibration_timeout(host_us);
    uint32_t sensor = u32(raw + 27);
    bool had_timestamp = motion.timestamp_valid;
    uint32_t delta = sensor - motion.last_sensor; /* wrap is intentional */
    if (had_timestamp && (delta > 150000 || host_us - motion.last_host > 50000)) {
        gyro_reset_stream(false);
        had_timestamp = false;
    }
    motion.dt_us = had_timestamp ? delta / 3 : 0;
    motion.last_sensor = sensor; motion.last_host = host_us;
    motion.timestamp_valid = motion.connected = true;
    motion.packets++;
    motion.buttons = gyro_buttons(raw, edge);
    motion.trigger_held = cfg.trigger && raw[3 + cfg.trigger] >=
        (motion.trigger_held ? cfg.release_threshold : cfg.threshold);
    motion.ads_held = raw[4] >= (motion.ads_held ? cfg.release_threshold : cfg.threshold);
    float uncorrected[3];
    for (int i = 0; i < 3; i++) {
        motion.raw[i] = i16(raw + 15 + i * 2);
        motion.accel[i] = i16(raw + 21 + i * 2);
        uncorrected[i] = (motion.raw[i] - motion.factory_bias[i]) * motion.scale[i];
        motion.rate[i] = uncorrected[i] - motion.bias[i];
    }
    bool calibrating = motion.calibrating;
    if (calibrating && motion.dt_us) calibrate(uncorrected, motion.dt_us);

    /* Native profile codes are 1=Fn+Triangle(default), 2=Fn+Square,
     * 3=Fn+Cross, 4=Fn+Circle. Unknown values fail closed when bound.
     * Reference: dualsense-tester's DSE ProfileWidget and input offsets. */
    motion.native_profile = edge ? (raw[48] >> 4) : 0;
    uint8_t profile = cfg.profile_source == 1 ?
        (motion.native_profile >= 1 && motion.native_profile <= 4 ?
         motion.native_profile - 1 : 255) : motion.dongle_profile;
    if (profile != motion.selected_profile) {
        motion.active = motion.held = motion.qualified = motion.latched = false;
        motion.toggle_armed = false;
        memset(motion.pending, 0, sizeof(motion.pending));
        motion.selected_profile = profile;
    }
    bool allowed = !cfg.profile_source ||
                   (profile < 4 && (cfg.profile_mask & (1u << profile)));
    bool pressed = allowed && condition();
    if (!pressed) motion.toggle_armed = true;
    if (pressed && !motion.held) motion.held_since = host_us;
    bool qualified = pressed && (host_us - motion.held_since >= (uint32_t)cfg.hold_ms * 1000);
    if (qualified && !motion.qualified && motion.toggle_armed) {
        motion.latched = !motion.latched;
        motion.toggle_armed = false;
    }
    motion.held = pressed; motion.qualified = qualified;
    bool active = cfg.activation == GYRO_ALWAYS ||
                  (cfg.activation == GYRO_HOLD && qualified) ||
                  (cfg.activation == GYRO_TOGGLE && motion.latched) ||
                  (cfg.activation == GYRO_HOLD_OFF && !qualified);
    active = active && allowed && cfg.output != GYRO_OFF && !calibrating && !motion.paused;
    if (allowed && cfg.output && (cfg.flags & GYRO_SUPPRESS))
        gyro_suppress_buttons(out, cfg.buttons | (cfg.trigger ? 1u << (5 + cfg.trigger) : 0));

    float hand[2] = { motion.rate[cfg.horizontal_axis ? 2 : 1], -motion.rate[0] };
    if (cfg.flags & GYRO_INVERT_X) hand[0] = -hand[0];
    if (cfg.flags & GYRO_INVERT_Y) hand[1] = -hand[1];
    float speed = sqrtf(hand[0] * hand[0] + hand[1] * hand[1]);
    float noise = cfg.noise_dps / 100.0f;
    float tighten = speed > noise && speed > 0 ? (speed - noise) / speed : 0;
    float ramp = clamp((speed - cfg.accel_start_dps) /
                       (cfg.accel_end_dps - cfg.accel_start_dps), 0, 1);
    float acceleration = 1 + ramp * (cfg.accel_multiplier / 100.0f - 1);
    bool was_active = motion.active;
    motion.active = active;
    bool stick_output = active && cfg.output == GYRO_RIGHT_STICK;
    bool was_moving = motion.stick_moving;
    /* A wider entry threshold avoids repeatedly lifting resting noise over the
     * game's deadzone. Returning to quiet also discards the filter's tail. */
    motion.stick_moving = stick_output && speed > noise * (was_moving ? 1.0f : 1.5f);
    float smooth_us = cfg.smoothing_ms * 1000.0f;
    if (stick_output) smooth_us /= 1 + 3 * clamp(speed / 90.0f, 0, 1);
    float alpha = smooth_us ? motion.dt_us / (motion.dt_us + smooth_us) : 1;
    for (int i = 0; i < 2; i++) {
        float target = hand[i] * tighten * acceleration *
                       (i == 0 ? cfg.sensitivity_x : cfg.sensitivity_y) / 100.0f *
                       (motion.ads_held ? cfg.ads_multiplier / 100.0f : 1.0f) *
                       (motion.fine_multiplier / 100.0f);
        /* Reset history on activation so the previous aiming session cannot
         * leak a tail into the next one. The first packet has no integration. */
        if (!active || (stick_output && !motion.stick_moving))
            motion.filtered[i] = motion.pending[i] = 0;
        else if (!was_active || (stick_output && !was_moving)) motion.filtered[i] = target;
        else if (stick_output && target * motion.filtered[i] < 0 && fabsf(hand[i]) > noise * 1.5f)
            motion.filtered[i] = alpha * target; /* no stale opposite-direction output */
        else motion.filtered[i] += alpha * (target - motion.filtered[i]);
        if (active && cfg.output == GYRO_MOUSE && motion.dt_us) {
            motion.pending[i] = clamp(motion.pending[i] + motion.filtered[i] *
                (motion.dt_us / 1000000.0f) * (cfg.mouse_cpd / 100.0f), -2048, 2048);
        }
    }
    float stick[2] = {0};
    if (stick_output) stick_values(stick);
    for (int i = 0; i < 2; i++) {
        if (stick_output) {
            float base = cfg.stick_blend ? 128.0f : out[2 + i];
            out[2 + i] = (uint8_t)clamp(roundf(base + stick[i]), 0, 255);
        }
        motion.stick[i] = out[2 + i];
    }
}

void gyro_idle(uint32_t host_us)
{
    calibration_timeout(host_us);
    if (motion.connected && host_us - motion.last_host > 100000)
        gyro_reset_stream(false);
}

void gyro_mouse_peek(int8_t *dx, int8_t *dy)
{
    *dx = (int8_t)clamp(truncf(motion.pending[0]), -127, 127);
    *dy = (int8_t)clamp(truncf(motion.pending[1]), -127, 127);
}

void gyro_mouse_consume(int8_t dx, int8_t dy)
{
    motion.pending[0] -= dx; motion.pending[1] -= dy;
}

void gyro_set_dongle_profile(uint8_t profile) { motion.dongle_profile = profile; }

void gyro_set_modifiers(bool paused, uint16_t fine_multiplier)
{
    motion.paused = paused;
    motion.fine_multiplier = fine_multiplier;
}

void gyro_get_status(uint8_t p[GYRO_REPORT_SIZE])
{
    memset(p, 0, GYRO_REPORT_SIZE);
    p[0] = GYRO_CONFIG_VERSION;
    p[1] = motion.connected | (motion.active << 1) | (motion.calibrating << 2) |
           (motion.calibrated << 3) | (motion.factory << 4) | (motion.cal_failed << 5);
    p[2] = cfg.output;
    p[3] = (uint8_t)fminf(100, motion.cal_us / 20000.0f);
    put32(p + 4, motion.dt_us);
    for (int i = 0; i < 3; i++) {
        put16(p + 8 + i * 2, (uint16_t)motion.raw[i]);
        put16(p + 14 + i * 2, (uint16_t)motion.accel[i]);
        put32(p + 20 + i * 4, (uint32_t)(int32_t)roundf(motion.rate[i] * 100));
        put16(p + 52 + i * 2, (uint16_t)(int16_t)roundf(motion.bias[i] * 100));
    }
    put32(p + 32, (uint32_t)(int32_t)roundf(motion.filtered[0] * 100));
    put32(p + 36, (uint32_t)(int32_t)roundf(motion.filtered[1] * 100));
    p[40] = motion.stick[0]; p[41] = motion.stick[1];
    put16(p + 42, (uint16_t)(int16_t)motion.pending[0]);
    put16(p + 44, (uint16_t)(int16_t)motion.pending[1]);
    put32(p + 46, motion.buttons); put16(p + 50, motion.cal_samples);
    put32(p + 58, motion.packets);
    p[62] = (motion.native_profile & 15) | ((motion.dongle_profile & 3) << 4);
}
