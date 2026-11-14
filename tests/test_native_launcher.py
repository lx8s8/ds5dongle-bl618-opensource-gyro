"""Exercise the actual native binary on each OS; never accesses HID hardware."""
import hashlib
import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / 'build/control-center-native/release' / ('ds5-control-center.exe' if os.name == 'nt' else 'ds5-control-center')


class NativeLauncherTests(unittest.TestCase):
    def setUp(self):
        self.proc = subprocess.Popen([str(BINARY), '--no-open', '--port', '0'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.close_process)
        line = self.proc.stdout.readline().strip()
        self.assertTrue(line.startswith('DS5 Control Center: http://127.0.0.1:'), line)
        self.origin = line.split(': ', 1)[1]
        self.port = urlsplit(self.origin).port

    def close_process(self):
        if self.proc.poll() is None:
            self.proc.terminate()
        self.proc.communicate(timeout=5)

    def request(self, path='/', method='GET', headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def test_all_embedded_assets_and_no_file_access(self):
        for f in (ROOT / 'web').iterdir():
            if not f.is_file():
                continue
            with self.subTest(f=f.name):
                status, headers, body = self.request('/' + f.name + '?version=1')
                self.assertEqual(status, 200)
                self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256(f.read_bytes()).digest())
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(self.request('/')[2], (ROOT / 'web/index.html').read_bytes())
        self.assertEqual(self.request('/../desktop/launcher.py')[0], 404)
        self.assertEqual(self.request('/%2e%2e/LICENSE')[0], 404)
        self.assertEqual(self.request('/api/quit')[0], 404)
        status, headers, body = self.request('/index.html', 'HEAD')
        self.assertEqual((status, body), (200, b''))
        self.assertEqual(int(headers['Content-Length']), (ROOT / 'web/index.html').stat().st_size)

    def test_origin_host_and_shutdown(self):
        self.assertEqual(self.request(headers={'Host': 'evil.test'})[0], 403)
        self.assertEqual(self.request('/api/local', headers={'Origin': 'https://evil.test'})[0], 403)
        status, _, data = self.request('/api/local')
        self.assertEqual(status, 200)
        info = json.loads(data)
        self.assertEqual(info['application'], 'DS5 Control Center')
        self.assertEqual(len(bytes.fromhex(info['token'])), 32)
        self.assertEqual(self.request('/api/quit', 'POST')[0], 403)
        self.assertEqual(self.request('/api/quit', 'POST', {'Origin': self.origin, 'X-Session-Token': 'wrong'})[0], 403)
        self.assertEqual(self.request('/api/quit', 'POST', {'Origin': self.origin, 'X-Session-Token': info['token']})[0], 204)
        self.assertEqual(self.proc.wait(timeout=5), 0)

    def test_rejects_duplicate_host_and_large_headers(self):
        for raw, status in [
            (f'GET / HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nHost: evil.test\r\n\r\n'.encode(), b'400'),
            (b'GET / HTTP/1.1\r\nX-Large: ' + b'a' * 18000 + b'\r\n\r\n', b'431'),
        ]:
            with socket.create_connection(('127.0.0.1', self.port), timeout=5) as s:
                s.sendall(raw)
                with s.makefile('rb') as wire:
                    self.assertIn(status, wire.readline(256))
        self.assertEqual(self.request()[0], 200)

    def test_busy_port_chooses_new_port_and_session(self):
        other = subprocess.Popen([str(BINARY), '--no-open', '--port', str(self.port)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            origin = other.stdout.readline().strip().split(': ', 1)[1]
            self.assertNotEqual(origin, self.origin)
            conn = http.client.HTTPConnection('127.0.0.1', urlsplit(origin).port, timeout=5)
            conn.request('GET', '/api/local')
            token = json.loads(conn.getresponse().read())['token']
            conn.close()
            original = json.loads(self.request('/api/local')[2])['token']
            self.assertNotEqual(token, original)
            conn = http.client.HTTPConnection('127.0.0.1', urlsplit(origin).port, timeout=5)
            conn.request('POST', '/api/quit', headers={'Origin': origin, 'X-Session-Token': token})
            self.assertEqual(conn.getresponse().status, 204)
            conn.close()
            self.assertEqual(other.wait(timeout=5), 0)
            self.assertEqual(self.request()[0], 200)
        finally:
            if other.poll() is None:
                other.terminate()
            other.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
