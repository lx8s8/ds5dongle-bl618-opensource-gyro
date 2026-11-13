#include "gyro_runtime.h"
#include "bt_hid_host.h"
#include "bflb_mtimer.h"
#include "diagnostics.h"
#include "debug_log.h"
#include "remap.h"
#include <stddef.h>
#include <string.h>

extern int bt_settings_set_bin(const char *, const uint8_t *, size_t);
extern int bt_settings_get_bin(const char *, uint8_t *, size_t, size_t *);

#define SLOT_COUNT 4
#define ACTION_COUNT 4
#define GLOBAL_SIZE 57
#define BANK_SIZE (8 + SLOT_COUNT * GYRO_CONFIG_SIZE + GLOBAL_SIZE + 4)
#define BANK_BODY (SLOT_COUNT * GYRO_CONFIG_SIZE + GLOBAL_SIZE)

static uint8_t bank[SLOT_COUNT][GYRO_CONFIG_SIZE], settings[GLOBAL_SIZE];
static uint8_t config_report[2][63], status_report[2][63], profile_report[2][63], diagnostic_report[2][63];
static volatile uint8_t published;
static uint8_t last_cmd, last_result, last_sequence, edit_slot, active_slot, manual_slot;
static uint8_t native_slot, dongle_slot, feedback, saved_record;
static bool was_connected, factory_loaded, paused, was_calibrating, was_active, state_saved, state_dirty, manual_dirty;
static volatile bool reset_requested;
static uint32_t generation, saved_crc, manual_changed, last_packet;
static struct {
    bool down, armed, fired, tap;
    uint32_t since, tapped_at;
} keys[ACTION_COUNT];

