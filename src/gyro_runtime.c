#include "gyro_runtime.h"
#include "bt_hid_host.h"
#include "debug_log.h"
#include "remap.h"
#include <stddef.h>
#include <string.h>

extern int bt_settings_set_bin(const char *, const uint8_t *, size_t);
extern int bt_settings_get_bin(const char *, uint8_t *, size_t, size_t *);

static uint8_t config_report[2][GYRO_REPORT_SIZE];
static uint8_t status_report[2][GYRO_REPORT_SIZE];
static volatile uint8_t published;
static uint8_t last_cmd, last_result, last_sequence;
static bool was_connected, factory_loaded;
static volatile bool reset_requested;

static void publish(void)
{
    uint8_t next = published ^ 1;
    memset(config_report[next], 0, GYRO_REPORT_SIZE);
    gyro_get_config(config_report[next]);
    config_report[next][40] = last_cmd;
    config_report[next][41] = last_result;
    config_report[next][42] = last_sequence;
    config_report[next][43] = 0x0F; /* mouse, right stick, Edge sources, profile binding */
    gyro_get_status(status_report[next]);
    /* Compiler barrier: publish only after both buffers have been written.
     * usb_task is the sole writer; ISR reads cannot overlap a task write. */
    __asm volatile("" ::: "memory");
    published = next;
}

void gyro_runtime_init(void)
{
    last_cmd = last_result = last_sequence = 0;
    was_connected = factory_loaded = reset_requested = false;
    gyro_init();
    uint8_t saved[GYRO_CONFIG_SIZE];
    size_t len = 0;
    if (bt_settings_get_bin("gyro_cfg_v1", saved, sizeof(saved), &len) == 0 &&
        len == sizeof(saved) && !gyro_set_config(saved, sizeof(saved)))
        LOG_WRN("[GYRO] Invalid saved config, using defaults\n");
    publish();
}

void gyro_runtime_poll(bool connected, uint32_t now_us)
{
    if (reset_requested || (!connected && was_connected)) {
        reset_requested = false;
        gyro_reset_stream(true);
        factory_loaded = false;
    }
    was_connected = connected;
    if (connected && !factory_loaded) {
        const uint8_t *data;
        uint16_t len;
        if (bt_hid_host_get_cached_feature(0x05, &data, &len)) {
            factory_loaded = true;
            if (!gyro_set_factory_calibration(data, len))
                LOG_WRN("[GYRO] Invalid factory calibration, using 16 LSB/(deg/s)\n");
        }
    }
    gyro_idle(now_us);
    publish();
}

void gyro_runtime_on_disconnect(void) { reset_requested = true; }

void gyro_runtime_process(const uint8_t *raw, uint8_t *out, uint32_t now_us, bool edge)
{
    gyro_set_dongle_profile(remap_get_active_profile());
    gyro_process(raw, out, now_us, edge);
    publish();
}

void gyro_runtime_command(const uint8_t *p, uint16_t len)
{
    if (len < 2) return;
    last_cmd = p[0]; last_sequence = p[1]; last_result = 0;
    switch (last_cmd) {
    case 1: /* Apply to RAM; flash write is an explicit separate command. */
        if (len < 2 + GYRO_CONFIG_SIZE || !gyro_set_config(p + 2, GYRO_CONFIG_SIZE))
            last_result = 1;
        break;
    case 2: {
        uint8_t saved[GYRO_CONFIG_SIZE];
        gyro_get_config(saved);
        if (bt_settings_set_bin("gyro_cfg_v1", saved, sizeof(saved)) != 0)
            last_result = 2;
        break;
    }
    case 3: gyro_start_calibration(); break;
    case 4: {
        uint8_t defaults[GYRO_CONFIG_SIZE];
        gyro_defaults(defaults); gyro_set_config(defaults, sizeof(defaults));
        break;
    }
    case 5: gyro_clear_calibration(); break;
    default: last_result = 1; break;
    }
    publish();
}

void gyro_runtime_get_config(uint8_t *out)
{
    memcpy(out, config_report[published], GYRO_REPORT_SIZE);
}

void gyro_runtime_get_status(uint8_t *out)
{
    memcpy(out, status_report[published], GYRO_REPORT_SIZE);
}
