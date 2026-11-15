#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::{
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::{AtomicBool, AtomicUsize, Ordering}, Arc},
    thread,
    time::Duration,
};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));
const MAX_HEADERS: usize = 16384;
const MAX_DOWNLOAD: usize = 8 * 1024 * 1024;
const REPOSITORIES: [&str; 2] = ["lx8s8/ds5dongle-bl618-opensource-gyro", "sqlCRT/ds5dongle-bl618-opensource"];
struct Server {
    downloading: AtomicBool,
    host: String,
    origin: String,
    token: String,
    stopping: AtomicBool,
    connections: AtomicUsize,
}

fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    #[cfg(unix)]
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    #[cfg(windows)]
    {
        #[link(name = "bcrypt")]
        extern "system" {
            fn BCryptGenRandom(provider: *mut std::ffi::c_void, buffer: *mut u8, length: u32, flags: u32) -> i32;
        }
        if unsafe { BCryptGenRandom(std::ptr::null_mut(), bytes.as_mut_ptr(), 32, 2) } < 0 {
            return Err(io::Error::other("Cannot obtain system randomness"));
        }
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn token_matches(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |x, (a, b)| x | (a ^ b)) == 0
}


fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            out.push(u8::from_str_radix(value.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        if k == key { percent_decode(v) } else { None }
    })
}

fn safe_component(value: &str) -> bool {
    !value.is_empty() && value.len() <= 100 && !value.contains("..") && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn allowed_asset(name: &str) -> bool {
    name.ends_with(".zip") || (name.starts_with("ds5-boot-manager-") && name.ends_with(".bin"))
}

// The page cannot read GitHub release assets (no CORS), so the local tool fetches
// only release ZIPs and boot-manager binaries of the two known repositories, using curl.
fn release_url(query: &str) -> Option<String> {
    let repo = query_value(query, "repo")?;
    let tag = query_value(query, "tag")?;
    let name = query_value(query, "name")?;
    if !REPOSITORIES.contains(&repo.as_str()) || !safe_component(&tag) || !safe_component(&name) || !allowed_asset(&name) { return None; }
    Some(format!("https://github.com/{repo}/releases/download/{tag}/{name}"))
}

fn curl_path() -> PathBuf {
    #[cfg(windows)]
    { PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join("curl.exe") }
    #[cfg(not(windows))]
    { PathBuf::from("/usr/bin/curl") }
}

fn has_proxy_env() -> bool {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
}

#[cfg(windows)]
fn normalize_proxy_entry(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() { return None; }
    let chosen = if raw.contains('=') {
        let mut found = None;
        for prefix in ["https=", "http=", "socks=", "socks5="] {
            for part in raw.split(';') {
                let part = part.trim();
                if let Some(rest) = part.strip_prefix(prefix) {
                    if !rest.trim().is_empty() { found = Some((prefix, rest.trim())); break; }
                }
            }
            if found.is_some() { break; }
        }
        match found {
            Some(("socks=", addr)) | Some(("socks5=", addr)) if !addr.contains("://") => format!("socks5h://{addr}"),
            Some((_, addr)) => addr.to_string(),
            None => return None,
        }
    } else {
        raw.to_string()
    };
    if chosen.contains("://") { Some(chosen) } else { Some(format!("http://{chosen}")) }
}

#[cfg(windows)]
fn detect_system_proxy() -> Option<String> {
    if has_proxy_env() { return None; }
    use std::os::windows::process::CommandExt;
    let reg = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32").join("reg.exe");
    let out = Command::new(reg)
        .args(["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut enabled = false;
    let mut server = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("ProxyEnable") && (trimmed.ends_with("0x1") || trimmed.ends_with(" 1")) {
            enabled = true;
        } else if trimmed.starts_with("ProxyServer") {
            if let Some((_, val)) = trimmed.split_once("REG_SZ") {
                server = normalize_proxy_entry(val);
            }
        }
    }
    if enabled { server } else { None }
}

#[cfg(target_os = "macos")]
fn detect_system_proxy() -> Option<String> {
    if has_proxy_env() { return None; }
    let out = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut https_en = false;
    let mut http_en = false;
    let mut https_host = None;
    let mut https_port = None;
    let mut http_host = None;
    let mut http_port = None;
    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim());
        match k {
            "HTTPSEnable" => https_en = v == "1",
            "HTTPSProxy" if !v.is_empty() => https_host = Some(v.to_string()),
            "HTTPSPort" if !v.is_empty() && v != "0" => https_port = Some(v.to_string()),
            "HTTPEnable" => http_en = v == "1",
            "HTTPProxy" if !v.is_empty() => http_host = Some(v.to_string()),
            "HTTPPort" if !v.is_empty() && v != "0" => http_port = Some(v.to_string()),
            _ => {}
        }
    }
    if https_en {
        if let (Some(h), Some(p)) = (https_host, https_port) { return Some(format!("http://{h}:{p}")); }
    }
    if http_en {
        if let (Some(h), Some(p)) = (http_host, http_port) { return Some(format!("http://{h}:{p}")); }
    }
    None
}