static uint16_t get16(const uint8_t *p) { return p[0] | ((uint16_t)p[1] << 8); }
static uint32_t get32(const uint8_t *p) { return get16(p) | ((uint32_t)get16(p + 2) << 16); }
static void put32(uint8_t *p, uint32_t n)
{
    for (int i = 0; i < 4; i++) p[i] = (uint8_t)(n >> (i * 8));
}
static uint32_t crc32(const uint8_t *p, size_t len)
{
    uint32_t crc = ~0u;
    while (len--) {
        crc ^= *p++;
        for (int i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1)));
    }
    return ~crc;
}
static void body(uint8_t *p)
{
    memcpy(p, bank, sizeof(bank)); memcpy(p + sizeof(bank), settings, sizeof(settings));
}
static uint32_t current_crc(void)
{
    uint8_t p[BANK_BODY]; body(p); return crc32(p, sizeof(p));
}
static bool valid_settings(const uint8_t *p)
{
    if (p[0] > 2 || p[1] >= SLOT_COUNT || p[2] > 1) return false;
    for (int i = 3; i < 9; i++) if (p[i] >= SLOT_COUNT && p[i] != 255) return false;
    for (int i = 0; i < ACTION_COUNT; i++) {
        const uint8_t *a = p + 9 + i * 12;
        if (a[0] > 6 || a[1] > 2 || a[2] >= SLOT_COUNT || (a[3] != 0 && a[3] != 1 && a[3] != 3) ||
            (get32(a + 8) & ~GYRO_BUTTON_MASK) || get16(a + 4) > 3000) return false;
        if (!a[0]) continue;
        if (!get32(a + 8) || !get16(a + 6) || get16(a + 6) > 400 ||
            (a[1] == 1 && !get16(a + 4)) || (a[0] == 6 && (a[1] == 2 || get16(a + 6) > 100))) return false;
        for (int j = 0; j < i; j++) {
            const uint8_t *b = p + 9 + j * 12;
            if (b[0] && get32(a + 8) == get32(b + 8)) return false;
        }
    }
    return true;
}
static bool valid_record(const uint8_t *p)
{
    if (memcmp(p, "GYR2", 4) || crc32(p, BANK_SIZE - 4) != get32(p + BANK_SIZE - 4)) return false;
    for (int i = 0; i < SLOT_COUNT; i++)
        if (!gyro_validate_config(p + 8 + i * GYRO_CONFIG_SIZE, GYRO_CONFIG_SIZE)) return false;
    return valid_settings(p + 8 + sizeof(bank));
}
static void notify(uint8_t flashes) { if (settings[2]) feedback = flashes; }
static void activate(uint8_t slot)
{
    if (active_slot == slot) return;
    active_slot = slot; paused = false; was_active = false;
    if (slot < SLOT_COUNT) {
        gyro_set_config(bank[slot], GYRO_CONFIG_SIZE);
        notify(slot + 1);
    } else gyro_reset_stream(false);
}
static uint8_t selected_slot(void)
{
    if (settings[0] == 1) return native_slot < SLOT_COUNT ? settings[3 + native_slot] : 255;
    if (settings[0] == 2) return dongle_slot < 2 ? settings[7 + dongle_slot] : 255;
    return manual_slot;
}
static void select_manual(uint8_t slot, uint32_t now)
{
    if (slot == manual_slot) return;
    manual_slot = slot; manual_dirty = true; manual_changed = now;
    if (!settings[0]) activate(slot);
}
static void publish(void)
{
    uint8_t next = published ^ 1;
    memset(config_report[next], 0, 63);
    memcpy(config_report[next], bank[edit_slot], GYRO_CONFIG_SIZE);
    config_report[next][40] = last_cmd; config_report[next][41] = last_result;
    config_report[next][42] = last_sequence; config_report[next][43] = 255;
    config_report[next][44] = edit_slot; config_report[next][45] = active_slot;
    config_report[next][46] = 2; config_report[next][47] = state_dirty;
    config_report[next][48] = paused;
    gyro_get_status(status_report[next]);
    memset(profile_report[next], 0, 63);
    profile_report[next][0] = 2; profile_report[next][1] = SLOT_COUNT;
    profile_report[next][2] = edit_slot; profile_report[next][3] = active_slot;
    memcpy(profile_report[next] + 4, settings, 9);
    profile_report[next][5] = manual_slot;
    memcpy(profile_report[next] + 15, settings + 9, ACTION_COUNT * 12);
    diagnostics_get(diagnostic_report[next]);
    diagnostic_report[next][1] = active_slot;
    __asm volatile("" ::: "memory");
    published = next;
}
static bool write_blob(const char *key, const uint8_t *p, size_t len)
{
    uint32_t start = (uint32_t)bflb_mtimer_get_time_us();
    bool ok = bt_settings_set_bin(key, p, len) == 0;
    diagnostics_save((uint32_t)bflb_mtimer_get_time_us() - start, ok);
    return ok;
}
static bool save_bank(void)
{
    settings[1] = manual_slot;
    if (state_saved && current_crc() == saved_crc && !manual_dirty) return true;
    uint8_t p[BANK_SIZE]; memcpy(p, "GYR2", 4); put32(p + 4, generation + 1);
    body(p + 8); put32(p + BANK_SIZE - 4, crc32(p, BANK_SIZE - 4));
    uint8_t next = state_saved ? saved_record ^ 1 : 0;
    if (!write_blob(next ? "gyro_bank_b_v2" : "gyro_bank_a_v2", p, sizeof(p))) return false;
    generation++; saved_record = next; state_saved = true;
    saved_crc = current_crc(); state_dirty = manual_dirty = false;
    return true;
}
void gyro_runtime_init(void)
{
    gyro_init(); diagnostics_init();
    last_cmd = last_result = last_sequence = edit_slot = 0;
    was_connected = factory_loaded = reset_requested = paused = was_calibrating = was_active = false;
    state_saved = manual_dirty = false; generation = saved_crc = last_packet = 0;
    native_slot = active_slot = 255; dongle_slot = manual_slot = feedback = 0;
    memset(keys, 0, sizeof(keys)); memset(settings, 0, sizeof(settings));
    settings[2] = 1;
    for (int i = 0; i < SLOT_COUNT; i++) { gyro_defaults(bank[i]); settings[3 + i] = (uint8_t)i; }
    settings[7] = 0; settings[8] = 1;
    uint8_t a[BANK_SIZE], b[BANK_SIZE]; size_t n = 0;
    bool va = bt_settings_get_bin("gyro_bank_a_v2", a, sizeof(a), &n) == 0 && n == sizeof(a) && valid_record(a);
    bool vb = bt_settings_get_bin("gyro_bank_b_v2", b, sizeof(b), &n) == 0 && n == sizeof(b) && valid_record(b);
    if (va || vb) {
        saved_record = vb && (!va || (int32_t)(get32(b + 4) - get32(a + 4)) > 0);
        const uint8_t *p = saved_record ? b : a;
        generation = get32(p + 4); memcpy(bank, p + 8, sizeof(bank));
        memcpy(settings, p + 8 + sizeof(bank), sizeof(settings));
        state_saved = true; saved_crc = current_crc();
    } else {
        uint8_t old[GYRO_CONFIG_SIZE];
        if (bt_settings_get_bin("gyro_cfg_v1", old, sizeof(old), &n) == 0 && n == sizeof(old) && gyro_set_config(old, sizeof(old))) {
            gyro_get_config(bank[0]);
            settings[0] = bank[0][35];
            if (settings[0]) {
                for (int i = 0; i < (settings[0] == 1 ? 4 : 2); i++)
                    settings[(settings[0] == 1 ? 3 : 7) + i] = (bank[0][36] & (1u << i)) ? 0 : 255;
                bank[0][35] = bank[0][36] = 0;
            }
        }
    }
    manual_slot = settings[1];
    uint8_t saved_slot[9];
    if (bt_settings_get_bin("gyro_slot_v2", saved_slot, sizeof(saved_slot), &n) == 0 && n == sizeof(saved_slot) &&
        get32(saved_slot) == generation && saved_slot[4] < SLOT_COUNT && crc32(saved_slot, 5) == get32(saved_slot + 5))
        manual_slot = saved_slot[4];
    state_dirty = !state_saved || current_crc() != saved_crc;
    activate(selected_slot()); feedback = 0; publish();
}
void gyro_runtime_poll(bool connected, uint32_t now_us)
{
    if (reset_requested || (!connected && was_connected)) {
        reset_requested = false; gyro_reset_stream(true); factory_loaded = false;
        paused = was_calibrating = was_active = false; native_slot = 255;
        active_slot = 255; memset(keys, 0, sizeof(keys)); last_packet = 0;
    }
    was_connected = connected;
    if (connected && !factory_loaded) {
        const uint8_t *data; uint16_t len;
        if (bt_hid_host_get_cached_feature(0x05, &data, &len)) {
            factory_loaded = true;
            if (!gyro_set_factory_calibration(data, len)) LOG_WRN("[GYRO] Invalid factory calibration\n");
        }
    }
    if (manual_dirty && (int32_t)(now_us - manual_changed) >= 1000000) {
        uint8_t p[9]; put32(p, generation); p[4] = manual_slot; put32(p + 5, crc32(p, 5));
        if (write_blob("gyro_slot_v2", p, sizeof(p))) manual_dirty = false;
        else manual_changed = now_us + 4000000u;
    }
    gyro_idle(now_us);
    uint8_t status[63]; gyro_get_status(status);
    if (was_calibrating && !(status[1] & 4) && (status[1] & (32 | 8)))
        notify(status[1] & 32 ? 4 : 3);
    was_calibrating = !!(status[1] & 4);
    publish();
}
void gyro_runtime_on_disconnect(void) { reset_requested = true; }
uint32_t gyro_runtime_shortcut_mask(const uint8_t *raw, bool edge)
{
    uint32_t pressed = gyro_buttons(raw, edge), suppress = 0;
    for (int i = 0; i < ACTION_COUNT; i++) {
        const uint8_t *a = settings + 9 + i * 12;
        uint32_t mask = get32(a + 8);
        if (a[0] && (a[3] == 3 || (a[3] == 1 && keys[i].armed && (pressed & mask) == mask))) suppress |= mask;
    }
    return suppress;
}
static uint32_t actions(uint32_t pressed, uint32_t now, uint16_t *fine)
{
    uint32_t suppress = 0;
    for (int i = 0; i < ACTION_COUNT; i++) {
        const uint8_t *a = settings + 9 + i * 12;
        if (!a[0]) continue;
        uint32_t mask = get32(a + 8);
        bool down = (pressed & mask) == mask, fire = false;
        if (keys[i].tap && now - keys[i].tapped_at > 300000) keys[i].tap = false;
        if (!down) {
            if (keys[i].down && keys[i].armed && !keys[i].fired && a[1] == 2 && now - keys[i].since <= 300000) {
                keys[i].tap = true; keys[i].tapped_at = now;
            }
            keys[i].down = keys[i].fired = false; keys[i].armed = true;
        } else {
            if (!keys[i].down) {
                keys[i].since = now; keys[i].fired = false;
                fire = keys[i].armed && (a[1] == 0 || (a[1] == 2 && keys[i].tap));
                if (fire) keys[i].tap = false;
            }
            if (a[1] == 1 && keys[i].armed && !keys[i].fired && now - keys[i].since >= (uint32_t)get16(a + 4) * 1000)
                fire = true;
            keys[i].down = true;
            if (a[0] == 6 && keys[i].armed && (a[1] == 0 || (a[1] == 1 && now - keys[i].since >= (uint32_t)get16(a + 4) * 1000)))
                if (get16(a + 6) < *fine) *fine = get16(a + 6);
        }
        if (a[3] == 3 || (a[3] == 1 && down && keys[i].armed)) suppress |= mask;
        if (!fire) continue;
        keys[i].fired = true;
        switch (a[0]) {
        case 1: if (!settings[0]) select_manual((manual_slot + 1) % SLOT_COUNT, now); break;
        case 2: if (!settings[0]) select_manual((manual_slot + SLOT_COUNT - 1) % SLOT_COUNT, now); break;
        case 3: if (!settings[0]) select_manual(a[2], now); break;
        case 4: paused = !paused; notify(paused ? 1 : 2); break;
        case 5: gyro_start_calibration(); notify(1); break;
        default: break;
        }
    }
    return suppress;
}
void gyro_runtime_process(const uint8_t *raw, uint8_t *out, uint32_t now_us, bool edge)
{
    uint32_t start = (uint32_t)bflb_mtimer_get_time_us();
    diagnostics_input(now_us);
    if (last_packet && now_us - last_packet > 100000) {
        memset(keys, 0, sizeof(keys)); paused = false;
    }
    last_packet = now_us;
    native_slot = edge && (raw[48] >> 4) >= 1 && (raw[48] >> 4) <= 4 ? (raw[48] >> 4) - 1 : 255;
    dongle_slot = remap_get_active_profile(); activate(selected_slot());
    uint16_t fine = 100;
    uint32_t suppress = actions(gyro_buttons(raw, edge), now_us, &fine);
    gyro_set_dongle_profile(dongle_slot);
    gyro_set_modifiers(paused || active_slot == 255, fine);
    gyro_process(raw, out, now_us, edge); gyro_suppress_buttons(out, suppress);
    uint8_t status[63]; gyro_get_status(status);
    if (was_calibrating && !(status[1] & 4) && (status[1] & (32 | 8)))
        notify(status[1] & 32 ? 4 : 3);
    if (!feedback && active_slot < SLOT_COUNT && bank[active_slot][2] == GYRO_TOGGLE && was_active != !!(status[1] & 2))
        notify(status[1] & 2 ? 2 : 1);
    was_calibrating = !!(status[1] & 4); was_active = !!(status[1] & 2);
    diagnostics_process((uint32_t)bflb_mtimer_get_time_us() - start); publish();
}
void gyro_runtime_command(const uint8_t *p, uint16_t len)
{
    if (len < 2) return;
    last_cmd = p[0]; last_sequence = p[1]; last_result = 0;
    switch (last_cmd) {
    case 1:
        if (len < 2 + GYRO_CONFIG_SIZE || !gyro_validate_config(p + 2, GYRO_CONFIG_SIZE)) { last_result = 1; break; }
        memcpy(bank[edit_slot], p + 2, GYRO_CONFIG_SIZE);
        if (bank[edit_slot][0] == 1) {
            bank[edit_slot][0] = 2; bank[edit_slot][37] = bank[edit_slot][4];
            bank[edit_slot][38] = 100; bank[edit_slot][39] = 0;
        }
        if (active_slot == edit_slot) gyro_set_config(bank[edit_slot], GYRO_CONFIG_SIZE);
        break;
    case 2: if (!save_bank()) last_result = 2; break;
    case 3: gyro_start_calibration(); notify(1); break;
    case 4:
        gyro_defaults(bank[edit_slot]);
        if (active_slot == edit_slot) gyro_set_config(bank[edit_slot], GYRO_CONFIG_SIZE);
        break;
    case 5: gyro_clear_calibration(); break;
    case 6:
        if (len < 3 || p[2] >= SLOT_COUNT) last_result = 1;
        else edit_slot = p[2];
        break;
    case 7:
        if (len < 3 || p[2] >= SLOT_COUNT || settings[0]) last_result = 1;
        else select_manual(p[2], (uint32_t)bflb_mtimer_get_time_us());
        break;
    case 8:
        if (len < 2 + GLOBAL_SIZE || !valid_settings(p + 2)) { last_result = 1; break; }
        memcpy(settings, p + 2, GLOBAL_SIZE); manual_slot = settings[1];
        memset(keys, 0, sizeof(keys)); paused = false; feedback = 0;
        activate(selected_slot());
        break;
    default: last_result = 1; break;
    }
    state_dirty = !state_saved || current_crc() != saved_crc;
    publish();
}
uint8_t gyro_runtime_take_feedback(void)
{
    uint8_t event = feedback; feedback = 0; return event;
}
void gyro_runtime_get_config(uint8_t out[GYRO_REPORT_SIZE]) { memcpy(out, config_report[published], 63); }
void gyro_runtime_get_status(uint8_t out[GYRO_REPORT_SIZE]) { memcpy(out, status_report[published], 63); }
void gyro_runtime_get_profiles(uint8_t out[GYRO_REPORT_SIZE]) { memcpy(out, profile_report[published], 63); }
void gyro_runtime_get_diagnostics(uint8_t out[GYRO_REPORT_SIZE]) { memcpy(out, diagnostic_report[published], 63); }
