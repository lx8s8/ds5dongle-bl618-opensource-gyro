#!/usr/bin/env python3
"""Build a source ZIP or a small native app with embedded web assets."""
import argparse
import os
import platform
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def package_source(output):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / 'DS5-Control-Center'
        root.mkdir()
        shutil.copytree(ROOT / 'web', root / 'web')
        shutil.copytree(ROOT / 'desktop', root / 'desktop', ignore=shutil.ignore_patterns('__pycache__', 'target'))
        for n in ['启动控制中心.command', '启动控制中心.cmd', 'LICENSE', 'NOTICE']:
            shutil.copy2(ROOT / n, root / n)
        shutil.copy2(ROOT / 'docs/CONTROL_CENTER_CN.md', root / '使用说明.md')
        for name in ['DUAL_FIRMWARE_CN.md', 'GYRO_AXIS_ANALYSIS_CN.md']:
            shutil.copy2(ROOT / 'docs' / name, root / name)
        output.mkdir(parents=True, exist_ok=True)
        return shutil.make_archive(str(output / 'DS5-Control-Center-source'), 'zip', tmp)


def freeze(output):
    output.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'CARGO_TARGET_DIR': str(ROOT / 'build/control-center-native')}
    subprocess.run(['cargo', 'build', '--release', '--locked'], cwd=ROOT / 'desktop/native', env=env, check=True)
    binary = Path(env['CARGO_TARGET_DIR']) / 'release' / ('ds5-control-center.exe' if sys.platform == 'win32' else 'ds5-control-center')
    name = 'DS5-Control-Center.app' if sys.platform == 'darwin' else 'DS5-Control-Center'
    source = output / name
    if source.exists():
        shutil.rmtree(source)
    source.mkdir()
    if sys.platform == 'darwin':
        executable = source / 'Contents/MacOS/DS5-Control-Center'
        executable.parent.mkdir(parents=True)
        shutil.copy2(binary, executable)
        (source / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleExecutable': executable.name, 'CFBundleIdentifier': 'io.ds5.control-center',
            'CFBundleName': 'DS5 Control Center', 'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': '0.2.0', 'CFBundleVersion': '2',
            'LSMinimumSystemVersion': '11.0', 'LSUIElement': True,
        }))
        resources = source / 'Contents/Resources'
        resources.mkdir()
        license_dir = resources
    else:
        shutil.copy2(binary, source / 'DS5-Control-Center.exe')
        license_dir = source
    for n in ['LICENSE', 'NOTICE']:
        shutil.copy2(ROOT / n, license_dir / n)
    shutil.copy2(ROOT / 'docs/CONTROL_CENTER_CN.md', license_dir / '使用说明.md')
    for name in ['DUAL_FIRMWARE_CN.md', 'GYRO_AXIS_ANALYSIS_CN.md']:
        shutil.copy2(ROOT / 'docs' / name, license_dir / name)
    # Rust standard library is linked into the executable; include its licenses.
    for n in ['LICENSE-MIT', 'LICENSE-APACHE']:
        shutil.copy2(ROOT / 'desktop/native/licenses' / n, license_dir / ('RUST-' + n))
    if sys.platform == 'darwin':
        subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(source)], check=True)
        archive = output / ('DS5-Control-Center-macos-' + platform.machine().lower() + '.zip')
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(source), str(archive)], check=True)
        return str(archive)
    return shutil.make_archive(str(output / ('DS5-Control-Center-windows-' + platform.machine().lower())), 'zip', output, name)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--native', '--freeze', dest='native', action='store_true')
    p.add_argument('--output', type=Path, default=ROOT / 'dist/control-center')
    a = p.parse_args()
    print(freeze(a.output.resolve()) if a.native else package_source(a.output.resolve()))
