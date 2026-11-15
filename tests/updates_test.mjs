import assert from 'node:assert/strict';
import { compareVersions, createLocalDownloader, findUpdate, parseDeviceVersion, parseReleaseTag, verifyDigest } from '../web/updates.mjs';
import { bootManagerAssets, fetchVerifiedAsset, findLatestReleaseAsset, releaseAssets } from '../web/releases.mjs';

assert.deepEqual(parseDeviceVersion('LCT616-DS5 3.18G2.4RC4'), { board: 'lctech616', usb: 'fs', g: [2, 4], rc: 4 });
assert.deepEqual(parseDeviceVersion('LCT616-DS5 3.18G2.4RC4H\0\0'), { board: 'lctech616', usb: 'hs', g: [2, 4], rc: 4 });
assert.deepEqual(parseDeviceVersion('BL618-DS5 3.5G2.1.1T'), { board: 'aim61', usb: null, g: [2, 1, 1], rc: null });
assert.equal(parseDeviceVersion('M0S-DS5 3.5G2.2').board, 'm0sdock');
for (const bad of ['', '读取失败', '未连接', 'LCT616-DS5 3.24H', 'XYZ-DS5 3.18G2.4']) assert.equal(parseDeviceVersion(bad), null);
assert.deepEqual(parseReleaseTag('v3.18-g2.4-rc4'), { g: [2, 4], rc: 4 });
assert.deepEqual(parseReleaseTag('v3.18-g2.1.1'), { g: [2, 1, 1], rc: null });
assert.equal(parseReleaseTag('nightly'), null);

const v = tag => parseReleaseTag(tag);
const order = ['v3.18-g2.1', 'v3.18-g2.1.1', 'v3.18-g2.2', 'v3.18-g2.4-rc1', 'v3.18-g2.4-rc4', 'v3.18-g2.4'];
for (let i = 0; i < order.length; i++) for (let j = 0; j < order.length; j++) assert.equal(compareVersions(v(order[i]), v(order[j])), Math.sign(i - j), order[i] + ' vs ' + order[j]);

const asset = (name, extra = {}) => ({ name, size: 10, browser_download_url: 'https://github.com/x/y/releases/download/t/' + name, ...extra });
const releases = [
  { tag_name: 'v3.18-g2.2', assets: [asset('ds5dongle-lctech616-fs-a.zip'), asset('ds5dongle-lctech616-hs-a.zip')] },
  { tag_name: 'v3.18-g2.4-rc4', assets: [asset('ds5dongle-lctech616-fs-b.zip'), asset('ds5dongle-lctech616-hs-b.zip'), asset('ds5dongle-aim61-fs-b.zip')] },
  { tag_name: 'v3.18-g2.1.1', assets: [asset('ds5dongle-lctech616-fs-c.zip')] },
  { tag_name: 'weird', assets: [asset('ds5dongle-lctech616-fs-z.zip')] },
];
const pick = (board, usb) => r => releaseAssets(r, board, usb);
let found = findUpdate(releases, parseDeviceVersion('LCT616-DS5 3.18G2.2'), pick('lctech616', 'fs'));
assert.equal(found.release.tag_name, 'v3.18-g2.4-rc4'); assert.equal(found.newer, true); assert.equal(found.asset.name, 'ds5dongle-lctech616-fs-b.zip');
found = findUpdate(releases, parseDeviceVersion('LCT616-DS5 3.18G2.4RC4H'), pick('lctech616', 'hs'));
assert.equal(found.newer, false); assert.equal(found.asset.name, 'ds5dongle-lctech616-hs-b.zip');
assert.equal(findUpdate(releases, parseDeviceVersion('LCT616-DS5 3.18G2.4RC1'), pick('lctech616', 'fs')).newer, true);
assert.equal(findUpdate(releases, parseDeviceVersion('M0S-DS5 3.5G2.2'), pick('m0sdock', 'fs')), null);
assert.equal(findUpdate(releases, parseDeviceVersion('BL618-DS5 3.5G2.4RC4'), pick('aim61', 'fs')).newer, false);

const bytes = new TextEncoder().encode('hello');
const digest = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
assert.equal(await verifyDigest(bytes, digest), true);
assert.equal(await verifyDigest(bytes, undefined), false);
await assert.rejects(verifyDigest(bytes, digest.replace('2cf2', '0000')), /不一致/);
await assert.rejects(verifyDigest(bytes, 'md5:abc'), /不支持/);

