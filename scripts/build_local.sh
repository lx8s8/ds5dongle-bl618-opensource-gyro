#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPS="${DS5_BUILD_DEPS:-${ROOT}/../.build-deps}"
TOOLCHAIN="${DEPS}/xuantie-2.10.2-macos-arm64/xuantie-gcc-riscv-v2.10.2-macos-arm64"

if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
    echo "This entry point requires macOS ARM64; see docs/CI_CN.md for Linux." >&2
    exit 1
fi
if [[ ! -x "${TOOLCHAIN}/bin/riscv64-unknown-elf-gcc" ||
      ! -x "${DEPS}/host/bin/gmake" || ! -x "${DEPS}/host-venv/bin/cmake" ]]; then
    echo "Run bash scripts/setup_macos.sh first." >&2
    exit 1
fi
export PATH="${DEPS}/host/bin:${DEPS}/host-venv/bin:${TOOLCHAIN}/bin:${PATH}"
export TOOLCHAIN_BIN="${TOOLCHAIN}/bin"
export BL_SDK_BASE="${BL_SDK_BASE:-${ROOT}/../bouffalo_sdk}"
export CMAKE_CMD="${DEPS}/host-venv/bin/cmake"
source "${ROOT}/.github/ci/dependencies.env"
if [[ "$(git -C "$BL_SDK_BASE" rev-parse HEAD)" != "$SDK_REF" ]]; then
    echo "SDK revision differs from .github/ci/dependencies.env" >&2
    exit 1
fi
cd "$ROOT"

case "${1:-build}" in
    build) exec bash build_macos.sh incremental ;;
    rebuild|clean) exec bash build_macos.sh "$1" ;;
    package)
        bash build_macos.sh incremental
        exec python3 scripts/package_firmware.py --board "${BOARD_TYPE:-lctech616}" --usb "${USB_SPEED:-hs}"
        ;;
    check)
        if ! command -v node >/dev/null 2>&1; then
            echo "Node.js is required for the WebHID protocol checks." >&2
            exit 1
        fi
        gmake -C tests check
        gmake -C tests sanitize
        exec python3 -m unittest discover -s tests -p 'test_pack*.py' -v
        ;;
    *) echo "Usage: bash scripts/build_local.sh [build|rebuild|clean|package|check]" >&2; exit 1 ;;
esac
