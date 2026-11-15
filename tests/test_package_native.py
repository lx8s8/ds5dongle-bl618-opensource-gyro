"""Exercise the real Windows packaging branch on every host without compiling Rust."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_control_center', ROOT / 'scripts/package_control_center.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class NativePackagingTests(unittest.TestCase):
    def test_windows_archive_keeps_application_directory_after_copying_guides(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ['LICENSE', 'NOTICE', 'docs/CONTROL_CENTER_CN.md', 'docs/DUAL_FIRMWARE_CN.md',
                         'docs/GYRO_AXIS_ANALYSIS_CN.md', 'desktop/native/licenses/LICENSE-MIT',
                         'desktop/native/licenses/LICENSE-APACHE']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            binary = root / 'build/control-center-native/release/ds5-control-center.exe'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'MZ' + b'fixture' * 300)
            output = root / 'dist'
            with patch.object(package, 'ROOT', root), patch.object(package.sys, 'platform', 'win32'), \
                 patch.object(package.platform, 'machine', return_value='AMD64'), patch.object(package.subprocess, 'run'):
                archive = package.freeze(output)
            with zipfile.ZipFile(archive) as packed:
                self.assertEqual(packed.read('DS5-Control-Center/DS5-Control-Center.exe'), binary.read_bytes())
                self.assertIn('DS5-Control-Center/GYRO_AXIS_ANALYSIS_CN.md', packed.namelist())
                self.assertIn('DS5-Control-Center/使用说明.md', packed.namelist())
            self.assertGreater(Path(archive).stat().st_size, 22)

    def test_empty_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'empty.zip'
            with zipfile.ZipFile(archive, 'w'):
                pass
            with self.assertRaises(ValueError):
                package.verify_archive(archive, 'DS5-Control-Center/DS5-Control-Center.exe')
