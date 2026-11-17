#include "bond_sync.h"
#include <stdbool.h>
#include <string.h>

#define KEY_PATH "/_ef4_kvs_/link_key"
/* Outside EasyFlash's namespace; never overwrites an application key. */
#define TEMP_PATH "/.ds5_bond_sync_v1"

static bool valid_record(const uint8_t *p)
{
    if (p[194] != 0xa6 || p[195] != 0xa5) return false;
    for (unsigned i = 0; i < 8; ++i) {
        if (p[184+i] > 1) return false;
        if (!p[184+i]) continue;
        bool zero = true;
        for (unsigned k = 0; k < 6; ++k) if (p[i*23+k]) zero = false;
        if (zero) return false;
        for (unsigned j = 0; j < i; ++j)
            if (p[184+j] && !memcmp(p+i*23, p+j*23, 6)) return false;
    }
    return true;
}

/* Missing is distinguishable from a valid empty list (all used flags zero).
 * This matters: a never-initialized or damaged source must not erase the
 * other slot's existing pairings. */
static int read_key(lfs_t *fs, uint8_t out[196], uint8_t cache[512])
{
    lfs_file_t file;
    struct lfs_file_config config = { .buffer = cache };
    int rc = lfs_file_opencfg(fs, &file, KEY_PATH, LFS_O_RDONLY, &config);
    if (rc == LFS_ERR_NOENT) return 0;
    if (rc < 0) return rc;
    lfs_soff_t size = lfs_file_size(fs, &file);
    if (size != 196) { lfs_file_close(fs, &file); return BOND_SYNC_FORMAT; }
    lfs_ssize_t got = lfs_file_read(fs, &file, out, 196);
    rc = lfs_file_close(fs, &file);
    if (got < 0) return (int)got;
    if (got != 196 || rc < 0) return rc < 0 ? rc : BOND_SYNC_FORMAT;
    return valid_record(out) ? 1 : BOND_SYNC_FORMAT;
}

int bond_sync_lfs(lfs_t *source, lfs_t *target, bond_sync_workspace *w)
{
    if (!source || !target || !w || source == target) return BOND_SYNC_FORMAT;
    int src = read_key(source, w->source, w->file_cache);
    if (src < 0) return src;
    int dst = read_key(target, w->target, w->file_cache);
    if (dst < 0) return dst;
    if (!src) return dst ? BOND_SYNC_CONFLICT : BOND_SYNC_OK;
    if (dst && !memcmp(w->source, w->target, 196)) return BOND_SYNC_OK;

    /* A leftover temporary file belongs solely to a previous interrupted
     * sync. The existing live record is left intact until atomic rename. */
    int rc = lfs_remove(target, TEMP_PATH);
    if (rc < 0 && rc != LFS_ERR_NOENT) return rc;
    lfs_file_t file;
    struct lfs_file_config config = { .buffer = w->file_cache };
    rc = lfs_file_opencfg(target, &file, TEMP_PATH, LFS_O_WRONLY | LFS_O_CREAT | LFS_O_EXCL, &config);
    if (rc < 0) return rc;
    lfs_ssize_t wrote = lfs_file_write(target, &file, w->source, 196);
    if (wrote != 196) { lfs_file_close(target, &file); return wrote < 0 ? (int)wrote : LFS_ERR_IO; }
    rc = lfs_file_sync(target, &file);
    if (rc < 0) { lfs_file_close(target, &file); return rc; }
    rc = lfs_file_close(target, &file);
    if (rc < 0) return rc;
    rc = lfs_rename(target, TEMP_PATH, KEY_PATH);
    if (rc < 0) return rc;
    dst = read_key(target, w->target, w->file_cache);
    return dst == 1 && !memcmp(w->source, w->target, 196) ? BOND_SYNC_CHANGED : BOND_SYNC_VERIFY;
}
