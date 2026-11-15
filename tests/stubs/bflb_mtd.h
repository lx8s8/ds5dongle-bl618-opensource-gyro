#pragma once
#include <stdint.h>
typedef int bflb_mtd_handle_t;
typedef struct {
    uint32_t offset, size, xip_addr;
} bflb_mtd_info_t;
#define BFLB_MTD_OPEN_FLAG_BUSADDR 1
int bflb_mtd_open(const char *, bflb_mtd_handle_t *, int);
int bflb_mtd_info(bflb_mtd_handle_t, bflb_mtd_info_t *);
int bflb_mtd_close(bflb_mtd_handle_t);
