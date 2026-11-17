import unittest
from scripts.check_manager_release_identity import check_identity


class ManagerReleaseIdentityTests(unittest.TestCase):
    def test_rejects_private_test_ids(self):
        for pid in (1, 2, 0x10):
            with self.subTest(pid=pid), self.assertRaises(ValueError):
                check_identity(f"USB_DEVICE_DESCRIPTOR_INIT(0x110,0,0,0,0x1209,{pid},0x100,1)")

    def test_accepts_non_test_identity_but_not_unparseable_descriptors(self):
        check_identity("USB_DEVICE_DESCRIPTOR_INIT(0x110,0,0,0,0x1209,0xd56b,0x100,1)")
        for source in ("", "USB_DEVICE_DESCRIPTOR_INIT(0x110,0,0,0,VID,PID,0x100,1)"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                check_identity(source)
