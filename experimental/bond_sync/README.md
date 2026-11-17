# Experimental pairing synchronization

This directory contains an experimental pairing-sync manager and extension. The ordinary manager does not include them; `build_guarded_manager.sh` builds a separate bundle. It has been tested on one LCTech 616 receiver and is not qualified for general hardware or interruption points. Its `1209:0001` USB identity is reserved for private testing; do not distribute it for public testing or use it on redistributed devices.

`bond_sync.c` copies only the 196-byte `link_key` file between mounted LittleFS PSM volumes. It validates both records and uses a temporary file plus atomic rename. A valid empty list propagates deletion; a missing source and existing destination returns a conflict. Other settings and macro partitions are untouched.

`transition.c` uses the validated partition view to choose the source and synchronizes before publishing the target slot. The guarded manager links it into both switch paths. `extension/assert_guard.c` guards LittleFS assertions with manager-owned RAM; the builder checks guard symbol addresses and the extension digest. Host tests cover interrupted writes, retry, deletion and re-pair in both directions.

The browser's experimental install, upgrade and recovery paths are in `web/bond-*.mjs`. They validate the package and layout, require a locally saved chip-bound backup before writing, and stage the extension before the root. Interrupting a root replacement can prevent normal boot; recovery requires BOOT ROM mode and the saved backup. See `docs/DUAL_FIRMWARE_CN.md` for the exact hardware coverage and remaining limits. Do not infer broad fault tolerance from one device or a few tested interruption points.

With the pinned SDK checked out next to the project, run all prototype tests using `bash experimental/bond_sync/run_tests.sh`. To run the base in-memory interruption test separately:

```sh
LFS=../bouffalo_sdk/components/fs/littlefs/littlefs
cc -std=c11 -O1 -Wall -Wextra -Werror -DLFS_NO_DEBUG -DLFS_NO_WARN -DLFS_NO_ERROR \
  -include experimental/bond_sync/host_compat.h \
  -I "$LFS" -I experimental/bond_sync experimental/bond_sync/bond_sync.c \
  experimental/bond_sync/test_bond_sync.c "$LFS/lfs.c" "$LFS/lfs_util.c" \
  -o /tmp/ds5-bond-sync-tests
/tmp/ds5-bond-sync-tests
```

Test fixtures use synthetic pairing records. Never log or upload real `link_key` bytes, controller addresses, complete PSM images or full-flash backups.