const calls = [];
const fetcher = async (url, init) => {
  calls.push([url, init]);
  if (url === '/api/local') return { ok: true, json: async () => ({ application: 'DS5 Control Center', token: 'tok' }) };
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
};
const download = await createLocalDownloader(fetcher);
assert.deepEqual([...await download({ repo: 'a/b', tag: 'v1', name: 'x.zip' })], [...bytes]);
assert.equal(calls[1][0], '/api/download?repo=a%2Fb&tag=v1&name=x.zip');
assert.equal(calls[1][1].method, 'POST'); assert.equal(calls[1][1].headers['X-Session-Token'], 'tok');
assert.equal(await createLocalDownloader(async () => ({ ok: false })), null);
assert.equal(await createLocalDownloader(async () => { throw new Error('offline'); }), null);
assert.equal(await createLocalDownloader(async () => ({ ok: true, json: async () => ({ application: 'other' }) })), null);

// Boot Manager & Upstream asset selection + shared verified download tests
const mgrRelease = {
  tag_name: 'v3.18-g2.4-rc6', prerelease: true, published_at: '2026-11-15T11:14:12Z',
  assets: [
    asset('ds5-boot-manager-lctech616-fs-experimental.bin'),
    asset('ds5-boot-manager-lctech616-hs-experimental.bin'),
    asset('ds5-boot-manager-aim61-fs-experimental.bin'),
    asset('ds5dongle-lctech616-fs-b1657ab3.zip'),
  ],
};
assert.deepEqual(bootManagerAssets(mgrRelease, 'lctech616', 'fs').map(a => a.name), ['ds5-boot-manager-lctech616-fs-experimental.bin']);
const mgrFallback = findLatestReleaseAsset([mgrRelease], {
  includePrerelease: false, allowPrereleaseFallback: true,
  pickAssets: r => bootManagerAssets(r, 'lctech616', 'fs'),
});
assert.equal(mgrFallback.asset.name, 'ds5-boot-manager-lctech616-fs-experimental.bin');
assert.equal(mgrFallback.prereleaseFallback, true);

const upstreamReleases = [
  { tag_name: 'v3.25-rc1', prerelease: true, published_at: '2026-11-12T00:00:00Z', assets: [asset('ds5dongle-bl618-lctech616-v3.25-rc1.zip')] },
  { tag_name: 'v3.22', prerelease: false, published_at: '2026-10-23T18:32:07Z', assets: [asset('ds5dongle-bl618-lctech616-v3.22.zip')] },
  { tag_name: 'v3.24', prerelease: false, published_at: '2026-11-09T12:55:54Z', assets: [asset('ds5dongle-bl618-lctech616-v3.24.zip')] },
];
const upLatest = findLatestReleaseAsset(upstreamReleases, {
  includePrerelease: false, allowPrereleaseFallback: true,
  pickAssets: r => releaseAssets(r, 'lctech616', 'fs', true),
});
assert.equal(upLatest.release.tag_name, 'v3.24');
assert.equal(upLatest.asset.name, 'ds5dongle-bl618-lctech616-v3.24.zip');
assert.equal(upLatest.prereleaseFallback, false);

const ghAsset = {
  name: 'ds5-boot-manager-lctech616-fs-experimental.bin', size: bytes.length, digest,
  browser_download_url: 'https://github.com/lx8s8/ds5dongle-bl618-opensource-gyro/releases/download/v3.18-g2.4-rc6/ds5-boot-manager-lctech616-fs-experimental.bin',
};
const verifiedResult = await fetchVerifiedAsset({
  repo: 'lx8s8/ds5dongle-bl618-opensource-gyro', release: mgrRelease, asset: ghAsset,
  downloader: download, openFallback: () => { throw new Error('unexpected browser fallback'); },
});
assert.equal(verifiedResult.verified, true);
assert.deepEqual([...verifiedResult.bytes], [...bytes]);
const openedUrls = [];
await assert.rejects(
  fetchVerifiedAsset({
    repo: 'lx8s8/ds5dongle-bl618-opensource-gyro', release: mgrRelease, asset: ghAsset,
    downloader: null, manualHint: '并选择该文件', openFallback: u => openedUrls.push(u),
  }),
  /打开下载页/
);
assert.deepEqual(openedUrls, [ghAsset.browser_download_url]);
console.log('updates: version parsing, ordering, release selection, digest check and local downloader passed');
