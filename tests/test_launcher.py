import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

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


if __name__ == '__main__':
    unittest.main()
