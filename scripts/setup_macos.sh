#!/usr/bin/env bash
# Install project-local build tools; do not change the user's shell settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "${ROOT}/.github/ci/dependencies.env"
DEPS="${DS5_BUILD_DEPS:-${ROOT}/../.build-deps}"
SDK="${BL_SDK_BASE:-${ROOT}/../bouffalo_sdk}"
if [[ "$(uname -sm)" != "Darwin arm64" ]]; then
    echo "This installer requires macOS ARM64 and Xcode Command Line Tools." >&2
    exit 1
fi
xcrun --find clang >/dev/null
mkdir -p "${DEPS}/downloads"
DEPS="$(cd "$DEPS" && pwd)"

download() {
    local url="$1" digest="$2" target="$3"
    if [[ ! -f "$target" ]] || [[ "$(shasum -a 256 "$target" | cut -d' ' -f1)" != "$digest" ]]; then
        curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 "$url" -o "${target}.part"
        echo "${digest}  ${target}.part" | shasum -a 256 -c -
        mv "${target}.part" "$target"
    fi
}

ARCHIVE="${DEPS}/downloads/${MACOS_ARM64_TOOLCHAIN_URL##*/}"
download "$MACOS_ARM64_TOOLCHAIN_URL" "$MACOS_ARM64_TOOLCHAIN_SHA256" "$ARCHIVE"
TOOLCHAIN_ROOT="${DEPS}/xuantie-2.10.2-macos-arm64"
if [[ ! -x "${TOOLCHAIN_ROOT}/xuantie-gcc-riscv-v2.10.2-macos-arm64/bin/riscv64-unknown-elf-gcc" ]]; then
    mkdir -p "$TOOLCHAIN_ROOT"
    tar -xf "$ARCHIVE" -C "$TOOLCHAIN_ROOT"
fi

if [[ ! -x "${DEPS}/host/bin/gmake" ]]; then
    # Build the small GNU Make dependency with Apple's make; no Homebrew required.
    MAKE_ARCHIVE="${DEPS}/downloads/make-4.4.1.tar.gz"
    download https://ftp.gnu.org/gnu/make/make-4.4.1.tar.gz \
        dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3 "$MAKE_ARCHIVE"
    mkdir -p "${DEPS}/src"
    tar -xf "$MAKE_ARCHIVE" -C "${DEPS}/src"
    (
        cd "${DEPS}/src/make-4.4.1"
        ./configure --prefix="${DEPS}/host" --program-prefix=g --disable-nls
        /usr/bin/make -j"${BUILD_JOBS:-8}"
        /usr/bin/make install
    )
fi

if [[ ! -x "${DEPS}/host-venv/bin/python3" ]]; then
    python3 -m venv "${DEPS}/host-venv"
fi
"${DEPS}/host-venv/bin/python3" -m pip install --disable-pip-version-check 'cmake==3.31.10'

if [[ ! -e "$SDK" ]]; then
    # Avoid downloading unrelated SDK demos and bundled Linux/Windows tools.
    git clone --depth=1 --filter=blob:none --no-checkout "https://github.com/${SDK_REPOSITORY}.git" "$SDK"
    git -C "$SDK" fetch --depth=1 --filter=blob:none origin "$SDK_REF"
    git -C "$SDK" sparse-checkout set --no-cone '/*' '!/docs/' '!/examples/' '!/tools/' \
        '/tools/bflb_tools/bflb_fw_post_proc/' '/tools/byai/' '/tools/kconfig/'
    git -C "$SDK" checkout --detach "$SDK_REF"
elif [[ "$(git -C "$SDK" rev-parse HEAD)" != "$SDK_REF" ]]; then
    echo "Existing SDK is at another revision. Set BL_SDK_BASE to a new directory." >&2
    exit 1
fi

"${DEPS}/host/bin/gmake" --version | head -1
"${DEPS}/host-venv/bin/cmake" --version | head -1
"${TOOLCHAIN_ROOT}/xuantie-gcc-riscv-v2.10.2-macos-arm64/bin/riscv64-unknown-elf-gcc" --version
echo "Ready: bash scripts/build_local.sh build"
