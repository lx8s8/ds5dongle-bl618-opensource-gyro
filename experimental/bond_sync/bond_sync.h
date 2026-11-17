#pragma once
#include <stdint.h>
#include "lfs.h"

/* Experimental, not linked into firmware. The caller must mount the two
 * isolated PSM volumes and call this before committing the slot change. */
typedef struct {
    uint8_t source[196];
    uint8_t target[196];
    uint8_t file_cache[512];
} bond_sync_workspace;

enum { BOND_SYNC_OK = 0, BOND_SYNC_CHANGED = 1, BOND_SYNC_CONFLICT = -1000, BOND_SYNC_FORMAT = -1001, BOND_SYNC_VERIFY = -1002 };
int bond_sync_lfs(lfs_t *source, lfs_t *target, bond_sync_workspace *workspace);
