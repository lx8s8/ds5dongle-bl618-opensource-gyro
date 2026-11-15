#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
/* All calls belong to usb_task; atomic rename preserves an existing file on
 * interrupted replacement. Never formats a nonblank, unmountable partition. */
bool macro_storage_init(bool create);
bool macro_storage_read(unsigned slot, uint8_t *out, size_t capacity, size_t *size);
bool macro_storage_write(unsigned slot, const uint8_t *p, size_t n);
bool macro_storage_delete(unsigned slot);
bool macro_storage_bindings_read(uint8_t *p, size_t n);
bool macro_storage_bindings_write(const uint8_t *p, size_t n);
uint32_t macro_storage_free(void);
