#!/usr/bin/env python3
"""Prepare private BL616 install/restore images. Never opens a hardware device.

Outputs contain pairing data and belong only on the owner's computer, never in
Releases. Root-manager ROM startup still requires hardware qualification.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

FLASH_SIZE = 0x400000
ROOT_LIMIT = 0xE000
SLOT_ADDRESS = (0x10000, 0x210000)
SLOT_CAPACITY = (0x200000, 0x120000)
DATA_ADDRESS = ((0x330000, 0x338000, 0x33A000), (0x3E9000, 0x3F1000, 0x3F3000))
DATA_LENGTH = (0x8000, 0x2000, 0x5000)
RECORD_ADDRESS = (0x340000, 0x341000)
PT_ADDRESS = (0xE000, 0xF000)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def partition(data):
    if len(data) < 596:
        raise ValueError('Partition table is truncated')
    magic, version, count, age, crc = struct.unpack_from('<IHHII', data)
    if magic != 0x54504642 or version != 0 or not 0 < count <= 16 or zlib.crc32(data[:12]) != crc:
        raise ValueError('Invalid partition header')
    end = 16 + count * 36
    if zlib.crc32(data[16:end]) != struct.unpack_from('<I', data, end)[0]:
        raise ValueError('Invalid partition entries CRC')
    entries = []
    for i in range(count):
        e = struct.unpack_from('<BBB9sIIIIII', data, 16 + i * 36)
        entries.append(dict(type=e[0], device=e[1], active=e[2], name=e[3].split(b'\0')[0].decode('ascii'),
                            addresses=list(e[4:6]), sizes=list(e[6:8]), length=e[8], age=e[9]))
    if len({e['name'] for e in entries}) != len(entries):
        raise ValueError('Duplicate partition names')
    return age, entries


def active_partition(flash):
    if len(flash) != FLASH_SIZE:
        raise ValueError('Expected a complete 4 MiB receiver readback')
    valid = []
    for address in PT_ADDRESS:
        try:
            age, entries = partition(flash[address:address + 4096])
            valid.append((age, entries, flash[address:address + 596]))
        except (ValueError, UnicodeDecodeError):
            pass
    if not valid:
        raise ValueError('No valid partition table')
    valid.sort(key=lambda p: p[0])
    if len(valid) == 2 and valid[0][0] == valid[1][0] and valid[0][2] != valid[1][2]:
        raise ValueError('Conflicting partition tables at the same generation')
    return valid[-1][:2]


def encode_partition(entries, age=0):
    body = b''.join(struct.pack('<BBB9sIIIIII', e['type'], e['device'], e['active'],
                   e['name'].encode('ascii').ljust(9, b'\0'), *e['addresses'], *e['sizes'], e['length'], e['age']) for e in entries)
    header = struct.pack('<IHHI', 0x54504642, 0, len(entries), age)
    return (header + struct.pack('<I', zlib.crc32(header)) + body + struct.pack('<I', zlib.crc32(body))).ljust(4096, b'\xFF')


def expected_stock(entries):
    required = {'FW': (0, [0x10000, 0x210000], [0x200000, 0x168000]),
                'PSM': (3, [0x3E9000, 0], [0x8000, 0]), 'KEY': (4, [0x3F1000, 0], [0x2000, 0]),
                'DATA': (5, [0x3F3000, 0], [0x5000, 0]), 'factory': (6, [0x3F8000, 0], [0x8000, 0])}
    by_name = {e['name']: e for e in entries}
    for name, (kind, addresses, sizes) in required.items():
        e = by_name.get(name)
        if not e or (e['type'], e['addresses'], e['sizes'], e['device'], e['active']) != (kind, addresses, sizes, 0, 0):
            raise ValueError('Unsupported original layout: ' + name)


def image(data, capacity, expected_offset=0x1000):
    if not 0x1004 <= len(data) <= capacity or data[:4] != b'BFNP':
        raise ValueError('Invalid image magic or size')
    flags, offset, aes_length, code_length = struct.unpack_from('<IIII', data, 120)
    if flags & 15 or not flags & 256 or offset != expected_offset or aes_length or not 4 <= code_length <= len(data) - offset:
        raise ValueError(f'Only unencrypted, unsigned, single-segment XIP images with a {expected_offset // 1024} KiB payload offset are supported')
    if struct.unpack_from('<I', data, 176)[0] != 0xA0000000:
        raise ValueError('Unsupported entry address')
    if zlib.crc32(data[:252]) != struct.unpack_from('<I', data, 252)[0]:
        raise ValueError('Image header CRC mismatch')
    if not flags & (1 << 17) and hashlib.sha256(data[offset:offset + code_length]).digest() != data[136:168]:
        raise ValueError('Image payload hash mismatch')
    return data


def record(images, versions, selected=0):
    b = bytearray(256)
    struct.pack_into('<4sHHIBB', b, 0, b'DBM1', 1, 256, 1, selected, 1)
    for i, (data, version) in enumerate(zip(images, versions)):
        v = version.encode('ascii')
        if not v or len(v) > 19 or b'\0' in v:
            raise ValueError('Version label must be 1–19 ASCII bytes')
        struct.pack_into('<III32s20s', b, 16 + 64 * i, SLOT_ADDRESS[i], SLOT_CAPACITY[i], len(data), hashlib.sha256(data).digest(), v)
    struct.pack_into('<I', b, 252, zlib.crc32(b[:252]))
    return bytes(b)


def read_record(flash):
    candidates = []
    for address in RECORD_ADDRESS:
        p = flash[address:address + 256]
        if len(p) != 256 or p[:8] != b'DBM1\x01\x00\x00\x01' or p[12] > 1 or p[13] != 1 or p[14] > 1 or p[15] or any(p[144:252]) or zlib.crc32(p[:252]) != struct.unpack_from('<I', p, 252)[0]:
            continue
        for i in range(2):
            a, cap, length = struct.unpack_from('<III', p, 16 + 64 * i)
            if (a, cap) != (SLOT_ADDRESS[i], SLOT_CAPACITY[i]) or not 0x1004 <= length <= cap:
                break
        else:
            candidates.append((struct.unpack_from('<I', p, 8)[0], p))
    if not candidates:
        raise ValueError('No valid dual-firmware metadata')
    candidates.sort()
    if len(candidates) == 2 and candidates[0][0] == candidates[1][0] and candidates[0][1] != candidates[1][1]:
        raise ValueError('Conflicting dual-firmware metadata')
    return candidates[-1][1]


def install(current, manager, gyro, upstream, versions, upstream_snapshot=None):
    _, entries = active_partition(current)
    expected_stock(entries)
    image(current[:ROOT_LIMIT], ROOT_LIMIT, 0x2000)
    image(manager, ROOT_LIMIT, 0x2000)
    images = (image(gyro, SLOT_CAPACITY[0]), image(upstream, SLOT_CAPACITY[1]))
    if b'DS5 Boot Manager (experimental)' not in manager or manager[0xFE0:0xFF0] != b'DS5-DBM1-ROOT\0\0\0':
        raise ValueError('Not a boot-manager build')
    for data in images:
        if b'LCT616-DS5 ' not in data or b'BL616 HID Test' in data:
            raise ValueError('Both applications must match LCTech and retain the standard controller identity')
    if upstream_snapshot is None:
        upstream_snapshot = current
    else:
        _, original_entries = active_partition(upstream_snapshot)
        expected_stock(original_entries)
        if upstream_snapshot[0x3F8000:] != current[0x3F8000:]:
            raise ValueError('Factory data differs: do not mix receiver snapshots')
    out = bytearray(current)
    out[:ROOT_LIMIT] = manager.ljust(ROOT_LIMIT, b'\xFF')
    for i, data in enumerate(images):
        a = SLOT_ADDRESS[i]
        n = (len(data) + 4095) & ~4095
        out[a:a + n] = data.ljust(n, b'\xFF')
    for j, length in enumerate(DATA_LENGTH):
        original = DATA_ADDRESS[1][j]
        out[DATA_ADDRESS[0][j]:DATA_ADDRESS[0][j] + length] = current[original:original + length]
        out[original:original + length] = upstream_snapshot[original:original + length]
    entries = [dict(e, addresses=e['addresses'][:], sizes=e['sizes'][:]) for e in entries if e['name'] != 'mfg']
    for e in entries:
        if e['name'] == 'FW':
            e['sizes'] = list(SLOT_CAPACITY)
        elif e['name'] in ('PSM', 'KEY', 'DATA'):
            j = ('PSM', 'KEY', 'DATA').index(e['name'])
            e['addresses'] = [DATA_ADDRESS[0][j], DATA_ADDRESS[1][j]]
            e['sizes'] = [DATA_LENGTH[j]] * 2
        e['active'] = 0
    pt = encode_partition(entries)
    for a in PT_ADDRESS:
        out[a:a + 4096] = pt
    meta = record(images, versions)
    for a in RECORD_ADDRESS:
        out[a:a + 4096] = meta.ljust(4096, b'\xFF')
    assert out[0x3F8000:] == current[0x3F8000:]
    return bytes(out)


def restore(current, original, slot=1):
    active_partition(current)
    _, original_entries = active_partition(original)
    expected_stock(original_entries)
    image(original[:ROOT_LIMIT], ROOT_LIMIT, 0x2000)
    if slot not in (0, 1) or current[0x3F8000:] != original[0x3F8000:]:
        raise ValueError('Invalid slot or receiver factory data differs')
    meta = read_record(current)
    a, _, length, digest = struct.unpack_from('<III32s', meta, 16 + slot * 64)
    firmware = image(current[a:a + length], SLOT_CAPACITY[0])
    if hashlib.sha256(firmware).digest() != digest:
        raise ValueError('Selected application image was changed or damaged')
    # The original prefix restores the original Boot2 and both PT sectors.
    # The original manufacturing region removes the manager records and the
    # auxiliary writable bank. Each bank is also archived by the CLI below.
    out = bytearray(current)
    out[:0x10000] = original[:0x10000]
    out[0x10000:0x210000] = firmware.ljust(0x200000, b'\xFF')
    out[0x210000:0x378000] = original[0x210000:0x378000]
    for j, length in enumerate(DATA_LENGTH):
        destination = DATA_ADDRESS[1][j]
        out[destination:destination + length] = current[DATA_ADDRESS[slot][j]:DATA_ADDRESS[slot][j] + length]
    assert out[0x3F8000:] == current[0x3F8000:]
    return bytes(out)


def write_plan(before, after, directory, operation):
    if directory.exists():
        raise ValueError('Output directory already exists; preserve previous recovery files')
    directory.mkdir(parents=True, mode=0o700)
    segments = []
    # Root first stage is installed LAST, after applications, data and tables.
    for start, end in ((0x10000, FLASH_SIZE), (0xE000, 0x10000), (0x1000, ROOT_LIMIT), (0, 0x1000)):
        address = start
        while address < end:
            if before[address:address + 4096] == after[address:address + 4096]:
                address += 4096
                continue
            finish = address + 4096
            while finish < end and before[finish:finish + 4096] != after[finish:finish + 4096]:
                finish += 4096
            data = after[address:finish]
            name = f'{len(segments):02d}-{address:06x}.bin'
            p = directory / name
            p.write_bytes(data)
            p.chmod(0o600)
            segments.append(dict(file=name, address=address, length=len(data), sha256=sha(data)))
            address = finish
    for name, data in (('before-4MiB.bin', before), ('expected-4MiB.bin', after)):
        p = directory / name
        p.write_bytes(data)
        p.chmod(0o600)
    plan = dict(format=1, operation=operation, hardware_qualified=False, private_contains_pairing=True,
                before_sha256=sha(before), expected_sha256=sha(after), flash_bytes=FLASH_SIZE, segments=segments)
    (directory / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
    (directory / 'README.txt').write_text('实验性离线迁移计划，未写入设备。包含配对密钥，仅保留在本机，不得上传 Releases。\n'
        '必须先验收启动管理器的 ROM 启动与双向跳转，再执行任何硬件写入。\n'
        '恢复单固件后使用原版 Boot2、分区表与选中的应用；另一个模式的数据保留在 before-4MiB.bin。\n')
    return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    ins = sub.add_parser('install')
    for name in ('snapshot', 'manager', 'gyro', 'upstream'):
        ins.add_argument('--' + name, type=Path, required=True)
    ins.add_argument('--upstream-snapshot', type=Path)
    ins.add_argument('--gyro-version', required=True)
    ins.add_argument('--upstream-version', required=True)
    rem = sub.add_parser('restore')
    rem.add_argument('--snapshot', type=Path, required=True)
    rem.add_argument('--original-snapshot', type=Path, required=True)
    rem.add_argument('--slot', type=int, choices=(0, 1), default=1)
    for cmd in (ins, rem):
        cmd.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    before = args.snapshot.read_bytes()
    if args.command == 'install':
        after = install(before, args.manager.read_bytes(), args.gyro.read_bytes(), args.upstream.read_bytes(),
                        (args.gyro_version, args.upstream_version), args.upstream_snapshot.read_bytes() if args.upstream_snapshot else None)
    else:
        after = restore(before, args.original_snapshot.read_bytes(), args.slot)
    result = write_plan(before, after, args.output, args.command)
    print(json.dumps({k: result[k] for k in ('operation', 'hardware_qualified', 'flash_bytes')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
