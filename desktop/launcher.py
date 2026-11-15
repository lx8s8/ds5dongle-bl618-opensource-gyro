#!/usr/bin/env python3
"""Local-only browser launcher. The bundled app needs no Python installation."""
import argparse
import functools
import hashlib
import hmac
import io
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import zipfile
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
SOURCE_ASSET = 'DS5-Control-Center-source.zip'
MAX_DOWNLOAD = 8 * 1024 * 1024
SAFE_COMPONENT = re.compile(r'^[A-Za-z0-9._-]{1,100}$')


def app_version():
    version_file = Path(__file__).resolve().parent / 'VERSION'
    try:
        text = version_file.read_text(encoding='utf-8').strip()
        if text:
            return text
    except OSError:
        pass
    return 'dev'


def self_update_capability(root=None):
    target = Path(root) if root is not None else web_root().parent
    if (target / '.git').exists():
        return False, '当前为 Git 源码仓库，请直接使用 git pull 更新'
    if not os.access(target, os.W_OK):
        return False, '当前应用目录无写入权限，请移动到可写文件夹后再试'
    return True, ''


def allowed_asset(name):
    return bool(name) and (name.endswith('.zip') or (name.startswith('ds5-boot-manager-') and name.endswith('.bin')))


def release_url(query):
    """Only release ZIPs and boot-manager binaries of the two known repositories may be fetched."""
    values = {k: v[0] for k, v in parse_qs(query).items() if len(v) == 1}
    repo, tag, name = values.get('repo'), values.get('tag'), values.get('name')
    if repo not in REPOSITORIES or not allowed_asset(name):
        return None
    for part in (tag, name):
        if not part or '..' in part or not SAFE_COMPONENT.match(part):
            return None
    return 'https://github.com/' + repo + '/releases/download/' + tag + '/' + name


def fetch_release(url):
    # The page cannot read GitHub release assets (no CORS), so the local tool does.
    req = urllib.request.Request(url, headers={'User-Agent': 'DS5-Control-Center/2.4'})
    with urllib.request.urlopen(req, timeout=60) as response:
        if not response.geturl().startswith('https://'):
            raise ValueError('Redirected away from HTTPS')
        data = response.read(MAX_DOWNLOAD + 1)
    if not data or len(data) > MAX_DOWNLOAD:
        raise ValueError('Unexpected download size')
    return data


def self_update_request(query):
    values = {k: v[0] for k, v in parse_qs(query).items() if len(v) == 1}
    repo, tag, name, sha = values.get('repo'), values.get('tag'), values.get('name'), values.get('sha256')
    if repo != REPOSITORIES[0] or name != SOURCE_ASSET or not tag or '..' in tag or not SAFE_COMPONENT.match(tag):
        return None
    if not sha or not re.fullmatch(r'[0-9a-fA-F]{64}', sha):
        return None
    return 'https://github.com/' + repo + '/releases/download/' + tag + '/' + name, sha.lower()


def apply_source_update(zip_bytes, expected_sha256, root):
    root = Path(root).resolve()
    if not zip_bytes.startswith(b'PK\x03\x04') or not hmac.compare_digest(hashlib.sha256(zip_bytes).hexdigest(), expected_sha256.lower()):
        raise ValueError('安装包 SHA256 校验失败或压缩包损坏')
    with tempfile.TemporaryDirectory(prefix='.ds5-cc-src-', dir=root) as tmp:
        stage = Path(tmp)
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
            names = []
            for info in zf.infolist():
                if ((info.external_attr >> 16) & 0o170000) == 0o120000:
                    raise ValueError('安装包包含不允许的符号链接')
                raw = info.filename
                if '\\' in raw or raw.startswith('/'):
                    raise ValueError('安装包路径非法')
                parts = Path(raw).parts
                if not parts or parts[0] != 'DS5-Control-Center' or '..' in parts:
                    raise ValueError('安装包目录结构无效')
                names.append(raw)
                dest = (stage / Path(*parts)).resolve()
                if stage not in dest.parents and dest != stage:
                    raise ValueError('安装包路径越界')
                if info.is_dir():
                    dest.mkdir(parents=True, exist_ok=True)
                else:
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, open(dest, 'wb') as out:
                        shutil.copyfileobj(src, out)
        src_root = stage / 'DS5-Control-Center'
        for req in ('web/index.html', 'desktop/launcher.py'):
            f = src_root / req
            if not f.is_file() or f.stat().st_size == 0:
                raise ValueError('源码包缺少核心文件：' + req)
        shutil.copytree(src_root, root, dirs_exist_ok=True)
    for exe in (root / 'desktop/launcher.py', root / '启动控制中心.command'):
        if exe.is_file():
            try:
                exe.chmod(exe.stat().st_mode | 0o111)
            except OSError:
                pass


def spawn_relaunch(root, port, no_open=False):
    launcher_script = str(Path(root) / 'desktop/launcher.py')
    args = [sys.executable, launcher_script, '--port', str(port)]
    if no_open:
        args.append('--no-open')
    helper = 'import subprocess,sys,time;time.sleep(0.6);subprocess.Popen(sys.argv[1:])'
    subprocess.Popen([sys.executable, '-c', helper, *args], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, directory, no_open=False):
        self.session_token = secrets.token_urlsafe(32)
        self.download_lock = threading.Lock()
        self.no_open = no_open
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
            app_dir = Path(self.directory).parent
            can_update, note = self_update_capability(app_dir)
            b = json.dumps({
                'application': 'DS5 Control Center',
                'token': self.server.session_token,
                'version': app_version(),
                'mode': 'source',
                'asset': SOURCE_ASSET,
                'canSelfUpdate': can_update,
                'updateNote': note,
            }).encode()
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
        if parts.path not in ('/api/quit', '/api/download', '/api/self-update'):
            self.send_error(404)
            return
        token = self.headers.get('X-Session-Token', '')
        if self.headers.get('Origin') != self.server.origin or not hmac.compare_digest(token, self.server.session_token):
            self.send_error(403)
            return
        if parts.path == '/api/download':
            self.download(release_url(parts.query))
            return
        if parts.path == '/api/self-update':
            self.self_update(parts.query)
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
        self.send_header('Content-Type', 'application/octet-stream' if url.endswith('.bin') else 'application/zip')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_text_error(self, code, message):
        body = str(message).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def self_update(self, query):
        parsed = self_update_request(query)
        if not parsed:
            self.send_text_error(400, 'Unsupported self-update request')
            return
        url, expected_sha = parsed
        app_dir = Path(self.directory).parent
        can_update, note = self_update_capability(app_dir)
        if not can_update:
            self.send_text_error(400, note)
            return
        if not self.server.download_lock.acquire(blocking=False):
            self.send_text_error(503, 'A download is already running')
            return
        try:
            data = fetch_release(url)
        except Exception:
            self.send_text_error(502, 'Download failed')
            return
        finally:
            self.server.download_lock.release()
        try:
            apply_source_update(data, expected_sha, app_dir)
        except Exception as exc:
            self.send_text_error(400, str(exc))
            return
        body = b'{"updated":true,"restarting":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        spawn_relaunch(app_dir, self.server.server_address[1], self.server.no_open)
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
        server = LocalServer(('127.0.0.1', args.port), web_root(), no_open=args.no_open)
    except OSError:
        server = LocalServer(('127.0.0.1', 0), web_root(), no_open=args.no_open)
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