#[cfg(not(any(windows, target_os = "macos")))]
fn detect_system_proxy() -> Option<String> { None }

fn run_curl(url: &str, proxy: Option<&str>) -> Result<Vec<u8>, &'static str> {
    let mut command = Command::new(curl_path());
    command.args([
        "--disable", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https",
        "--max-redirs", "5", "--max-filesize", "8388608",
        "--connect-timeout", "20", "--max-time", "120",
        "-A", "DS5-Control-Center/2.4",
    ]);
    #[cfg(windows)]
    command.arg("--ssl-revoke-best-effort");
    if let Some(p) = proxy {
        command.args(["--proxy", p]);
    }
    command.args(["--output", "-", url])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|_| "System curl is unavailable")?;
    let mut data = Vec::new();
    let read = child.stdout.take().ok_or("Download failed")?.take(MAX_DOWNLOAD as u64 + 1).read_to_end(&mut data);
    if data.len() > MAX_DOWNLOAD || read.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Download too large or interrupted");
    }
    match child.wait() {
        Ok(status) if status.success() && !data.is_empty() => Ok(data),
        _ => Err("Download failed"),
    }
}

#[cfg(windows)]
fn powershell_download(url: &str) -> Result<Vec<u8>, &'static str> {
    use std::os::windows::process::CommandExt;
    let ps = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    let script = r#"
        $ErrorActionPreference = 'Stop'
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor 12288 } catch { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }
        $wc = New-Object System.Net.WebClient
        $wc.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
        if ($wc.Proxy) { $wc.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials }
        $wc.Headers.Add('User-Agent', 'DS5-Control-Center/2.4')
        $bytes = $wc.DownloadData($env:DS5_DL_URL)
        if ($bytes.Length -le 0 -or $bytes.Length -gt 8388608) { exit 2 }
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
    "#;
    let mut cmd = Command::new(ps);
    cmd.args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
        .env("DS5_DL_URL", url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|_| "Download failed")?;
    let mut data = Vec::new();
    let read = child.stdout.take().ok_or("Download failed")?.take(MAX_DOWNLOAD as u64 + 1).read_to_end(&mut data);
    if data.len() > MAX_DOWNLOAD || read.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Download too large or interrupted");
    }
    match child.wait() {
        Ok(status) if status.success() && !data.is_empty() => Ok(data),
        _ => Err("Download failed"),
    }
}

fn download_release(url: &str) -> Result<Vec<u8>, &'static str> {
    if let Some(proxy) = detect_system_proxy() {
        if let Ok(data) = run_curl(url, Some(&proxy)) {
            return Ok(data);
        }
    }
    if let Ok(data) = run_curl(url, None) {
        return Ok(data);
    }
    #[cfg(windows)]
    if let Ok(data) = powershell_download(url) {
        return Ok(data);
    }
    Err("Download failed")
}

fn reply(stream: &mut TcpStream, code: u16, mime: &str, bytes: &[u8], head: bool) -> io::Result<()> {
    let reason = match code { 200 => "OK", 204 => "No Content", 400 => "Bad Request", 403 => "Forbidden", 404 => "Not Found", 405 => "Method Not Allowed", 502 => "Bad Gateway", 503 => "Service Unavailable", 431 => "Request Header Fields Too Large", _ => "Error" };
    let headers = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n", bytes.len());
    stream.write_all(headers.as_bytes())?;
    if !head { stream.write_all(bytes)?; }
    stream.flush()
}

