import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import hashlib
import zlib

SPEC = importlib.util.spec_from_file_location('dual', Path(__file__).resolve().parents[1] / 'scripts/dual_firmware_plan.py')
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)


def application(marker, offset=4096):
    payload = marker.ljust(8192, b'\xA5')
    header = bytearray(offset)
    header[:4] = b'BFNP'
    struct.pack_into('<IIII', header, 120, 256, offset, 0, len(payload))
    header[136:168] = hashlib.sha256(payload).digest()
    struct.pack_into('<I', header, 176, 0xA0000000)
    struct.pack_into('<I', header, 252, zlib.crc32(header[:252]))
    return bytes(header) + payload


def stock():
    names = ('Boot2', 'FW', 'mfg', 'media', 'PSM', 'KEY', 'DATA', 'factory')
    types = (16, 0, 10, 2, 3, 4, 5, 6)
    addresses = ((0, 0), (0x10000, 0x210000), (0x210000, 0), (0x378000, 0), (0x3E9000, 0), (0x3F1000, 0), (0x3F3000, 0), (0x3F8000, 0))
    sizes = ((0xE000, 0), (0x200000, 0x168000), (0x168000, 0), (0x71000, 0), (0x8000, 0), (0x2000, 0), (0x5000, 0), (0x8000, 0))
    entries = [dict(name=n, type=t, device=0, active=0, addresses=list(a), sizes=list(s), length=0, age=0)
               for n, t, a, s in zip(names, types, addresses, sizes)]
    b = bytearray(b'\xFF' * d.FLASH_SIZE)
    root = application(b'original Boot2', 8192)
    b[:len(root)] = root
    b[0xE000:0xF000] = d.encode_partition(entries)
    b[0x3E9000:0x3F8000] = b'\x42' * 0xF000
    b[0x3F8000:] = b'factory-data'.ljust(0x8000, b'\0')
    return bytes(b)


