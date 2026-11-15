#pragma once
#include <stdint.h>
typedef uint32_t lfs_size_t, lfs_block_t, lfs_off_t;
typedef int32_t lfs_ssize_t, lfs_soff_t;
typedef struct {
    int mounted;
} lfs_t;
typedef struct {
    int index;
    unsigned pos, flags;
} lfs_file_t;
struct lfs_config {
    void *context;
    int (*read)(const struct lfs_config *, lfs_block_t, lfs_off_t, void *, lfs_size_t);
    int (*prog)(const struct lfs_config *, lfs_block_t, lfs_off_t, const void *, lfs_size_t);
    int (*erase)(const struct lfs_config *, lfs_block_t);
    int (*sync)(const struct lfs_config *);
    uint32_t read_size, prog_size, lookahead_size, cache_size, block_size, block_cycles, block_count;
};
#define LFS_ERR_NOENT -2
#define LFS_ERR_EXIST -17
#define LFS_O_RDONLY 1
#define LFS_O_WRONLY 2
#define LFS_O_CREAT 4
#define LFS_O_TRUNC 8
int lfs_mount(lfs_t *, const struct lfs_config *);
int lfs_format(lfs_t *, const struct lfs_config *);
int lfs_file_open(lfs_t *, lfs_file_t *, const char *, int);
lfs_ssize_t lfs_file_read(lfs_t *, lfs_file_t *, void *, lfs_size_t);
lfs_ssize_t lfs_file_write(lfs_t *, lfs_file_t *, const void *, lfs_size_t);
int lfs_file_close(lfs_t *, lfs_file_t *);
lfs_soff_t lfs_file_size(lfs_t *, lfs_file_t *);
int lfs_mkdir(lfs_t *, const char *);
int lfs_rename(lfs_t *, const char *, const char *);
int lfs_remove(lfs_t *, const char *);
lfs_ssize_t lfs_fs_size(lfs_t *);