fn serve(mut stream: TcpStream, server: &Server) -> io::Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    let end;
    loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 { return Ok(()); }
        bytes.extend_from_slice(&chunk[..n]);
        if let Some(i) = bytes.windows(4).position(|b| b == b"\r\n\r\n") { end = i; break; }
        if bytes.len() >= MAX_HEADERS { return reply(&mut stream, 431, "text/plain", b"Header too large", false); }
    }
    if end > MAX_HEADERS { return reply(&mut stream, 431, "text/plain", b"Header too large", false); }
    let Ok(headers) = std::str::from_utf8(&bytes[..end]) else { return reply(&mut stream, 400, "text/plain", b"Invalid request", false); };
    let mut lines = headers.split("\r\n");
    let request: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if request.len() != 3 || !["HTTP/1.0", "HTTP/1.1"].contains(&request[2]) || !request[1].starts_with('/') {
        return reply(&mut stream, 400, "text/plain", b"Invalid request", false);
    }
    let method = request[0];
    let (path, query) = request[1].split_once('?').unwrap_or((request[1], ""));
    let head = method == "HEAD";
    let (mut host, mut origin, mut token) = (None, None, None);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { return reply(&mut stream, 400, "text/plain", b"Invalid header", head); };
        if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') || value.bytes().any(|b| b < 32 && b != b'\t') {
            return reply(&mut stream, 400, "text/plain", b"Invalid header", head);
        }
        let slot = if name.eq_ignore_ascii_case("host") { Some(&mut host) } else if name.eq_ignore_ascii_case("origin") { Some(&mut origin) } else if name.eq_ignore_ascii_case("x-session-token") { Some(&mut token) } else { None };
        if let Some(slot) = slot {
            if slot.replace(value.trim()).is_some() { return reply(&mut stream, 400, "text/plain", b"Duplicate header", head); }
        }
    }
    if host != Some(server.host.as_str()) || origin.is_some_and(|v| v != server.origin) {
        return reply(&mut stream, 403, "text/plain", b"Foreign origin", head);
    }
    if method == "POST" && path == "/api/quit" {
        if origin != Some(server.origin.as_str()) || !token_matches(token.unwrap_or(""), &server.token) {
            return reply(&mut stream, 403, "text/plain", b"Invalid session", false);
        }
        reply(&mut stream, 204, "text/plain", b"", false)?;
        server.stopping.store(true, Ordering::Release);
        return Ok(());
    }
    if method == "POST" && path == "/api/download" {
        if origin != Some(server.origin.as_str()) || !token_matches(token.unwrap_or(""), &server.token) {
            return reply(&mut stream, 403, "text/plain", b"Invalid session", false);
        }
        let Some(url) = release_url(query) else { return reply(&mut stream, 400, "text/plain", b"Unsupported release asset", false); };
        if server.downloading.swap(true, Ordering::AcqRel) { return reply(&mut stream, 503, "text/plain", b"A download is already running", false); }
        let result = download_release(&url);
        server.downloading.store(false, Ordering::Release);
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;
        let mime = if url.ends_with(".bin") { "application/octet-stream" } else { "application/zip" };
        return match result {
            Ok(data) => reply(&mut stream, 200, mime, &data, false),
            Err(message) => reply(&mut stream, 502, "text/plain", message.as_bytes(), false),
        };
    }
    if method != "GET" && !head { return reply(&mut stream, 405, "text/plain", b"Method not allowed", false); }
    if path == "/api/local" {
        let data = format!(r#"{{"application":"DS5 Control Center","token":"{}"}}"#, server.token);
        return reply(&mut stream, 200, "application/json", data.as_bytes(), head);
    }
    let path = if path == "/" { "/index.html" } else { path };
    if let Some((_, mime, data)) = ASSETS.iter().find(|(name, _, _)| *name == path) { reply(&mut stream, 200, mime, data, head) }
    else { reply(&mut stream, 404, "text/plain", b"Not found", head) }
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    for app in ["Microsoft Edge", "Google Chrome", "Chromium"] {
        if Path::new(&format!("/Applications/{app}.app")).exists() && Command::new("open").args(["-a", app, url]).spawn().is_ok() { return; }
    }
    #[cfg(windows)]
    for key in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(key) {
            for tail in ["Microsoft/Edge/Application/msedge.exe", "Google/Chrome/Application/chrome.exe"] {
                let exe = Path::new(&root).join(tail);
                if exe.is_file() && Command::new(exe).arg(url).spawn().is_ok() { return; }
            }
        }
    }
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).spawn();
    #[cfg(windows)]
    let _ = Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).spawn();
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = Command::new("xdg-open").arg(url).spawn();
}

fn run() -> io::Result<()> {
    let mut port = 8765u16;
    let mut open = true;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--no-open" => open = false,
            "--port" => port = args.next().and_then(|p| p.parse().ok()).ok_or_else(|| io::Error::other("Invalid port"))?,
            _ => return Err(io::Error::other("Usage: DS5-Control-Center [--no-open] [--port PORT]")),
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", port)).or_else(|e| {
        if e.kind() == io::ErrorKind::AddrInUse { TcpListener::bind(("127.0.0.1", 0)) } else { Err(e) }
    })?;
    listener.set_nonblocking(true)?;
    let host = format!("127.0.0.1:{}", listener.local_addr()?.port());
    let server = Arc::new(Server { downloading: AtomicBool::new(false), origin: format!("http://{host}"), host, token: random_token()?, stopping: AtomicBool::new(false), connections: AtomicUsize::new(0) });
    if !open {
        println!("DS5 Control Center: {}", server.origin);
        io::stdout().flush()?;
    }
    if open { open_browser(&server.origin); }
    while !server.stopping.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                if server.connections.load(Ordering::Relaxed) >= 32 { drop(stream); continue; }
                server.connections.fetch_add(1, Ordering::Relaxed);
                let state = Arc::clone(&server);
                thread::spawn(move || {
                    let _ = serve(stream, &state);
                    state.connections.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}
fn main() {
    if let Err(e) = run() { eprintln!("{e}"); std::process::exit(1); }
}
