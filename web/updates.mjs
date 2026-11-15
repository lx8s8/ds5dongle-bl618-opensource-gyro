// Firmware version detection and release selection for the update page.
const BOARDS = { LCT616: 'lctech616', M0S: 'm0sdock', BL618: 'aim61' };
const numbers = text => text.split('.').map(Number);

// Device string: "LCT616-DS5 3.18G2.4RC4H" (+ "T" for the test identity).
export function parseDeviceVersion(text) {
  const m = /^([A-Z0-9]+)-DS5 (\d+(?:\.\d+)*)G(\d+(?:\.\d+)*)(?:RC(\d+))?(H)?(T)?$/.exec(String(text).replace(/\0.*$/s, '').trim());
  if (!m || !BOARDS[m[1]]) return null;
  const board = BOARDS[m[1]];
  return { board, usb: board === 'lctech616' ? (m[5] ? 'hs' : 'fs') : null, g: numbers(m[3]), rc: m[4] === undefined ? null : Number(m[4]) };
}

// Release tag: "v3.18-g2.4-rc4", "v3.18-g2.1.1". The leading base is the upstream
// SDK line and differs per board on the device, so only the G part and RC are compared.
export function parseReleaseTag(tag) {
  const m = /^v?(\d+(?:\.\d+)*)-g(\d+(?:\.\d+)*)(?:-rc(\d+))?$/i.exec(String(tag));
  return m ? { g: numbers(m[2]), rc: m[3] === undefined ? null : Number(m[3]) } : null;
}

export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.g.length, b.g.length); i++) {
    const d = (a.g[i] || 0) - (b.g[i] || 0);
    if (d) return Math.sign(d);
  }
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1; // a final release outranks its release candidates
  if (b.rc === null) return -1;
  return Math.sign(a.rc - b.rc);
}

// Picks the newest release that has a matching asset and says whether it beats `current`.
export function findUpdate(releases, current, pickAssets) {
  let best = null;
  for (const release of releases) {
    const version = parseReleaseTag(release.tag_name);
    if (!version) continue;
    const assets = pickAssets(release);
    if (!assets.length) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { release, version, asset: assets[0] };
  }
  if (!best) return null;
  return { ...best, newer: !!current && compareVersions(best.version, current) > 0 };
}

export async function sha256Hex(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyDigest(bytes, digest) {
  if (!digest) return false;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest);
  if (!m) throw new Error('不支持的校验格式：' + digest);
  if (await sha256Hex(bytes) !== m[1].toLowerCase()) throw new Error('下载内容与 GitHub 记录的 SHA256 不一致，已丢弃');
  return true;
}

// The packaged local tool fetches release assets and handles self-updates (GitHub assets have no CORS).
export async function probeLocalApp(fetcher = globalThis.fetch) {
  try {
    const response = await fetcher('/api/local');
    if (!response.ok) return null;
    const info = await response.json();
    if (info.application !== 'DS5 Control Center') return null;
    const download = async ({ repo, tag, name }) => {
      const query = new URLSearchParams({ repo, tag, name });
      const r = await fetcher('/api/download?' + query, { method: 'POST', headers: { 'X-Session-Token': info.token } });
      if (!r.ok) throw new Error(r.status === 502 ? '本地工具下载失败，请检查网络' : '本地工具拒绝下载（HTTP ' + r.status + '）');
      return new Uint8Array(await r.arrayBuffer());
    };
    const selfUpdate = async ({ repo, tag, name, sha256 }) => {
      const query = new URLSearchParams({ repo, tag, name, sha256 });
      const r = await fetcher('/api/self-update?' + query, { method: 'POST', headers: { 'X-Session-Token': info.token } });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(r.status === 502 ? '下载新版控制中心失败，请检查网络' : (text || '控制中心升级失败（HTTP ' + r.status + '）'));
      }
      return await r.json().catch(() => ({ updated: true, restarting: true }));
    };
    return { ...info, download, selfUpdate };
  } catch { return null; }
}

export async function createLocalDownloader(fetcher = globalThis.fetch) {
  const app = await probeLocalApp(fetcher);
  return app ? app.download : null;
}
