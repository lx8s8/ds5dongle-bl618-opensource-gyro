#include "transition.h"
int bond_transition(const bm_flash *flash, unsigned target, bm_record *record,
                    bond_transition_sync sync, void *ctx)
{
    uint8_t source;
    if (!flash || !record || !sync || target > 1 ||
        !bm_partition_active(flash, &source)) return -1;
    if (source != target && sync(ctx, source) < 0) return -2;
    if (!bm_select(flash, (uint8_t)target, record)) return -3;
    if (!bm_partition_select(flash, (uint8_t)target)) return -4;
    return 0;
}
