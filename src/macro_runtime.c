#include "macro_runtime.h"
#include "bflb_mtimer.h"
#include "gyro.h"
#include "link_diag.h"
#include "macro_engine.h"
#include "macro_storage.h"
#include "usb_gamepad.h"
#include <string.h>

static macro_engine engine;
static uint8_t stage[MACRO_MAX_BYTES], io[MACRO_MAX_BYTES], response[2][63];
static uint8_t base[63], previous[63], raw_input[63], last_output[63];
static uint8_t diagnostic_snapshot[126];
static uint8_t link_snapshot[LINK_DIAG_SIZE];
static bool recording_mode;
static uint32_t record_heartbeat;
static uint16_t stage_size, stage_received;
static uint8_t stage_slot;
static bool base_valid;
static volatile uint8_t published;
static uint16_t get16(const uint8_t *p) {
    return p[0] | ((uint16_t)p[1] << 8);
}
static void put16(uint8_t *p, unsigned n) {
    p[0] = (uint8_t)n;
    p[1] = (uint8_t)(n >> 8);
}
static uint32_t now(void) {
    return (uint32_t)(bflb_mtimer_get_time_us() / 1000);
}
static void outputs(void) {
    uint8_t keys[8];
    macro_engine_keyboard(&engine, keys);
    usb_gamepad_set_macro_report(keys, engine.mouse_buttons, (int8_t)engine.wheel);
    engine.wheel = 0;
}
static void stop(void) {
    macro_engine_stop(&engine);
    outputs();
}
static void publish(uint8_t *p) {
    p[5] = engine.active ? engine.slot : 255;
    p[6] = (engine.active ? 1 : 0) | (stage_size ? 2 : 0);
    __asm volatile("" ::: "memory");
    published ^= 1;
}
void macro_runtime_init(void) {
    recording_mode = false;
    record_heartbeat = 0;
    macro_engine_init(&engine);
    stage_size = stage_received = 0;
    stage_slot = 255;
    base_valid = false;
    published = 0;
    memset(response, 0, sizeof response);
    response[0][0] = response[1][0] = 1;
    if (macro_storage_bindings_read(io, MACRO_BINDING_BYTES))
        macro_engine_set_bindings(&engine, io, MACRO_BINDING_BYTES);
}
static bool play(uint8_t slot, uint8_t source, uint32_t t) {
    if (engine.active && engine.slot == slot && engine.mode == MACRO_TOGGLE) {
        stop();
        return true;
    }
    if (engine.active)
        return false;
    size_t n;
    if (!macro_storage_read(slot, io, sizeof io, &n) || !n)
        return false;
    return macro_engine_start(&engine, slot, source, io, n, t);
}
void macro_runtime_process(const uint8_t raw[63], uint8_t out[63], bool edge, uint8_t profile, uint32_t t) {
    memcpy(raw_input, raw, 63);
    uint8_t source = 255;
    int requested = macro_engine_input(&engine, gyro_buttons(raw, edge), profile, t, &source);
    if (recording_mode) {
        macro_engine_stop(&engine);
        engine.suppress = 0;
    } else if (requested >= 0)
        play((uint8_t)requested, source, t);
    memcpy(base, out, 63);
    base_valid = true;
    gyro_suppress_buttons(out, engine.suppress);
    macro_engine_apply(&engine, out);
    memcpy(previous, out, 63);
    memcpy(last_output, out, 63);
    outputs();
}
void macro_runtime_poll(bool connected, uint32_t t) {
    if (recording_mode && (!connected || t - record_heartbeat > 3000)) {
        recording_mode = false;
        engine.input_valid = false;
    }
    macro_engine_tick(&engine, t, connected);
    outputs();
    if (!connected) {
        base_valid = false;
        return;
    }
    if (base_valid) {
        uint8_t out[63];
        memcpy(out, base, 63);
        gyro_suppress_buttons(out, engine.suppress);
        macro_engine_apply(&engine, out);
        if (memcmp(previous, out, 63)) {
            usb_gamepad_send_raw_input(out);
            memcpy(previous, out, 63);
            memcpy(last_output, out, 63);
        }
    }
}
void macro_runtime_get(uint8_t out[63]) {
    memcpy(out, response[published], 63);
}
void macro_runtime_command(const uint8_t *p, uint16_t n) {
    uint8_t next = published ^ 1, *r = response[next];
    memset(r, 0, 63);
    r[0] = 1;
    r[1] = p && n ? p[0] : 0;
    r[2] = p && n > 1 ? p[1] : 0;
    r[3] = 1;
    if (!p || n != 63)
        goto done;
    unsigned offset = get16(p + 3), count = p[5];
    uint8_t slot = p[2];
    r[4] = slot;
    put16(r + 8, offset);
    switch (p[0]) {
    case 0: {
        r[3] = 0;
        r[7] = 12;
        uint32_t free = macro_storage_free();
        for (int i = 0; i < 4; i++)
            r[12 + i] = (uint8_t)(free >> (i * 8));
        put16(r + 16, MACRO_MAX_BYTES);
        put16(r + 18, MACRO_MAX_STEPS);
        r[20] = MACRO_SLOTS;
        r[21] = MACRO_BINDINGS;
        r[22] = engine.profile;
        r[23] = engine.connected;
        break;
    }
    case 1: {
        size_t bytes;
        if (!macro_storage_read(slot, io, sizeof io, &bytes)) {
            r[3] = 2;
            break;
        }
        if (offset > bytes)
            break;
        count = (unsigned)(bytes - offset);
        if (count > 51)
            count = 51;
        r[3] = 0;
        r[7] = (uint8_t)count;
        put16(r + 10, (unsigned)bytes);
        memcpy(r + 12, io + offset, count);
        break;
    }
    case 2:
        if (slot >= MACRO_SLOTS || offset < MACRO_HEADER_SIZE + 2 || offset > MACRO_MAX_BYTES || count)
            break;
        stage_slot = slot;
        stage_size = (uint16_t)offset;
        stage_received = 0;
        memset(stage, 0, sizeof stage);
        r[3] = 0;
        break;
    case 3:
    case 9:
        if (!stage_size || stage_slot != (p[0] == 9 ? 255 : slot) || offset != stage_received || !count ||
            count > 57 || count > (unsigned)(stage_size - stage_received))
            break;
        memcpy(stage + offset, p + 6, count);
        stage_received += (uint16_t)count;
        r[3] = 0;
        break;
    case 4:
        if (stage_slot != slot || stage_size != stage_received || !macro_validate(stage, stage_size))
            break;
        if (engine.active && engine.slot == slot) {
            r[3] = 3;
            break;
        }
        if (!macro_storage_write(slot, stage, stage_size)) {
            r[3] = 2;
            break;
        }
        stage_size = stage_received = 0;
        r[3] = 0;
        break;
    case 5:
        if (slot >= MACRO_SLOTS)
            break;
        if (engine.active && engine.slot == slot)
            stop();
        r[3] = macro_storage_delete(slot) ? 0 : 2;
        break;
    case 6:
        if (offset > MACRO_BINDING_BYTES)
            break;
        count = MACRO_BINDING_BYTES - offset;
        if (count > 51)
            count = 51;
        memcpy(r + 12, engine.bindings + offset, count);
        put16(r + 10, MACRO_BINDING_BYTES);
        r[7] = (uint8_t)count;
        r[3] = 0;
        break;
    case 8:
        if (offset != MACRO_BINDING_BYTES || count)
            break;
        stage_slot = 255;
        stage_size = MACRO_BINDING_BYTES;
        stage_received = 0;
        memset(stage, 0, sizeof stage);
        r[3] = 0;
        break;
    case 10:
        if (stage_slot != 255 || stage_received != MACRO_BINDING_BYTES || stage_size != MACRO_BINDING_BYTES ||
            !macro_bindings_validate(stage, MACRO_BINDING_BYTES))
            break;
        if (!macro_storage_bindings_write(stage, MACRO_BINDING_BYTES)) {
            r[3] = 2;
            break;
        }
        macro_engine_set_bindings(&engine, stage, MACRO_BINDING_BYTES);
        outputs();
        stage_size = stage_received = 0;
        r[3] = 0;
        break;
    case 11:
        r[3] = !recording_mode && play(slot, 255, now()) ? 0 : 3;
        outputs();
        break;
    case 12:
        stop();
        r[3] = 0;
        break;
    case 15:
        if (offset > 1)
            break;
        recording_mode = offset == 1;
        record_heartbeat = now();
        stop();
        engine.input_valid = false;
        r[3] = 0;
        break;
    case 20:
        if (offset >= 126)
            break;
        count = 126 - offset;
        if (count > 51)
            count = 51;
        if (!offset) {
            memcpy(diagnostic_snapshot, raw_input, 63);
            memcpy(diagnostic_snapshot + 63, last_output, 63);
        }
        memcpy(r + 12, diagnostic_snapshot + offset, count);
        put16(r + 10, 126);
        r[7] = (uint8_t)count;
        r[3] = 0;
        break;
    case 21:
        if (offset >= LINK_DIAG_SIZE)
            break;
        if (!offset)
            link_diag_snapshot(link_snapshot);
        count = LINK_DIAG_SIZE - offset;
        if (count > 51)
            count = 51;
        memcpy(r + 12, link_snapshot + offset, count);
        put16(r + 10, LINK_DIAG_SIZE);
        r[7] = (uint8_t)count;
        r[3] = 0;
        break;
    default:
        break;
    }
done:
    publish(r);
}
