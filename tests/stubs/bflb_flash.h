#pragma once
#include <stdint.h>
int bflb_flash_read(uint32_t,uint8_t *,uint32_t);
int bflb_flash_write(uint32_t,uint8_t *,uint32_t);
int bflb_flash_erase(uint32_t,uint32_t);
