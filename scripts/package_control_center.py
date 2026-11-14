#!/usr/bin/env python3
"""Build a portable source ZIP, or a self-contained app for this host."""
import argparse
import platform
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
        shutil.copytree(ROOT / 'desktop', root / 'desktop', ignore=shutil.ignore_patterns('__pycache__'))
        for n in ['启动控制中心.command', '启动控制中心.cmd', 'LICENSE', 'NOTICE']:
            shutil.copy2(ROOT / n, root / n)
        shutil.copy2(ROOT / 'docs/CONTROL_CENTER_CN.md', root / '使用说明.md')
        output.mkdir(parents=True, exist_ok=True)
        return shutil.make_archive(str(output / 'DS5-Control-Center-portable'), 'zip', tmp)


def freeze(output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean',
                        '--name', 'DS5-Control-Center', '--windowed', '--onedir',
                        '--add-data', str(ROOT / 'web') + ':web',
                        '--distpath', str(output), '--workpath', str(Path(tmp) / 'work'),
                        '--specpath', tmp, str(ROOT / 'desktop/launcher.py')], check=True)
    name = 'DS5-Control-Center.app' if sys.platform == 'darwin' else 'DS5-Control-Center'
    source = output / name
    if sys.platform == 'darwin':
        archive = output / ('DS5-Control-Center-macos-' + platform.machine().lower() + '.zip')
        subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(source), str(archive)], check=True)
        return str(archive)
    return shutil.make_archive(str(output / ('DS5-Control-Center-windows-' + platform.machine().lower())), 'zip', output, name)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--freeze', action='store_true')
    p.add_argument('--output', type=Path, default=ROOT / 'dist/control-center')
    a = p.parse_args()
    print(freeze(a.output) if a.freeze else package_source(a.output))
