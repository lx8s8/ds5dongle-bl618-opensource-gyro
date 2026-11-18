#!/usr/bin/env bash
# Experimental artifact only: do not install or distribute.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
sdk="${BL_SDK_BASE:-$root/../bouffalo_sdk}"
deps="${DS5_BUILD_DEPS:-$root/../.build-deps}"
if [[ -n "${RISCV_TOOLCHAIN_BIN:-}" ]]; then
  tools="$RISCV_TOOLCHAIN_BIN"
elif command -v riscv64-unknown-elf-gcc >/dev/null 2>&1; then
  tools="$(dirname "$(command -v riscv64-unknown-elf-gcc)")"
else
  tools="$deps/xuantie-2.10.2-macos-arm64/xuantie-gcc-riscv-v2.10.2-macos-arm64/bin"
fi
lfs="$sdk/components/fs/littlefs/littlefs"
out="${1:-/tmp/ds5-bond-extension-build}"
mkdir -p "$out"
cc="$tools/riscv64-unknown-elf-gcc"
objcopy="$tools/riscv64-unknown-elf-objcopy"
size="$tools/riscv64-unknown-elf-size"
common=(-march=rv32imafcpzpsfoperand_xtheade -mabi=ilp32f -mtune=e907 -Os -flto -fshort-enums -ffreestanding -fno-builtin -fno-common -ffunction-sections -fdata-sections -DLFS_NO_DEBUG -DLFS_NO_WARN -DLFS_NO_ERROR -DLFS_NO_MALLOC -I "$lfs" -I "$root/experimental/bond_sync")
link_guard=()
if [[ -n "${BOND_GUARD_CALL_ADDR:-}" && -n "${BOND_ASSERT_FAIL_ADDR:-}" ]]; then
  common+=(-DBOND_ENABLE_ASSERT_GUARD -include "$root/experimental/bond_sync/extension/lfs_assert_override.h")
  link_guard=(-Wl,--defsym,bond_guarded_call="$BOND_GUARD_CALL_ADDR" -Wl,--defsym,bond_assert_failed="$BOND_ASSERT_FAIL_ADDR")
elif [[ -n "${BOND_GUARD_CALL_ADDR:-}" || -n "${BOND_ASSERT_FAIL_ADDR:-}" ]]; then
  echo 'Both manager guard addresses are required' >&2; exit 1
else
  common+=(-DLFS_NO_ASSERT)
fi
"$cc" "${common[@]}" "${link_guard[@]}" -nostdlib -Wl,--gc-sections -Wl,-u,memcpy,-u,memset -Wl,-T,"$root/experimental/bond_sync/extension/link.ld" \
  "$root/experimental/bond_sync/extension/extension.c" "$root/experimental/bond_sync/extension/libc.c" \
  "$root/experimental/bond_sync/bond_sync.c" "$lfs/lfs.c" "$lfs/lfs_util.c" -lgcc -o "$out/extension.elf"
"$size" "$out/extension.elf"
# The extension executes from flash and has no private writable storage.
# Guard state must be owned by the manager, never placed in the XIP region.
size_fields=$("$size" "$out/extension.elf" | tail -n 1)
read -r text_size data_size bss_size remainder <<< "$size_fields"
if [[ "$data_size" != 0 || "$bss_size" != 0 ]]; then
  echo 'Extension has writable sections; refusing to produce a binary' >&2; exit 1
fi
"$objcopy" -O binary "$out/extension.elf" "$out/extension.bin"
python3 - "$out/extension.bin" <<'PY'
from pathlib import Path
import hashlib,sys
p=Path(sys.argv[1]); b=p.read_bytes()
if not b or len(b)>0x4000: raise SystemExit('extension size outside experimental region')
print(f'Experimental extension: {len(b)} bytes; sha256 {hashlib.sha256(b).hexdigest()}')
PY
