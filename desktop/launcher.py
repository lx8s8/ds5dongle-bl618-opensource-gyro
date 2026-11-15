#!/usr/bin/env python3
"""Local-only browser launcher. The bundled app needs no Python installation."""
import argparse
import functools
import hmac
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import urllib.request
import webbrowser


def web_root():
    roots = [Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'web',
             Path(__file__).resolve().parent / 'web', Path(__file__).resolve().parents[1] / 'web']
    for root in roots:
        if (root / 'index.html').is_file():
            return root
    raise RuntimeError('Cannot locate the bundled web directory')


REPOSITORIES = ('lx8s8/ds5dongle-bl618-opensource-gyro', 'sqlCRT/ds5dongle-bl618-opensource')
MAX_DOWNLOAD = 8 * 1024 * 1024
SAFE_COMPONENT = re.compile(r'^[A-Za-z0-9._-]{1,100}$')


def release_url(query):
    """Only ZIPs attached to releases of the two known repositories may be fetched."""
    values = {k: v[0] for k, v in parse_qs(query).items() if len(v) == 1}
    repo, tag, name = values.get('repo'), values.get('tag'), values.get('name')
    if repo not in REPOSITORIES or not name or not name.endswith('.zip'):
        return None
    for part in (tag, name):
        if not part or '..' in part or not SAFE_COMPONENT.match(part):
            return None
    return 'https://github.com/' + repo + '/releases/download/' + tag + '/' + name


def fetch_release(url):
    # The page cannot read GitHub release assets (no CORS), so the local tool does.
    with urllib.request.urlopen(url, timeout=60) as response:
        if not response.geturl().startswith('https://'):
            raise ValueError('Redirected away from HTTPS')
        data = response.read(MAX_DOWNLOAD + 1)
    if not data or len(data) > MAX_DOWNLOAD:
        raise ValueError('Unexpected download size')
    return data


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, directory):
        self.session_token = secrets.token_urlsafe(32)
        self.download_lock = threading.Lock()
        super().__init__(address, functools.partial(Handler, directory=str(directory)))
        self.origin = 'http://127.0.0.1:' + str(self.server_address[1])


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript'}

    def allowed(self):
        if self.headers.get('Host') != '127.0.0.1:' + str(self.server.server_address[1]):
            self.send_error(403)
            return False
        origin = self.headers.get('Origin')
        if origin and origin != self.server.origin:
            self.send_error(403)
            return False
        return True

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_GET(self):
        if not self.allowed():
            return
        if urlsplit(self.path).path == '/api/local':
            b = json.dumps({'application': 'DS5 Control Center', 'token': self.server.session_token}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        else:
            super().do_GET()

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()

    def do_POST(self):
        if not self.allowed():
            return
        parts = urlsplit(self.path)
        if parts.path not in ('/api/quit', '/api/download'):
            self.send_error(404)
            return
        token = self.headers.get('X-Session-Token', '')
        if self.headers.get('Origin') != self.server.origin or not hmac.compare_digest(token, self.server.session_token):
            self.send_error(403)
            return
        if parts.path == '/api/download':
            self.download(release_url(parts.query))
            return
        self.send_response(204)
        self.end_headers()
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def download(self, url):
        if not url:
            self.send_error(400, 'Unsupported release asset')
            return
        if not self.server.download_lock.acquire(blocking=False):
            self.send_error(503, 'A download is already running')
            return
        try:
            data = fetch_release(url)
        except Exception:
            self.send_error(502, 'Download failed')
            return
        finally:
            self.server.download_lock.release()
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def list_directory(self, path):
        self.send_error(404)

    def log_message(self, format, *args):
        pass


def open_supported_browser(url):
    if sys.platform == 'darwin':
        for app in ['Microsoft Edge', 'Google Chrome', 'Chromium']:
            if Path('/Applications/' + app + '.app').exists():
                subprocess.Popen(['open', '-a', app, url])
                return
    elif sys.platform == 'win32':
        for root in [os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''), os.environ.get('LOCALAPPDATA', '')]:
            for tail in ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']:
                exe = Path(root) / tail
                if exe.is_file():
                    subprocess.Popen([str(exe), url])
                    return
    else:
        for name in ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser']:
            exe = shutil.which(name)
            if exe:
                subprocess.Popen([exe, url])
                return
    webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    try:
        server = LocalServer(('127.0.0.1', args.port), web_root())
    except OSError:
        server = LocalServer(('127.0.0.1', 0), web_root())
    print('DS5 Control Center: ' + server.origin, flush=True)
    print('Use Chrome / Edge. Quit using the button at the bottom of the page.', flush=True)
    if not args.no_open:
        threading.Timer(.25, open_supported_browser, args=(server.origin,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
