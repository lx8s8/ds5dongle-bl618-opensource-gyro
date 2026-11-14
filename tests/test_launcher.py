import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest

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


if __name__ == '__main__':
    unittest.main()
