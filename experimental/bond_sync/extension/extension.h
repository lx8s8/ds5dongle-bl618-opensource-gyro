#pragma once
#include <stdint.h>
#include "lfs.h"
#include "bond_sync.h"
/* Versioned API provided by the root. This experiment must not be installed. */
typedef struct {
    uint32_t api_version;
    int (*read)(uint32_t address, uint8_t *data, uint32_t length);
    int (*write)(uint32_t address, const uint8_t *data, uint32_t length);
    int (*erase)(uint32_t address, uint32_t length);
} bond_extension_api;
typedef struct {
    lfs_t source, target;
    struct lfs_config src_config, dst_config;
    uint32_t src_address, dst_address;
    uint8_t src_read[512], src_prog[512], src_lookahead[256];
    uint8_t dst_read[512], dst_prog[512], dst_lookahead[256];
    bond_sync_workspace sync;
} bond_extension_workspace;
int bond_extension_extent_valid(lfs_block_t block, lfs_off_t offset, lfs_size_t length);
int bond_extension_run(const bond_extension_api *api, unsigned source_slot, bond_extension_workspace *workspace);
