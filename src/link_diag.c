/* Bounded link-event diagnostics inspired by DongleRE's diag ring. Contains
 * no controller address or pairing data; all contexts use a short IRQ guard. */
#include "link_diag.h"
#include "bflb_irq.h"
#include "bflb_mtimer.h"
#include <string.h>
static uint8_t records[24][16];
static uint32_t total;
static void p32(uint8_t *p, uint32_t n) {
    for (int i = 0; i < 4; i++)
        p[i] = (uint8_t)(n >> (i * 8));
}
void link_diag_note(uint8_t event, uint32_t value, uint32_t detail) {
    uint32_t time = (uint32_t)(bflb_mtimer_get_time_us() / 1000);
    uintptr_t irq = bflb_irq_save();
    uint8_t *p = records[total % 24];
    p32(p, time);
    p32(p + 4, event);
    p32(p + 8, value);
    p32(p + 12, detail);
    total++;
    bflb_irq_restore(irq);
}
void link_diag_snapshot(uint8_t out[LINK_DIAG_SIZE]) {
    uintptr_t irq = bflb_irq_save();
    memset(out, 0, LINK_DIAG_SIZE);
    memcpy(out, "BTL1", 4);
    p32(out + 4, total);
    unsigned count = total < 24 ? total : 24;
    p32(out + 8, count);
    for (unsigned i = 0; i < count; i++)
        memcpy(out + 16 + i * 16, records[(total - count + i) % 24], 16);
    bflb_irq_restore(irq);
}
