#!/usr/bin/env bash
# Isolated experimental build; no release artifact or hardware is modified.
# DS5_BOND_TEST_FAIL_PROG=1 intentionally produces a destructive fault injector.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
deps="${DS5_BUILD_DEPS:-$root/../.build-deps}"
export BL_SDK_BASE="${BL_SDK_BASE:-$root/../bouffalo_sdk}"
export PATH="$deps/host/bin:$deps/host-venv/bin:$deps/xuantie-2.10.2-macos-arm64/xuantie-gcc-riscv-v2.10.2-macos-arm64/bin:$PATH"
if [[ -n "${RISCV_TOOLCHAIN_BIN:-}" ]]; then export PATH="$RISCV_TOOLCHAIN_BIN:$PATH"; fi
source "$root/.github/ci/dependencies.env"
if [[ "$(git -C "$BL_SDK_BASE" rev-parse HEAD)" != "$SDK_REF" ]]; then
  echo 'SDK revision differs from the pinned version' >&2; exit 1
fi
export DS5_BOND_SOURCE_ROOT="$root"
export DS5_BOND_BUILD_DIR="${1:-/tmp/ds5-bond-guarded-build}"
mkdir -p "$DS5_BOND_BUILD_DIR/manager" "$DS5_BOND_BUILD_DIR/extension"
for f in CMakeLists.txt Makefile defconfig main.c boot_store.c boot_store.h usb_manager.c usb_manager.h usb_config.h quiet.c; do cp "$root/boot/manager/$f" "$DS5_BOND_BUILD_DIR/manager/$f"; done
# Optional diagnostic only: give the host more time to complete USB teardown.
if [[ "${DS5_TEST_USB_DELAY:-}" == 1 ]]; then
python3 - "$DS5_BOND_BUILD_DIR/manager/main.c" <<'PYCODE'
from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text();old='bflb_mtimer_delay_ms(100);bm_usb_stop();bflb_mtimer_delay_ms(20);'
assert s.count(old)==1;s=s.replace(old,'bflb_mtimer_delay_ms(750);bm_usb_stop();bflb_mtimer_delay_ms(250);');p.write_text(s)
PYCODE
fi
BOND_GUARD_CALL_ADDR=0xa0000000 BOND_ASSERT_FAIL_ADDR=0xa0000000 bash "$root/experimental/bond_sync/build_extension.sh" "$DS5_BOND_BUILD_DIR/extension"
python3 - "$DS5_BOND_BUILD_DIR" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);size=(p/'extension/extension.bin').stat().st_size
(p/'bond_extension_build.h').write_text('#define BOND_EXTENSION_SIZE %du\n#define BOND_EXTENSION_SHA256 {'%size+','.join(['0']*32)+'}\n')
(p/'initial_size').write_text(str(size))
PY
if command -v gmake >/dev/null 2>&1; then make_cmd=gmake; else make_cmd=make; fi
"$make_cmd" -C "$DS5_BOND_BUILD_DIR/manager" -j"${BUILD_JOBS:-8}" > "$DS5_BOND_BUILD_DIR/first-build.log" 2>&1 || { tail -40 "$DS5_BOND_BUILD_DIR/first-build.log"; exit 1; }
python3 - "$DS5_BOND_BUILD_DIR" <<'PY'
from pathlib import Path
import subprocess,sys
p=Path(sys.argv[1]);elf=p/'manager/build/build_out/ds5_boot_manager_bl616.elf'
s=subprocess.check_output(['riscv64-unknown-elf-nm','-n',str(elf)],text=True)
values={line.split()[-1]:int(line.split()[0],16) for line in s.splitlines() if len(line.split())==3 and line.split()[-1] in ('bond_guarded_call','bond_assert_failed')}
assert len(values)==2
(p/'guard_addresses').write_text('%x %x\n'%(values['bond_guarded_call'],values['bond_assert_failed']))
PY
read -r call_addr fail_addr < "$DS5_BOND_BUILD_DIR/guard_addresses"
BOND_GUARD_CALL_ADDR="0x$call_addr" BOND_ASSERT_FAIL_ADDR="0x$fail_addr" bash "$root/experimental/bond_sync/build_extension.sh" "$DS5_BOND_BUILD_DIR/extension"
python3 - "$DS5_BOND_BUILD_DIR" <<'PY'
from pathlib import Path
import hashlib,sys
p=Path(sys.argv[1]);data=(p/'extension/extension.bin').read_bytes();assert len(data)==int((p/'initial_size').read_text())
(p/'bond_extension_build.h').write_text('#define BOND_EXTENSION_SIZE %du\n#define BOND_EXTENSION_SHA256 {'%len(data)+','.join(str(c) for c in hashlib.sha256(data).digest())+'}\n')
PY
"$make_cmd" -C "$DS5_BOND_BUILD_DIR/manager" -j"${BUILD_JOBS:-8}" > "$DS5_BOND_BUILD_DIR/final-build.log" 2>&1 || { tail -40 "$DS5_BOND_BUILD_DIR/final-build.log"; exit 1; }
python3 - "$DS5_BOND_BUILD_DIR" "$root" <<'PY'
from pathlib import Path
import hashlib,struct,subprocess,sys,zlib
p=Path(sys.argv[1]);sys.path.insert(0,sys.argv[2]+'/scripts');from dual_firmware_plan import image,ROOT_LIMIT
elf=p/'manager/build/build_out/ds5_boot_manager_bl616.elf';nm=subprocess.check_output(['riscv64-unknown-elf-nm','-n',str(elf)],text=True)
expected=[int(x,16) for x in (p/'guard_addresses').read_text().split()]
actual={line.split()[-1]:int(line.split()[0],16) for line in nm.splitlines() if len(line.split())==3 and line.split()[-1] in ('bond_guarded_call','bond_assert_failed')}
if [actual.get('bond_guarded_call'),actual.get('bond_assert_failed')]!=expected: raise SystemExit('Guard addresses shifted; build rejected')
b=bytearray((p/'manager/build/build_out/ds5_boot_manager_bl616.bin').read_bytes());b=b[:0x1000]+bytearray(b'\xff'*0x1000)+b[0x1000:];struct.pack_into('<I',b,124,0x2000);struct.pack_into('<I',b,120,struct.unpack_from('<I',b,120)[0]&~((1<<16)|(1<<17)));n=struct.unpack_from('<I',b,132)[0];b[136:168]=hashlib.sha256(b[0x2000:0x2000+n]).digest();struct.pack_into('<I',b,252,zlib.crc32(b[:252]));b[0xfe0:0xff0]=b'DS5-DBM1-ROOT\0\0\0';image(b,ROOT_LIMIT,0x2000)
ext=(p/'extension/extension.bin').read_bytes();assert hashlib.sha256(ext).digest() in b
(p/'manager.bin').write_bytes(b);print('Experimental only: manager',len(b),'bytes; extension',len(ext),'bytes; guard symbols and SHA verified')
PY
node_cmd="${NODE_CMD:-$deps/node-v24.22.3-darwin-arm64/bin/node}"
if [[ ! -x "$node_cmd" ]]; then node_cmd="$(command -v node || true)"; fi
if [[ "${DS5_BOND_TEST_FAIL_PROG:-}" == 1 || "${DS5_BOND_TEST_POWER_WAIT:-}" == 1 ]]; then
  echo "Fault-injection build: package creation intentionally disabled"
elif [[ -n "$node_cmd" ]]; then
  "$node_cmd" --input-type=module - "$root" "$DS5_BOND_BUILD_DIR" <<'JS'
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const [root,out]=process.argv.slice(2),{makeBondPackage}=await import(pathToFileURL(root+'/experimental/bond_sync/package.mjs'));
const pkg=await makeBondPackage(new Uint8Array(await readFile(out+'/manager.bin')),new Uint8Array(await readFile(out+'/extension/extension.bin')));
await writeFile(out+'/bond-sync-experimental.bin',pkg);console.log('Experimental package:',pkg.length,'bytes');
JS
else
  echo 'Node unavailable: experimental package was not generated' >&2
fi
