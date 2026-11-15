/* LittleFS macro storage adapted from DS5DongleRE/macro_store.c (GPL-3.0).
 * Uses our own directory, strict validation and atomic file replacement. */
#include "macro_storage.h"
#include "bflb_flash.h"
#include "bflb_mtd.h"
#include "lfs_port.h"
#include "macro_engine.h"
#include <string.h>

static struct lfs_context context = {.partition_name = "media"};
static struct lfs_config cfg = {.read_size = 256,
                                .prog_size = 256,
                                .lookahead_size = 256,
                                .cache_size = 512,
                                .block_size = 4096,
                                .block_cycles = 500};
static bool mounted, configured;
#ifdef LFS_THREADSAFE
static int lock_fs(const struct lfs_config *c) {
    (void)c;
    return 0;
} /* sole task owner */
#endif
bool macro_storage_init(bool create) {
    if (mounted)
        return true;
    if (!configured) {
        bflb_mtd_handle_t handle;
        bflb_mtd_info_t info;
        if (bflb_mtd_open("media", &handle, BFLB_MTD_OPEN_FLAG_BUSADDR) < 0)
            return false;
        memset(&info, 0, sizeof info);
        bflb_mtd_info(handle, &info);
        bflb_mtd_close(handle);
        if (!info.size || info.size % 4096)
            return false;
        context.flash_addr = info.offset;
        cfg.block_count = info.size / 4096;
        cfg.context = &context;
        cfg.read = lfs_xip_flash_read;
        cfg.prog = lfs_xip_flash_prog;
        cfg.erase = lfs_xip_flash_erase;
        cfg.sync = lfs_xip_flash_sync;
#ifdef LFS_THREADSAFE
        cfg.lock = cfg.unlock = lock_fs;
#endif
        configured = true;
    }
    if (lfs_mount(&context.lfs, &cfg) != 0) {
        if (!create)
            return false;
        uint8_t bytes[256];
        for (uint32_t a = 0; a < cfg.block_count * 4096; a += sizeof bytes) {
            if (bflb_flash_read(context.flash_addr + a, bytes, sizeof bytes))
                return false;
            for (unsigned j = 0; j < sizeof bytes; j++)
                if (bytes[j] != 255)
                    return false;
        }
        if (lfs_format(&context.lfs, &cfg) || lfs_mount(&context.lfs, &cfg))
            return false;
    }
    mounted = true;
    return true;
}
static void name(unsigned slot, char out[16]) {
    memcpy(out, "/gyro/m00", 10);
    out[7] = (char)('0' + slot / 10);
    out[8] = (char)('0' + slot % 10);
}
static bool read_file(const char *path, uint8_t *out, size_t capacity, size_t *size) {
    *size = 0;
    if (!macro_storage_init(false))
        return true; /* blank partition: empty directory */
    lfs_file_t f;
    int r = lfs_file_open(&context.lfs, &f, path, LFS_O_RDONLY);
    if (r == LFS_ERR_NOENT)
        return true;
    if (r)
        return false;
    lfs_soff_t n = lfs_file_size(&context.lfs, &f);
    bool ok = n >= 0 && (size_t)n <= capacity && lfs_file_read(&context.lfs, &f, out, (lfs_size_t)n) == n;
    if (lfs_file_close(&context.lfs, &f))
        ok = false;
    if (ok)
        *size = (size_t)n;
    return ok;
}
static bool write_file(const char *path, const uint8_t *p, size_t n) {
    if (!macro_storage_init(true))
        return false;
    lfs_file_t old;
    if (lfs_file_open(&context.lfs, &old, path, LFS_O_RDONLY) == 0) {
        bool same = lfs_file_size(&context.lfs, &old) == (lfs_soff_t)n;
        uint8_t chunk[128];
        for (size_t offset = 0; same && offset < n; offset += sizeof chunk) {
            size_t count = n - offset;
            if (count > sizeof chunk)
                count = sizeof chunk;
            same = lfs_file_read(&context.lfs, &old, chunk, (lfs_size_t)count) == (lfs_ssize_t)count &&
                   !memcmp(chunk, p + offset, count);
        }
        if (lfs_file_close(&context.lfs, &old))
            same = false;
        if (same)
            return true;
    }
    int r = lfs_mkdir(&context.lfs, "/gyro");
    if (r && r != LFS_ERR_EXIST)
        return false;
    const char *temp = "/gyro/staging";
    lfs_file_t f;
    if (lfs_file_open(&context.lfs, &f, temp, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_TRUNC))
        return false;
    bool ok = lfs_file_write(&context.lfs, &f, p, (lfs_size_t)n) == (lfs_ssize_t)n;
    if (lfs_file_close(&context.lfs, &f))
        ok = false;
    return ok && lfs_rename(&context.lfs, temp, path) == 0;
}
bool macro_storage_read(unsigned slot, uint8_t *out, size_t capacity, size_t *n) {
    if (slot >= MACRO_SLOTS)
        return false;
    char path[16];
    name(slot, path);
    return read_file(path, out, capacity, n);
}
bool macro_storage_write(unsigned slot, const uint8_t *p, size_t n) {
    if (slot >= MACRO_SLOTS || !macro_validate(p, n))
        return false;
    char path[16];
    name(slot, path);
    return write_file(path, p, n);
}
bool macro_storage_delete(unsigned slot) {
    if (slot >= MACRO_SLOTS)
        return false;
    if (!macro_storage_init(false))
        return true;
    char path[16];
    name(slot, path);
    int r = lfs_remove(&context.lfs, path);
    return r == 0 || r == LFS_ERR_NOENT;
}
bool macro_storage_bindings_read(uint8_t *p, size_t n) {
    size_t got;
    uint8_t record[MACRO_BINDING_BYTES + 2];
    if (n != MACRO_BINDING_BYTES || !read_file("/gyro/bindings", record, sizeof record, &got))
        return false;
    if (!got) {
        memset(p, 0, n);
        return true;
    }
    if (got != sizeof record || macro_crc16(record, n) != (uint16_t)(record[n] | (record[n + 1] << 8)) ||
        !macro_bindings_validate(record, n))
        return false;
    memcpy(p, record, n);
    return true;
}
bool macro_storage_bindings_write(const uint8_t *p, size_t n) {
    uint8_t record[MACRO_BINDING_BYTES + 2];
    if (!macro_bindings_validate(p, n))
        return false;
    memcpy(record, p, n);
    uint16_t crc = macro_crc16(p, n);
    record[n] = (uint8_t)crc;
    record[n + 1] = (uint8_t)(crc >> 8);
    return write_file("/gyro/bindings", record, sizeof record);
}
uint32_t macro_storage_free(void) {
    if (!macro_storage_init(false))
        return 0;
    lfs_ssize_t used = lfs_fs_size(&context.lfs);
    return used >= 0 && (uint32_t)used <= cfg.block_count ? (cfg.block_count - (uint32_t)used) * 4096 : 0;
}
