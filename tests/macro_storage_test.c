#include "bflb_mtd.h"
#include "lfs_port.h"
#include "macro_engine.h"
#include "macro_storage.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint8_t flash[0x71000];
static bool live, write_fail, close_fail, rename_fail;
static unsigned formats, writes;
static struct {
    char name[24];
    uint8_t data[4096];
    unsigned n;
    bool present;
} files[8];
static int find(const char *name) {
    for (int i = 0; i < 8; i++)
        if (files[i].present && !strcmp(name, files[i].name))
            return i;
    return -1;
}
int bflb_mtd_open(const char *name, int *h, int flags) {
    assert(!strcmp(name, "media"));
    *h = 1;
    return 0;
}
int bflb_mtd_info(int h, bflb_mtd_info_t *i) {
    i->offset = 0x378000;
    i->size = sizeof flash;
    return 0;
}
int bflb_mtd_close(int h) { return 0; }
int bflb_flash_read(uint32_t a, uint8_t *p, uint32_t n) {
    assert(a >= 0x378000 && a + n <= 0x3E9000);
    memcpy(p, flash + (a - 0x378000), n);
    return 0;
}
int lfs_xip_flash_read(const struct lfs_config *c, lfs_block_t b, lfs_off_t o, void *p, lfs_size_t n) {
    return 0;
}
int lfs_xip_flash_prog(const struct lfs_config *c, lfs_block_t b, lfs_off_t o, const void *p, lfs_size_t n) {
    assert(0);
    return 0;
}
int lfs_xip_flash_erase(const struct lfs_config *c, lfs_block_t b) {
    assert(0);
    return 0;
}
int lfs_xip_flash_sync(const struct lfs_config *c) { return 0; }
int lfs_mount(lfs_t *l, const struct lfs_config *c) { return live ? 0 : -1; }
int lfs_format(lfs_t *l, const struct lfs_config *c) {
    formats++;
    live = true;
    return 0;
}
int lfs_file_open(lfs_t *l, lfs_file_t *f, const char *n, int flags) {
    int i = find(n);
    if (i < 0) {
        if (!(flags & LFS_O_CREAT))
            return LFS_ERR_NOENT;
        for (i = 0; i < 8 && files[i].present; i++)
            ;
        assert(i < 8);
        strcpy(files[i].name, n);
        files[i].present = true;
    }
    f->index = i;
    f->pos = 0;
    f->flags = flags;
    if (flags & LFS_O_TRUNC)
        files[i].n = 0;
    return 0;
}
lfs_ssize_t lfs_file_read(lfs_t *l, lfs_file_t *f, void *p, lfs_size_t n) {
    if (n > files[f->index].n - f->pos)
        n = files[f->index].n - f->pos;
    memcpy(p, files[f->index].data + f->pos, n);
    f->pos += n;
    return n;
}
lfs_ssize_t lfs_file_write(lfs_t *l, lfs_file_t *f, const void *p, lfs_size_t n) {
    writes++;
    if (write_fail)
        return -1;
    assert(f->pos + n <= 4096);
    memcpy(files[f->index].data + f->pos, p, n);
    f->pos += n;
    files[f->index].n = f->pos;
    return n;
}
int lfs_file_close(lfs_t *l, lfs_file_t *f) { return close_fail ? -1 : 0; }
lfs_soff_t lfs_file_size(lfs_t *l, lfs_file_t *f) { return files[f->index].n; }
int lfs_mkdir(lfs_t *l, const char *n) {
    assert(!strcmp(n, "/gyro"));
    return 0;
}
int lfs_remove(lfs_t *l, const char *n) {
    int i = find(n);
    if (i < 0)
        return LFS_ERR_NOENT;
    files[i].present = false;
    return 0;
}
int lfs_rename(lfs_t *l, const char *a, const char *b) {
    if (rename_fail)
        return -1;
    int i = find(a);
    assert(i >= 0);
    int j = find(b);
    if (j >= 0)
        files[j].present = false;
    strcpy(files[i].name, b);
    return 0;
}
lfs_ssize_t lfs_fs_size(lfs_t *l) { return 4; }
int main(void) {
    memset(flash, 255, sizeof flash);
    flash[4] = 0;
    assert(!macro_storage_init(false) && !formats);
    assert(!macro_storage_init(true) && !formats); /* unknown data never formatted */
    flash[4] = 255;
    assert(macro_storage_init(true) && formats == 1);
    uint8_t blob[44] = {0x31, 0x43, 0x41, 0x4D, 1, 0, 1};
    blob[10] = 1;
    blob[36] = 3;
    blob[37] = 1;
    blob[38] = 1;
    blob[40] = 10;
    uint16_t crc = macro_crc16(blob, 42);
    blob[42] = crc;
    blob[43] = crc >> 8;
    assert(macro_storage_write(0, blob, sizeof blob));
    int old = find("/gyro/m00");
    assert(old >= 0);
    uint8_t saved[44];
    memcpy(saved, files[old].data, 44);
    unsigned before = writes;
    assert(macro_storage_write(0, blob, sizeof blob) && writes == before);
    blob[12] = 'A';
    crc = macro_crc16(blob, 42);
    blob[42] = (uint8_t)crc;
    blob[43] = (uint8_t)(crc >> 8);
    for (unsigned fault = 0; fault < 3; fault++) {
        write_fail = fault == 0;
        close_fail = fault == 1;
        rename_fail = fault == 2;
        assert(!macro_storage_write(0, blob, sizeof blob));
        old = find("/gyro/m00");
        assert(old >= 0 && !memcmp(files[old].data, saved, 44));
    }
    write_fail = close_fail = rename_fail = false;
    uint8_t read[4096];
    size_t n;
    assert(macro_storage_read(0, read, sizeof read, &n) && n == 44 && !memcmp(read, saved, 44));
    assert(macro_storage_delete(0));
    assert(macro_storage_read(0, read, sizeof read, &n) && !n);
    assert(!macro_storage_write(16, blob, sizeof blob));
    puts("macro storage: blank-only formatting, isolated file names, failed write/close/rename preserve old "
         "macro, readback and delete passed");
}
