#include "dongle_control.h"
#include "config.h"
#include "remap.h"
#include "diagnostics.h"
#include "bflb_mtimer.h"
#include <stdbool.h>
#include <stddef.h>
#include <string.h>

static uint8_t cfg_report[2][63], remap_report[2][127];
static volatile uint8_t published;
static uint8_t read_profile, last_report, last_command, last_result, last_sequence;
static bool config_saved;
static struct config_body saved_config;
#ifdef DS5_BOOT_MANAGER_CLIENT
extern bool boot_manager_request(void);
#else
static bool boot_manager_request(void){return false;}
#endif
_Static_assert(sizeof(struct config_body) <= 40, "config overlaps command acknowledgement");

void dongle_control_publish(void)
{
    uint8_t next = published ^ 1;
    memset(cfg_report[next], 0, 63); memset(remap_report[next], 0, 127);
    memcpy(cfg_report[next], config_get(), sizeof(struct config_body));
    cfg_report[next][40] = last_command; cfg_report[next][41] = last_result;
    cfg_report[next][42] = last_sequence; cfg_report[next][43] = last_report;
    remap_report[next][0] = remap_get_active_profile(); remap_report[next][1] = read_profile;
    memcpy(remap_report[next] + 2, remap_get_profile_table(read_profile), REMAP_BTN_COUNT * sizeof(remap_entry_t));
    __asm volatile("" ::: "memory"); published = next;
}
void dongle_control_init(void)
{
    read_profile = last_report = last_command = last_result = last_sequence = 0;
    config_saved = false; dongle_control_publish();
}
static bool save_config(void)
{
    if (config_saved && !memcmp(&saved_config, config_get(), sizeof(saved_config))) return true;
    uint32_t start = (uint32_t)bflb_mtimer_get_time_us();
    bool ok = config_save();
    diagnostics_save((uint32_t)bflb_mtimer_get_time_us() - start, ok);
    if (ok) { saved_config = *config_get(); config_saved = true; }
    return ok;
}
uint8_t dongle_control_command(uint8_t rid, const uint8_t *p, uint16_t len)
{
    uint8_t effects = 0;
    last_report = rid; last_command = len && p ? p[0] : 0; last_result = 1; last_sequence = 0;
    if (!p || !len || (rid == 0xF6 && len > 63) || (rid == 0xFB && len > 127)) goto done;
    if (len == (rid == 0xFB ? 127 : 63)) last_sequence = p[len - 1];
    if (rid == 0xF6) {
        if (p[0] == 1 && len >= 1 + offsetof(struct config_body, tp_mode) && (p[1] == 1 || p[1] == 2)) {
            config_set(p + 1, len - 1); effects = DONGLE_CONFIG_CHANGED; last_result = 0;
        } else if (p[0] == 2 || p[0] == 3) {
            last_result = save_config() ? 0 : 2;
            if (!last_result && p[0] == 3) effects = DONGLE_RESET;
        } else if (p[0] == 4 && len == 63) {
            last_result = boot_manager_request() ? 0 : 1;
            if (!last_result) effects = DONGLE_RESET;
        }
    } else if (rid == 0xFB) {
        uint8_t profile = len >= 2 ? p[1] : remap_get_active_profile();
        if (p[0] == 1) {
            uint16_t bytes = 0, offset = 2;
            if (len == 127 || len == 126) bytes = REMAP_BTN_COUNT * sizeof(remap_entry_t);
            else if (len == 94) bytes = REMAP_OLD_BTN_COUNT * sizeof(remap_entry_t);
            else if (len == 93 || len == 125) { offset = 1; profile = 0; bytes = len - 1; }
            if (bytes && profile < REMAP_PROFILE_COUNT) {
                remap_set_profile(profile, p + offset, (uint8_t)bytes);
                last_result = remap_save_profile(profile) ? 0 : 2;
            }
        } else if (p[0] == 2 && profile < REMAP_PROFILE_COUNT) {
            remap_reset_profile(profile); last_result = remap_save_profile(profile) ? 0 : 2;
        } else if (p[0] == 3 && len >= 2 && profile < REMAP_PROFILE_COUNT) {
            read_profile = profile; last_result = 0;
        } else if (p[0] == 5 && len >= 2 && profile < REMAP_PROFILE_COUNT) {
            remap_switch_profile(profile); last_result = 0;
        }
    }
done:
    dongle_control_publish(); return effects;
}
uint16_t dongle_control_get(uint8_t rid, uint8_t *out)
{
    uint8_t current = published;
    if (rid == 0xF7) { memcpy(out, cfg_report[current], 63); return 63; }
    if (rid == 0xFB) { memcpy(out, remap_report[current], 127); return 127; }
    return 0;
}