class DualFirmwarePlanTests(unittest.TestCase):
    def setUp(self):
        self.before = stock()
        self.manager = application(b'DS5 Boot Manager (experimental)',8192)
        self.manager = self.manager[:0xFE0] + b'DS5-DBM1-ROOT\0\0\0' + self.manager[0xFF0:]
        self.gyro = application(b'LCT616-DS5 3.18G2.4')
        self.upstream = application(b'LCT616-DS5 3.24H')

    def install(self, **kw):
        return d.install(self.before, self.manager, self.gyro, self.upstream, ('G2.4', '3.24H'), **kw)

    def test_isolated_banks_and_unchanged_application_bytes(self):
        upstream = bytearray(self.before)
        upstream[0x3E9000:0x3F8000] = b'\x91' * 0xF000
        after = self.install(upstream_snapshot=bytes(upstream))
        self.assertEqual(after[0x10000:0x10000 + len(self.gyro)], self.gyro)
        self.assertEqual(after[0x210000:0x210000 + len(self.upstream)], self.upstream)
        self.assertEqual(after[0x330000:0x33F000], b'\x42' * 0xF000)
        self.assertEqual(after[0x150000:0x1C1000], self.before[0x378000:0x3E9000])
        self.assertEqual(after[0x3E9000:0x3F8000], b'\x91' * 0xF000)
        self.assertEqual(after[0x3F8000:], self.before[0x3F8000:])
        _, entries = d.active_partition(after)
        self.assertNotIn('mfg', [e['name'] for e in entries])
        self.assertEqual(next(e for e in entries if e['name'] == 'PSM')['addresses'], [0x330000, 0x3E9000])

    def test_restore_original_boot_chain_and_selected_bank(self):
        after = bytearray(self.install())
        after[0x330000:0x33F000] = b'\x73' * 0xF000
        after[0x150000:0x1C1000] = b'\x27' * 0x71000
        for slot, fw, value in ((0, self.gyro, 0x73), (1, self.upstream, 0x42)):
            restored = d.restore(bytes(after), self.before, slot)
            self.assertEqual(restored[:0x10000], self.before[:0x10000])
            self.assertEqual(restored[0x10000:0x10000 + len(fw)], fw)
            self.assertEqual(restored[0x210000:0x378000], self.before[0x210000:0x378000])
            self.assertEqual(restored[0x3E9000:0x3F8000], bytes([value]) * 0xF000)
            self.assertEqual(restored[0x3F8000:], self.before[0x3F8000:])
            self.assertEqual(restored[0x378000:0x3E9000], bytes([0x27])*0x71000 if slot==0 else self.before[0x378000:0x3E9000])
            d.expected_stock(d.active_partition(restored)[1])

    def test_rejects_unsupported_images_layouts_and_corruption(self):
        with self.assertRaises(ValueError): d.install(self.before[:-1], self.manager, self.gyro, self.upstream, ('g', 'u'))
        for bad in (b'wrong', self.gyro + b'x' * 0x200000):
            with self.assertRaises(ValueError): d.image(bad, 0x200000)
        bad = bytearray(self.gyro); bad[-1] ^= 1
        with self.assertRaises(ValueError): d.image(bytes(bad), 0x200000)
        for offset, value in ((120, 260), (124, 8192), (176, 0x62000000)):
            bad = bytearray(self.gyro);struct.pack_into('<I', bad, offset, value);struct.pack_into('<I', bad, 252, zlib.crc32(bad[:252]))
            with self.assertRaises(ValueError): d.image(bytes(bad), 0x200000)
        after = bytearray(self.install());after[0x210000 + len(self.upstream) - 1] ^= 1
        with self.assertRaises(ValueError): d.restore(bytes(after), self.before)

    def test_restores_both_tables_even_when_old_secondary_has_higher_age(self):
        after = bytearray(self.install())
        _, entries = d.active_partition(after)
        for e in entries:
            if e['name'] in ('FW', 'PSM', 'KEY', 'DATA', 'media'): e['active'] = 1
        after[0xF000:0x10000] = d.encode_partition(entries, age=10)
        after[0xE000:0xF000] = self.before[0xE000:0xF000]
        # A typical updater replacing only PT0 still leaves PT1 selected.
        age, current = d.active_partition(bytes(after))
        self.assertEqual(age, 10)
        self.assertEqual(next(e for e in current if e['name'] == 'FW')['active'], 1)
        restored = d.restore(bytes(after), self.before, 1)
        self.assertEqual(restored[0xE000:0x10000], self.before[0xE000:0x10000])
        d.expected_stock(d.active_partition(restored)[1])
        after = bytearray(self.install());after[0x3F8000] ^= 1
        with self.assertRaises(ValueError): d.restore(bytes(after), self.before)

    def test_restore_plan_reconstructs_exact_expected_flash_root_last(self):
        after = self.install()
        for before, expected, operation in ((self.before, after, 'install'), (after, d.restore(after, self.before), 'restore')):
            with tempfile.TemporaryDirectory() as tmp:
                target = Path(tmp) / 'private'
                result = d.write_plan(before, expected, target, operation)
                self.assertFalse(result['hardware_qualified'])
                self.assertTrue(result['private_contains_pairing'])
                self.assertEqual(result['segments'][-1]['address'], 0)
                rebuilt = bytearray(before)
                for segment in result['segments']:
                    data = (target / segment['file']).read_bytes()
                    self.assertEqual(d.sha(data), segment['sha256'])
                    self.assertEqual(segment['address'] % 4096, 0)
                    rebuilt[segment['address']:segment['address'] + len(data)] = data
                self.assertEqual(bytes(rebuilt), expected)
                self.assertEqual((target / 'before-4MiB.bin').read_bytes(), before)
                with self.assertRaises(ValueError): d.write_plan(before, expected, target, operation)


if __name__ == '__main__':
    unittest.main(verbosity=2)
