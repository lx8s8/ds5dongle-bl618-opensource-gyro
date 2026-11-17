#ifndef DS5_EXPERIMENTAL_BOND_TRANSITION_H
#define DS5_EXPERIMENTAL_BOND_TRANSITION_H
#include "boot_store.h"
/* Prototype only. Synchronize before publishing either selection or partition. */
typedef int (*bond_transition_sync)(void *ctx, unsigned source);
int bond_transition(const bm_flash *flash, unsigned target, bm_record *record,
                    bond_transition_sync sync, void *ctx);
#endif
