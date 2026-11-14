#!/usr/bin/env bash
set -euo pipefail
DS5_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DS5_DEPS="${DS5_BUILD_DEPS:-${DS5_ROOT}/../.build-deps}"
export BL_SDK_BASE="${BL_SDK_BASE:-${DS5_ROOT}/../bouffalo_sdk}"
export PATH="${DS5_DEPS}/host/bin:${DS5_DEPS}/host-venv/bin:${DS5_DEPS}/xuantie-2.10.2-macos-arm64/xuantie-gcc-riscv-v2.10.2-macos-arm64/bin:${PATH}"
source "${DS5_ROOT}/.github/ci/dependencies.env"
test "$(git -C "$BL_SDK_BASE" rev-parse HEAD)" = "$SDK_REF"
if command -v gmake >/dev/null 2>&1; then DS5_MAKE=gmake; else DS5_MAKE=make; fi
cd "${DS5_ROOT}/boot/manager"
"$DS5_MAKE" CMAKE="${CMAKE_CMD:-cmake}" -j"${BUILD_JOBS:-8}"
python3 - "${DS5_ROOT}" <<'PY'
import hashlib,json,sys,struct,zlib
from pathlib import Path
root=Path(sys.argv[1]);sys.path.insert(0,str(root/'scripts'))
from dual_firmware_plan import image,ROOT_LIMIT
data=bytearray((root/'boot/manager/build/build_out/ds5_boot_manager_bl616.bin').read_bytes())
image(data,ROOT_LIMIT)
# Keep the vendor's 8 KiB first-stage payload offset. Third-party SDKs read
# boot-stage version information at this fixed offset, independently of PT.
data=data[:0x1000]+bytearray(b'\xFF'*0x1000)+data[0x1000:]
struct.pack_into('<I',data,124,0x2000)
struct.pack_into('<I',data,120,struct.unpack_from('<I',data,120)[0]&~((1<<16)|(1<<17)))
# SDK builds may leave the image hash disabled with a placeholder digest.
# Populate it before enabling ROM verification and calculating the header CRC.
code_length=struct.unpack_from('<I',data,132)[0]
data[136:168]=hashlib.sha256(data[0x2000:0x2000+code_length]).digest()
struct.pack_into('<I',data,252,zlib.crc32(data[:252]))
image(data,ROOT_LIMIT,0x2000)
# Unsigned image's unused header padding, outside both header CRC and payload.
data[0xFE0:0xFF0]=b'DS5-DBM1-ROOT\0\0\0'
out=root/'dist/boot-manager';out.mkdir(parents=True,exist_ok=True)
(out/'ds5-boot-manager-lctech616-fs-experimental.bin').write_bytes(data)
(out/'build-info.json').write_text(json.dumps(dict(experimental=True,hardware_qualified=False,
 bytes=len(data),root_limit=ROOT_LIMIT,sha256=hashlib.sha256(data).hexdigest()),indent=2)+'\n')
print('Experimental root image:',len(data),'bytes; hardware qualification pending')
PY
