import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher', ROOT / 'desktop/launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.server = launcher.LocalServer(('127.0.0.1', 0), ROOT / 'web')
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)

    def request(self, method, path, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        result = r.status, dict(r.getheaders()), r.read()
        c.close()
        return result

    def test_assets_and_only_web_directory(self):
        self.assertEqual(self.request('GET', '/')[0], 200)
        status, headers, _ = self.request('GET', '/protocol.mjs')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-type'], 'text/javascript')
        self.assertEqual(self.request('GET', '/../.git/config')[0], 404)

    def test_rejects_foreign_host_and_origin(self):
        self.assertEqual(self.request('GET', '/', {'Host': 'foreign.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/local', {'Origin': 'https://foreign.example'})[0], 403)

    def test_shutdown_requires_same_origin_session(self):
        self.assertEqual(self.request('POST', '/api/quit')[0], 403)
        data = json.loads(self.request('GET', '/api/local')[2])
        status = self.request('POST', '/api/quit', {'Origin': self.server.origin, 'X-Session-Token': data['token']})[0]
        self.assertEqual(status, 204)
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def test_release_download_is_authenticated_and_restricted(self):
        repo = 'lx8s8%2Fds5dongle-bl618-opensource-gyro'
        good = '/api/download?repo=' + repo + '&tag=v3.18-g2.4-rc4&name=ds5dongle-aim61-fs-746aa866.zip'
        self.assertEqual(self.request('POST', good)[0], 403)
        auth = {'Origin': self.server.origin, 'X-Session-Token': json.loads(self.request('GET', '/api/local')[2])['token']}
        for bad in ['repo=evil%2Frepo&tag=v1&name=a.zip', 'repo=' + repo + '&tag=..%2Fx&name=a.zip',
                    'repo=' + repo + '&tag=v1&name=a.exe', 'repo=' + repo + '&tag=v1&name=other.bin',
                    'repo=' + repo + '&tag=v1&name=a.zip&name=b.zip', 'tag=v1&name=a.zip']:
            self.assertEqual(self.request('POST', '/api/download?' + bad, auth)[0], 400, bad)
        with patch.object(launcher, 'fetch_release', return_value=b'PK-test') as fetch:
            status, headers, body = self.request('POST', good, auth)
        self.assertEqual((status, body), (200, b'PK-test'))
        self.assertEqual(headers['Content-Type'], 'application/zip')
        fetch.assert_called_once_with('https://github.com/lx8s8/ds5dongle-bl618-opensource-gyro/releases/download/v3.18-g2.4-rc4/ds5dongle-aim61-fs-746aa866.zip')
        mgr = '/api/download?repo=' + repo + '&tag=v3.18-g2.4-rc6&name=ds5-boot-manager-lctech616-fs-experimental.bin'
        with patch.object(launcher, 'fetch_release', return_value=b'BFNP-mgr') as fetch_mgr:
            status, headers, body = self.request('POST', mgr, auth)
        self.assertEqual((status, body), (200, b'BFNP-mgr'))
        self.assertEqual(headers['Content-Type'], 'application/octet-stream')
        fetch_mgr.assert_called_once_with('https://github.com/lx8s8/ds5dongle-bl618-opensource-gyro/releases/download/v3.18-g2.4-rc6/ds5-boot-manager-lctech616-fs-experimental.bin')
        with patch.object(launcher, 'fetch_release', side_effect=OSError('offline')):
            self.assertEqual(self.request('POST', good, auth)[0], 502)

    @staticmethod
    def _build_source_zip(entries, prefix='DS5-Control-Center/'):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
            for rel, payload, mode in entries:
                zi = zipfile.ZipInfo(prefix + rel)
                if mode is not None:
                    zi.external_attr = (mode & 0xFFFF) << 16
                zf.writestr(zi, payload)
        raw = buf.getvalue()
        return raw, hashlib.sha256(raw).hexdigest()

    def test_local_info_and_apply_source_update_validation(self):
        info = json.loads(self.request('GET', '/api/local')[2])
        self.assertEqual(info['version'], (ROOT / 'desktop/VERSION').read_text(encoding='utf-8').strip())
        self.assertEqual(info['mode'], 'source')
        self.assertEqual(info['asset'], 'DS5-Control-Center-source.zip')
        self.assertFalse(info['canSelfUpdate'])  # ROOT is a .git checkout

        with tempfile.TemporaryDirectory() as tmp:
            app_root = Path(tmp) / 'DS5-Control-Center'
            (app_root / 'web').mkdir(parents=True)
            (app_root / 'desktop').mkdir()
            (app_root / 'web/index.html').write_text('old', encoding='utf-8')
            (app_root / 'desktop/launcher.py').write_text('# old', encoding='utf-8')
            (app_root / 'user_notes.txt').write_text('keep-me', encoding='utf-8')

            good_zip, good_sha = self._build_source_zip([
                ('web/index.html', b'<html>new</html>', 0o100644),
                ('desktop/launcher.py', b'#!/usr/bin/env python3\n', 0o100644),
                ('desktop/VERSION', b'v9.9-g9.9\n', 0o100644),
            ])
            launcher.apply_source_update(good_zip, good_sha, app_root)
            self.assertEqual((app_root / 'web/index.html').read_text(encoding='utf-8'), '<html>new</html>')
            self.assertEqual((app_root / 'desktop/VERSION').read_text(encoding='utf-8').strip(), 'v9.9-g9.9')
            self.assertEqual((app_root / 'user_notes.txt').read_text(encoding='utf-8'), 'keep-me')
            self.assertTrue((app_root / 'desktop/launcher.py').stat().st_mode & stat.S_IXUSR)

            with self.assertRaises(ValueError):
                launcher.apply_source_update(good_zip, '0' * 64, app_root)
            slip_zip, slip_sha = self._build_source_zip([('../evil.txt', b'x', 0o100644)])
            with self.assertRaises(ValueError):
                launcher.apply_source_update(slip_zip, slip_sha, app_root)
            sym_zip, sym_sha = self._build_source_zip([('web/sym', b'/etc/passwd', stat.S_IFLNK | 0o777)])
            with self.assertRaises(ValueError):
                launcher.apply_source_update(sym_zip, sym_sha, app_root)
            incomplete_zip, inc_sha = self._build_source_zip([('desktop/launcher.py', b'x', 0o100644)])
            with self.assertRaises(ValueError):
                launcher.apply_source_update(incomplete_zip, inc_sha, app_root)

    def test_self_update_endpoint_requires_writable_non_git_dir_and_sha256(self):
        repo = 'lx8s8%2Fds5dongle-bl618-opensource-gyro'
        sha = 'a' * 64
        valid = f'/api/self-update?repo={repo}&tag=v3.18-g2.4-rc9&name=DS5-Control-Center-source.zip&sha256={sha}'
        self.assertEqual(self.request('POST', valid)[0], 403)
        auth = {'Origin': self.server.origin, 'X-Session-Token': json.loads(self.request('GET', '/api/local')[2])['token']}
        for bad in [
            f'repo=sqlCRT%2Fds5dongle-bl618-opensource&tag=v1&name=DS5-Control-Center-source.zip&sha256={sha}',
            f'repo={repo}&tag=v1&name=DS5-Control-Center-windows-amd64.zip&sha256={sha}',
            f'repo={repo}&tag=v1&name=DS5-Control-Center-source.zip&sha256=short',
            f'repo={repo}&tag=..%2Fx&name=DS5-Control-Center-source.zip&sha256={sha}',
        ]:
            self.assertEqual(self.request('POST', '/api/self-update?' + bad, auth)[0], 400, bad)
        # Running inside the .git checkout rejects self-update with 400
        self.assertEqual(self.request('POST', valid, auth)[0], 400)

        with tempfile.TemporaryDirectory() as tmp:
            app_root = Path(tmp) / 'DS5-Control-Center'
            (app_root / 'web').mkdir(parents=True)
            (app_root / 'desktop').mkdir()
            (app_root / 'web/index.html').write_text('old', encoding='utf-8')
            (app_root / 'desktop/launcher.py').write_text('# old', encoding='utf-8')
            pkg, pkg_sha = self._build_source_zip([
                ('web/index.html', b'updated-html', 0o100644),
                ('desktop/launcher.py', b'#!/usr/bin/env python3\n', 0o100644),
                ('desktop/VERSION', b'v3.18-g2.4-rc9\n', 0o100644),
            ])
            srv = launcher.LocalServer(('127.0.0.1', 0), app_root / 'web', no_open=True)
            thr = threading.Thread(target=srv.serve_forever)
            thr.start()
            port = srv.server_address[1]
            try:
                c = http.client.HTTPConnection('127.0.0.1', port)
                c.request('GET', '/api/local')
                local_info = json.loads(c.getresponse().read())
                c.close()
                self.assertTrue(local_info['canSelfUpdate'])
                q = f'/api/self-update?repo={repo}&tag=v3.18-g2.4-rc9&name=DS5-Control-Center-source.zip&sha256={pkg_sha}'
                hdrs = {'Origin': srv.origin, 'X-Session-Token': local_info['token']}
                with patch.object(launcher, 'fetch_release', return_value=pkg) as mock_fetch, \
                        patch.object(launcher, 'spawn_relaunch') as mock_relaunch:
                    c = http.client.HTTPConnection('127.0.0.1', port)
                    c.request('POST', q, headers=hdrs)
                    resp = c.getresponse()
                    status, body = resp.status, json.loads(resp.read())
                    c.close()
                self.assertEqual(status, 200)
                self.assertEqual(body, {'updated': True, 'restarting': True})
                mock_fetch.assert_called_once()
                mock_relaunch.assert_called_once()
                self.assertEqual(mock_relaunch.call_args[0][0].resolve(), app_root.resolve())
                self.assertEqual(mock_relaunch.call_args[0][1:], (port, True))
                self.assertEqual((app_root / 'desktop/VERSION').read_text(encoding='utf-8').strip(), 'v3.18-g2.4-rc9')
            finally:
                srv.shutdown()
                srv.server_close()
                thr.join(3)


if __name__ == '__main__':
    unittest.main()
