#pragma once
#include "lfs.h"
struct lfs_context {
    lfs_t lfs;
    uint32_t flash_addr;
    char *partition_name;
};
int lfs_xip_flash_read(const struct lfs_config *, lfs_block_t, lfs_off_t, void *, lfs_size_t);
int lfs_xip_flash_prog(const struct lfs_config *, lfs_block_t, lfs_off_t, const void *, lfs_size_t);
int lfs_xip_flash_erase(const struct lfs_config *, lfs_block_t);
int lfs_xip_flash_sync(const struct lfs_config *);
