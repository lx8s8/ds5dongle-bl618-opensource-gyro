#include "diagnostics.h"
#include <limits.h>
#include <string.h>

static struct {
    uint32_t inputs, last_input, interval_min, interval_max, interval_count;
    uint64_t interval_sum;
    uint32_t process_last, process_max, gaps, usb_busy, save_last, save_max, saves;
    uint16_t buckets[5];
    bool valid;
    uint8_t save_result;
} stats;
static volatile uint32_t queue_drops;
static volatile uint8_t queue_peak;

static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v)
{
    put16(p, (uint16_t)v); put16(p + 2, (uint16_t)(v >> 16));
}
static void increment(uint32_t *value) { if (*value != UINT32_MAX) (*value)++; }

void diagnostics_init(void)
{
    memset(&stats, 0, sizeof(stats));
    stats.interval_min = UINT32_MAX;
    queue_drops = queue_peak = 0;
}

void diagnostics_input(uint32_t now_us)
{
    increment(&stats.inputs);
    if (stats.valid) {
        uint32_t dt = now_us - stats.last_input;
        if (dt < stats.interval_min) stats.interval_min = dt;
        if (dt > stats.interval_max) stats.interval_max = dt;
        if (stats.interval_count != UINT32_MAX) {
            stats.interval_sum += dt;
            stats.interval_count++;
        }
        unsigned bucket = dt < 2000 ? 0 : dt < 5000 ? 1 : dt < 10000 ? 2 : dt < 20000 ? 3 : 4;
        if (stats.buckets[bucket] != UINT16_MAX) stats.buckets[bucket]++;
        if (dt > 50000) increment(&stats.gaps);
    }
    stats.last_input = now_us; stats.valid = true;
}

void diagnostics_process(uint32_t elapsed_us)
{
    stats.process_last = elapsed_us;
    if (elapsed_us > stats.process_max) stats.process_max = elapsed_us;
}
void diagnostics_usb_busy(void) { increment(&stats.usb_busy); }
void diagnostics_queue(bool accepted, uint8_t depth)
{
    if (!accepted && queue_drops != UINT32_MAX) queue_drops++;
    if (depth > queue_peak) queue_peak = depth;
}
void diagnostics_save(uint32_t elapsed_us, bool success)
{
    stats.save_last = elapsed_us;
    if (elapsed_us > stats.save_max) stats.save_max = elapsed_us;
    increment(&stats.saves); stats.save_result = success ? 1 : 2;
}
void diagnostics_get(uint8_t out[63])
{
    memset(out, 0, 63); out[0] = 2;
    put32(out + 2, stats.inputs);
    put32(out + 6, stats.valid && stats.interval_count ? stats.interval_min : 0);
    put32(out + 10, stats.interval_max);
    put32(out + 14, stats.interval_count ? (uint32_t)(stats.interval_sum / stats.interval_count) : 0);
    put32(out + 18, stats.process_max); put32(out + 22, stats.process_last);
    put32(out + 26, stats.gaps); put32(out + 30, stats.usb_busy);
    put32(out + 34, queue_drops); out[38] = queue_peak; out[39] = stats.save_result;
    put32(out + 40, stats.save_last); put32(out + 44, stats.save_max);
    for (int i = 0; i < 5; i++) put16(out + 48 + i * 2, stats.buckets[i]);
    put32(out + 58, stats.saves);
}
