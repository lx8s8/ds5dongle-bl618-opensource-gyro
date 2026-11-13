#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "${ROOT}/.github/ci/dependencies.env"
INSTALL_DIR="${ROOT}/.deps/toolchain"
if [[ "$(uname -sm)" != "Linux x86_64" ]]; then
    echo "This installer requires Linux x86_64 (GitHub Actions ubuntu-22.04)." >&2
    exit 1
fi

if [[ ! -f "${INSTALL_DIR}/.archive-sha256" ]] ||
   [[ "$(cat "${INSTALL_DIR}/.archive-sha256")" != "$TOOLCHAIN_SHA256" ]]; then
    if [[ -e "$INSTALL_DIR" ]]; then
        echo "Toolchain cache has unexpected contents: ${INSTALL_DIR}" >&2
        exit 1
    fi
    STAGING_DIR="$(mktemp -d)"
    trap 'rm -rf "$STAGING_DIR"' EXIT
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
        "$TOOLCHAIN_URL" -o "${STAGING_DIR}/toolchain.tar.xz"
    echo "${TOOLCHAIN_SHA256}  ${STAGING_DIR}/toolchain.tar.xz" | sha256sum --check --strict
    mkdir -p "${STAGING_DIR}/unpacked" "${ROOT}/.deps"
    tar -xJf "${STAGING_DIR}/toolchain.tar.xz" -C "${STAGING_DIR}/unpacked"
    mv "${STAGING_DIR}/unpacked" "$INSTALL_DIR"
    echo "$TOOLCHAIN_SHA256" > "${INSTALL_DIR}/.archive-sha256"
fi

COMPILER="$(find "$INSTALL_DIR" -path '*/bin/riscv64-unknown-elf-gcc' -print -quit)"
if [[ -z "$COMPILER" || ! -x "$COMPILER" ]]; then
    echo "Pinned archive does not contain riscv64-unknown-elf-gcc" >&2
    exit 1
fi
"$COMPILER" --version
if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "${COMPILER%/*}" >> "$GITHUB_PATH"
else
    echo "Add ${COMPILER%/*} to PATH before building."
fi
