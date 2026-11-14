#!/usr/bin/env python3
"""Local-only browser launcher. The bundled app needs no Python installation."""
import argparse
import functools
import hmac
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import webbrowser


def web_root():
    roots = [Path(getattr(sys, '_MEIPASS', Path(__file__).parent)) / 'web',
             Path(__file__).resolve().parent / 'web', Path(__file__).resolve().parents[1] / 'web']
    for root in roots:
        if (root / 'index.html').is_file():
            return root
    raise RuntimeError('Cannot locate the bundled web directory')


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, directory):
        self.session_token = secrets.token_urlsafe(32)
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
        if urlsplit(self.path).path != '/api/quit':
            self.send_error(404)
            return
        token = self.headers.get('X-Session-Token', '')
        if self.headers.get('Origin') != self.server.origin or not hmac.compare_digest(token, self.server.session_token):
            self.send_error(403)
            return
        self.send_response(204)
        self.end_headers()
        threading.Thread(target=self.server.shutdown, daemon=True).start()

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
