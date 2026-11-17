#!/usr/bin/env python3
"""Package one fresh board/USB build without picking up older firmware files."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

BOARDS = ("lctech616", "aim61", "m0sdock")
USB_SPEEDS = ("fs", "hs")
PARTITION_TABLE = "firmware/lctech616/partition_cfg_4M_nosec.toml"


def git_head(directory):
    return subprocess.check_output(
        ["git", "-C", str(directory), "rev-parse", "HEAD"], text=True
    ).strip()


def compiler_version():
    return subprocess.check_output(
        ["riscv64-unknown-elf-gcc", "--version"], text=True
    ).splitlines()[0]


def git_dirty(directory):
    # gen_bin rewrites these convenience configs for the selected USB speed.
    # Packages generate their own config and never consume those output files.
    return bool(subprocess.check_output(
        ["git", "-C", str(directory), "status", "--porcelain", "--untracked-files=normal",
         "--", ".", ":(exclude)firmware/*/flash_prog_cfg.ini"],
        text=True,
    ).strip())


def toolchain_provenance(pins, compiler):
    if "V2.10.2 macOS-arm64" in compiler:
        prefix = "MACOS_ARM64_"
    elif "V2.6.1" in compiler:
        prefix = ""
    else:
        # Do not attribute a custom compiler to the pinned CI archive.
        return None, None
    return pins[prefix + "TOOLCHAIN_URL"], pins[prefix + "TOOLCHAIN_SHA256"]


def dependency_pins(root):
    return dict(
        line.split("=", 1)
        for line in (root / ".github/ci/dependencies.env").read_text().splitlines()
        if line and not line.startswith("#")
    )


def require_file(path):
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f"Missing or empty package input: {path}")
    return path


def build_package(root, board, usb, sdk_root, output):
    if board not in BOARDS or usb not in USB_SPEEDS:
        raise ValueError("Unknown board or USB speed")
    stamp = require_file(root / "build/.board_type").read_text().strip()
    if stamp != f"{board}-{usb}":
        raise ValueError(f"Build is {stamp!r}, requested {board}-{usb}")
    generated = require_file(root / "build/generated/defconfig.cmake").read_text()
    if not re.search(
        r"set\(CONFIG_OVERRIDE_PTFILE\s+" + re.escape(PARTITION_TABLE) + r"\s*\)",
        generated,
    ):
        raise ValueError("Build did not select the unencrypted application partition table")

    build = root / "build/build_out"
    main = require_file(build / "ds5dongle_bl618_bl616.bin")
    if main.stat().st_size > 0x200000:
        raise ValueError("Firmware exceeds the 2 MiB FW partition")
    partition = require_file(build / "partition.bin")
    boot_files = list(build.glob("boot2_*.bin"))
    if len(boot_files) != 1:
        raise ValueError(f"Expected exactly one Boot2 binary, found {len(boot_files)}")
    boot = require_file(boot_files[0])
    pins = dependency_pins(root)
    commit = git_head(root)
    sdk_commit = git_head(sdk_root)
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Cannot identify the firmware source commit")
    if sdk_commit != pins["SDK_REF"]:
        raise ValueError("SDK commit differs from .github/ci/dependencies.env")

    diagnostic = any("USB_DIAGNOSTIC_IDENTITY=1" in p.read_text() for p in (root / "build").rglob("flags.make"))
    if diagnostic and os.environ.get("GITHUB_REF", "").startswith("refs/tags/v"):
        raise ValueError("Release firmware must preserve the Sony USB identity; private HID test builds cannot be published")
    dirty = git_dirty(root)
    compiler = compiler_version()
    toolchain_url, toolchain_digest = toolchain_provenance(pins, compiler)
    package_name = f"ds5dongle-{board}-{usb}{'-hid-test' if diagnostic else ''}-{commit[:8]}{'-dirty' if dirty else ''}"
    binary_name = f"ds5dongle-{board}{'-hs' if usb == 'hs' else ''}.bin"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f"{package_name}.zip"
    with tempfile.TemporaryDirectory() as temporary:
        package = Path(temporary) / package_name
        package.mkdir()
        for source, name in (
            (main, binary_name),
            (partition, "partition.bin"),
            (boot, boot.name),
            (root / PARTITION_TABLE, "partition_cfg_4M_nosec.toml"),
            (root / "LICENSE", "LICENSE"),
            (root / "NOTICE", "NOTICE"),
            (root / "lib/opus/LICENSE_PLEASE_READ.txt", "OPUS-LICENSE.txt"),
            (sdk_root / "LICENSE", "SDK-LICENSE"),
        ):
            shutil.copyfile(require_file(source), package / name)
        if (root / "web").is_dir():
            shutil.copytree(root / "web", package / "web")
        for guide in (root / "docs").glob("*.md"):
            shutil.copyfile(guide, package / guide.name)
        (package / "flash_prog_cfg.ini").write_text(
            "[cfg]\nerase = 1\nskip_mode = 0x0, 0x0\nboot2_isp_mode = 0\n\n"
            f"[boot2]\nfiledir = ./{boot.name}\naddress = 0x000000\n\n"
            "[partition]\nfiledir = ./partition.bin\naddress = 0xE000\n\n"
            f"[FW]\nfiledir = ./{binary_name}\naddress = @partition\n",
            encoding="utf-8",
        )
        metadata = {
            "board": board,
            "usb_speed": usb,
            "source_commit": commit,
            "source_dirty": dirty,
            "sdk_repository": pins["SDK_REPOSITORY"],
            "sdk_commit": sdk_commit,
            "sdk_dirty": git_dirty(sdk_root),
            "toolchain_url": toolchain_url,
            "toolchain_archive_sha256": toolchain_digest,
            "compiler": compiler,
            "built_at_utc": datetime.now(timezone.utc).isoformat(),
            "partition_table": PARTITION_TABLE,
            "hardware_validated": False,
            "usb_identity": "private-hid-test" if diagnostic else "standard",
        }
        repository = os.environ.get("GITHUB_REPOSITORY")
        run_id = os.environ.get("GITHUB_RUN_ID")
        if repository:
            metadata["source_url"] = f"https://github.com/{repository}/tree/{commit}"
            if run_id:
                metadata["build_url"] = f"https://github.com/{repository}/actions/runs/{run_id}"
        (package / "build-info.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (package / "刷机说明.txt").write_text(
            f"DS5Dongle 陀螺仪固件：{board} / USB {usb.upper()}\n"
            f"源码提交：{commit}\n\n"
            "请确认板型匹配。HS 为默认高速版本；如 USB 不稳定，可选择 FS 兼容版本。\n"
            "这是自动编译产物，未经过真实手柄和开发板测试。\n\n"
            "Bouffalo Lab Dev Cube：选择 BL616、MCU 模式；进入板子的串口下载模式。\n"
            "分区表选择 partition_cfg_4M_nosec.toml（FW 不加密），\n"
            f"Boot2 选择 {boot.name}，Firmware 选择 {binary_name}。\n"
            "支持 BLFlashCommand 的环境也可从本目录使用 flash_prog_cfg.ini。\n"
            "请勿用安全分区表替换本包分区表，勿整片擦除以免清除配对和设置。\n\n"
            "配置体感：python3 -m http.server 8765 --bind 127.0.0.1 --directory web\n"
            "桌面 Chrome / Edge 打开 http://127.0.0.1:8765/；体感映射默认关闭。\n"
            "网页刷写：在控制中心“固件与更新”页选择本 ZIP，按住 BOOT 插入后开始（Chrome / Edge）。\n\n"
            "build-info.json 记录 SDK 和工具链版本；SHA256SUMS 校验包内文件。\n"
            "Linux 校验：sha256sum -c SHA256SUMS\n"
            "macOS 校验：shasum -a 256 -c SHA256SUMS\n",
            encoding="utf-8",
        )
        files = sorted(path for path in package.rglob("*") if path.is_file())
        (package / "SHA256SUMS").write_text(
            "".join(
                f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(package).as_posix()}\n"
                for path in files
            ),
            encoding="utf-8",
        )
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zipped:
            for path in sorted(package.rglob("*")):
                if path.is_file():
                    zipped.write(path, path.relative_to(package.parent))
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--board", required=True, choices=BOARDS)
    parser.add_argument("--usb", required=True, choices=USB_SPEEDS)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    sdk_root = Path(os.environ.get("BL_SDK_BASE", str(root.parent / "bouffalo_sdk")))
    try:
        print(build_package(root, args.board, args.usb, sdk_root, args.output or root / "dist"))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")


if __name__ == "__main__":
    main()
