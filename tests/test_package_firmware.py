import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pack", PROJECT / "scripts/package_firmware.py")
pack = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pack)


class FirmwarePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / "sdk"
        self.build = self.root / "build/build_out"
        for name, data in {
            "build/.board_type": b"lctech616-fs\n",
            "build/generated/defconfig.cmake": (
                f"set(CONFIG_OVERRIDE_PTFILE {pack.PARTITION_TABLE})\n".encode()
            ),
            "build/build_out/ds5dongle_bl618_bl616.bin": b"fresh firmware",
            "build/build_out/partition.bin": b"partition",
            "build/build_out/boot2_test.bin": b"boot2",
            pack.PARTITION_TABLE: b"[pt_table]\n",
            "LICENSE": b"GPL",
            "NOTICE": b"Notices",
            "docs/GYRO_CN.md": b"Gyro guide",
            "docs/HARDWARE_TEST_CN.md": b"Hardware checklist",
            "lib/opus/LICENSE_PLEASE_READ.txt": b"Opus license",
            "sdk/LICENSE": b"Apache",
            ".github/ci/dependencies.env": (PROJECT / ".github/ci/dependencies.env").read_bytes(),
            "firmware/lctech616/ds5dongle-lctech616-hs.bin": b"stale HS firmware",
        }.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.sdk_commit = pack.dependency_pins(self.root)["SDK_REF"]
        revision = patch.object(
            pack, "git_head", side_effect=lambda path: self.sdk_commit if path == self.sdk else "a" * 40
        )
        revision.start()
        self.addCleanup(revision.stop)
        compiler = patch.object(pack, "compiler_version", return_value="T-Head GCC test")
        compiler.start()
        self.addCleanup(compiler.stop)
        dirty = patch.object(pack, "git_dirty", return_value=False)
        dirty.start()
        self.addCleanup(dirty.stop)

    def package(self, board="lctech616", usb="fs"):
        return pack.build_package(self.root, board, usb, self.sdk, self.root / "dist")

    def test_flashing_package_checksums_and_provenance(self):
        with zipfile.ZipFile(self.package()) as archive:
            prefix = "ds5dongle-lctech616-fs-aaaaaaaa/"
            contents = {name[len(prefix):]: archive.read(name) for name in archive.namelist()}
        self.assertEqual(contents["ds5dongle-lctech616.bin"], b"fresh firmware")
        self.assertNotIn("ds5dongle-lctech616-hs.bin", contents)
        self.assertEqual(contents["GYRO_CN.md"], b"Gyro guide")
        self.assertEqual(contents["HARDWARE_TEST_CN.md"], b"Hardware checklist")
        self.assertIn(b"filedir = ./boot2_test.bin", contents["flash_prog_cfg.ini"])
        self.assertNotIn(b"*", contents["flash_prog_cfg.ini"])
        info = json.loads(contents["build-info.json"])
        self.assertEqual(info["sdk_commit"], self.sdk_commit)
        self.assertEqual(info["source_commit"], "a" * 40)
        self.assertFalse(info["hardware_validated"])
        self.assertFalse(info["source_dirty"])
        checksums = contents["SHA256SUMS"].decode().splitlines()
        self.assertEqual(len(checksums), len(contents) - 1)
        for line in checksums:
            digest, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256(contents[name]).hexdigest(), digest)

    def test_hs_binary_and_board_are_unambiguous(self):
        for board in pack.BOARDS:
            with self.subTest(board=board):
                (self.root / "build/.board_type").write_text(f"{board}-hs\n")
                with zipfile.ZipFile(self.package(board, "hs")) as archive:
                    self.assertTrue(any(name.endswith(f"ds5dongle-{board}-hs.bin") for name in archive.namelist()))

    def test_native_compiler_uses_its_own_archive_pin(self):
        compiler = "riscv64-unknown-elf-gcc (XuanTie GNU Toolchain V2.10.2 macOS-arm64 rv32+rv64) 10.4.0"
        with patch.object(pack, "compiler_version", return_value=compiler):
            with zipfile.ZipFile(self.package()) as archive:
                info = json.loads(archive.read("ds5dongle-lctech616-fs-aaaaaaaa/build-info.json"))
        pins = pack.dependency_pins(self.root)
        self.assertEqual(info["toolchain_archive_sha256"], pins["MACOS_ARM64_TOOLCHAIN_SHA256"])
        self.assertEqual(info["toolchain_url"], pins["MACOS_ARM64_TOOLCHAIN_URL"])

    def test_unknown_compiler_does_not_claim_ci_archive(self):
        with zipfile.ZipFile(self.package()) as archive:
            info = json.loads(archive.read("ds5dongle-lctech616-fs-aaaaaaaa/build-info.json"))
        self.assertIsNone(info["toolchain_archive_sha256"])
        self.assertIsNone(info["toolchain_url"])

    def test_ci_compiler_keeps_linux_archive_pin(self):
        compiler = "riscv64-unknown-elf-gcc (Xuantie-900 elf newlib gcc Toolchain V2.6.1 B-20220906) 10.2.0"
        pins = pack.dependency_pins(self.root)
        self.assertEqual(pack.toolchain_provenance(pins, compiler),
                         (pins["TOOLCHAIN_URL"], pins["TOOLCHAIN_SHA256"]))

    def test_uncommitted_build_is_marked_and_has_distinct_filename(self):
        with patch.object(pack, "git_dirty", side_effect=lambda path: path == self.root):
            archive_path = self.package()
        self.assertIn("-dirty.zip", archive_path.name)
        with zipfile.ZipFile(archive_path) as archive:
            info = json.loads(archive.read("ds5dongle-lctech616-fs-aaaaaaaa-dirty/build-info.json"))
        self.assertTrue(info["source_dirty"])
        self.assertFalse(info["sdk_dirty"])

    def test_diagnostic_build_is_distinct_from_standard_package(self):
        flags = self.root / "build/CMakeFiles/app.dir/flags.make"
        flags.parent.mkdir(parents=True)
        flags.write_text("C_DEFINES = -DUSB_DIAGNOSTIC_IDENTITY=1\n")
        archive_path = self.package()
        self.assertIn("-hid-test-", archive_path.name)
        with zipfile.ZipFile(archive_path) as archive:
            info = json.loads(archive.read("ds5dongle-lctech616-fs-hid-test-aaaaaaaa/build-info.json"))
        self.assertEqual(info["usb_identity"], "private-hid-test")

    def test_rejects_wrong_board_or_speed(self):
        with self.assertRaisesRegex(ValueError, "requested"):
            self.package("aim61", "hs")

    def test_rejects_missing_or_empty_flash_inputs(self):
        for name in ("partition.bin", "ds5dongle_bl618_bl616.bin", "boot2_test.bin"):
            path = self.build / name
            original = path.read_bytes()
            path.write_bytes(b"")
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Missing or empty"):
                self.package()
            path.write_bytes(original)

    def test_rejects_ambiguous_boot2(self):
        (self.build / "boot2_stale.bin").write_bytes(b"old")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            self.package()

    def test_rejects_wrong_sdk(self):
        with patch.object(pack, "git_head", return_value="b" * 40):
            with self.assertRaisesRegex(ValueError, "SDK commit differs"):
                self.package()

    def test_rejects_secure_partition_build(self):
        (self.root / "build/generated/defconfig.cmake").write_text("set(CONFIG_PARTITION y)\n")
        with self.assertRaisesRegex(ValueError, "unencrypted"):
            self.package()

    def test_rejects_oversized_firmware(self):
        (self.build / "ds5dongle_bl618_bl616.bin").write_bytes(b"x" * (0x200000 + 1))
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            self.package()


if __name__ == "__main__":
    unittest.main()
