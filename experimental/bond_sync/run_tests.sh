#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
sdk="${BL_SDK_BASE:-$root/../bouffalo_sdk}"
lfs="$sdk/components/fs/littlefs/littlefs"
test -f "$lfs/lfs.c"
out="$(mktemp -d "${TMPDIR:-/tmp}/ds5-bond-test.XXXXXX")"
trap 'rm -r "$out"' EXIT
common=(-std=c11 -O1 -Wall -Wextra -Werror -DLFS_NO_DEBUG -DLFS_NO_WARN -DLFS_NO_ERROR -DLFS_NO_MALLOC -I "$lfs" -I "$root/experimental/bond_sync")
"${CC:-cc}" "${common[@]}" "$root/experimental/bond_sync/bond_sync.c" "$root/experimental/bond_sync/test_bond_sync.c" "$lfs/lfs.c" "$lfs/lfs_util.c" -o "$out/sync-test"
"$out/sync-test"
"${CC:-cc}" "${common[@]}" "$root/experimental/bond_sync/bond_sync.c" "$root/experimental/bond_sync/extension/extension.c" "$root/experimental/bond_sync/test_extension.c" "$lfs/lfs.c" "$lfs/lfs_util.c" -o "$out/extension-test"
"$out/extension-test"
"${CC:-cc}" -std=c11 -O1 -Wall -Wextra -Werror -Wno-unused-parameter \
  -I "$root/boot/manager" -I "$root/experimental/bond_sync" \
  "$root/experimental/bond_sync/test_transition.c" "$root/experimental/bond_sync/transition.c" \
  "$root/boot/manager/boot_store.c" -o "$out/transition-test"
"$out/transition-test"
"${CC:-cc}" "${common[@]}" -Wno-unused-parameter -I "$root/boot/manager" \
  "$root/experimental/bond_sync/test_end_to_end.c" "$root/experimental/bond_sync/transition.c" \
  "$root/experimental/bond_sync/bond_sync.c" "$root/boot/manager/boot_store.c" "$lfs/lfs.c" "$lfs/lfs_util.c" -o "$out/end-to-end-test"
"$out/end-to-end-test"
"${CC:-cc}" -std=c11 -O1 -Wall -Wextra -Werror -I "$root/experimental/bond_sync" \
  "$root/experimental/bond_sync/test_assert_guard.c" "$root/experimental/bond_sync/extension/assert_guard.c" -o "$out/assert-guard-test"
"$out/assert-guard-test"
"${CC:-cc}" "${common[@]}" -DBOND_ENABLE_ASSERT_GUARD -include "$root/experimental/bond_sync/extension/lfs_assert_override.h" "$root/experimental/bond_sync/bond_sync.c" \
  "$root/experimental/bond_sync/extension/extension.c" "$root/experimental/bond_sync/extension/assert_guard.c" \
  "$root/experimental/bond_sync/test_extension.c" "$lfs/lfs.c" "$lfs/lfs_util.c" -o "$out/guarded-extension-test"
"$out/guarded-extension-test"
