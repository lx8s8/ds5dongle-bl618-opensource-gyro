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
const APP_VERSION: &str = env!("DS5_CC_VERSION");
const REPOSITORIES: [&str; 2] = ["lx8s8/ds5dongle-bl618-opensource-gyro", "sqlCRT/ds5dongle-bl618-opensource"];
struct Server {
    downloading: AtomicBool,
    host: String,
    origin: String,
    token: String,
    stopping: AtomicBool,
    connections: AtomicUsize,
}

const fn self_asset_name() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { Some("DS5-Control-Center-windows-amd64.zip") }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { Some("DS5-Control-Center-macos-arm64.zip") }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { Some("DS5-Control-Center-macos-x86_64.zip") }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
    )))]
    { None }
}

fn json_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity((data.len() + 9).div_ceil(64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() + 8) % 64 != 0 { padded.push(0); }
    padded.extend_from_slice(&bit_len.to_be_bytes());
    for block in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]); }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(temp1); d = c; c = b; b = a; a = temp1.wrapping_add(temp2);
        }
        for (slot, delta) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) { *slot = slot.wrapping_add(delta); }
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
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

fn self_update_request(query: &str) -> Option<(String, String)> {
    let asset = self_asset_name()?;
    let repo = query_value(query, "repo")?;
    let tag = query_value(query, "tag")?;
    let name = query_value(query, "name")?;
    let sha = query_value(query, "sha256")?;
    if repo != REPOSITORIES[0] || !safe_component(&tag) || name != asset || sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((format!("https://github.com/{repo}/releases/download/{tag}/{name}"), sha.to_ascii_lowercase()))
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".ds5-write-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => { drop(file); let _ = std::fs::remove_file(&probe); true }
        Err(_) => false,
    }
}

fn install_target() -> Result<PathBuf, &'static str> {
    if self_asset_name().is_none() { return Err("当前平台暂不支持客户端自动更新"); }
    let exe = std::env::current_exe().map_err(|_| "无法定位当前程序路径")?;
    #[cfg(target_os = "macos")]
    {
        if exe.file_name().and_then(|n| n.to_str()) != Some("DS5-Control-Center") {
            return Err("当前直接运行未打包二进制，请使用 DS5-Control-Center.app 启用自升级");
        }
        let macos = exe.parent().ok_or("应用包结构不完整")?;
        let contents = macos.parent().ok_or("应用包结构不完整")?;
        let app = contents.parent().ok_or("应用包结构不完整")?;
        if macos.file_name().and_then(|n| n.to_str()) != Some("MacOS")
            || contents.file_name().and_then(|n| n.to_str()) != Some("Contents")
            || app.extension().and_then(|e| e.to_str()) != Some("app") {
            return Err("当前不是标准 macOS .app 应用包，请手动下载替换");
        }
        if app.to_string_lossy().contains("/AppTranslocation/") {
            return Err("当前应用位于系统安全隔离路径，请先拖入“应用程序”或本地文件夹后再升级");
        }
        let parent = app.parent().ok_or("无法定位应用所在目录")?;
        if !dir_writable(parent) {
            return Err("当前应用所在目录无写入权限（如在只读镜像内），请先移至本地可写目录");
        }
        return Ok(app.to_path_buf());
    }
    #[cfg(windows)]
    {
        if !exe.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case("DS5-Control-Center.exe")) {
            return Err("当前非打包版 DS5-Control-Center.exe，请手动下载替换");
        }
        let dir = exe.parent().ok_or("无法定位安装目录")?;
        if !dir_writable(dir) {
            return Err("当前目录无写入权限（如 Program Files），请移至用户目录或以管理员身份运行");
        }
        return Ok(dir.to_path_buf());
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    Err("当前平台暂不支持客户端自动更新")
}

struct TempStage {
    path: PathBuf,
    keep: bool,
}

impl TempStage {
    fn new(parent: &Path) -> io::Result<Self> {
        let path = parent.join(format!(".ds5-cc-update-{}", std::process::id()));
        if path.exists() { let _ = std::fs::remove_dir_all(&path); }
        std::fs::create_dir_all(&path)?;
        Ok(Self { path, keep: false })
    }
}

impl Drop for TempStage {
    fn drop(&mut self) {
        if !self.keep { let _ = std::fs::remove_dir_all(&self.path); }
    }
}

fn is_regular_nonempty(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() > 0)
}

fn perform_self_update(zip_bytes: &[u8], expected_sha: &str, target: &Path, port: &str) -> Result<(), &'static str> {
    if !zip_bytes.starts_with(b"PK\x03\x04") || !token_matches(&sha256_hex(zip_bytes), expected_sha) {
        return Err("控制中心安装包 SHA256 校验失败或压缩包损坏");
    }
    #[cfg(target_os = "macos")]
    let stage_parent = target.parent().ok_or("无法创建临时更新目录")?;
    #[cfg(windows)]
    let stage_parent = target;
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut stage = TempStage::new(stage_parent).map_err(|_| "无法创建临时更新目录")?;
    let zip_path = stage.path.join("package.zip");
    let unpack = stage.path.join("unpack");
    std::fs::create_dir_all(&unpack).map_err(|_| "无法创建解压目录")?;
    std::fs::write(&zip_path, zip_bytes).map_err(|_| "写入临时安装包失败")?;

    #[cfg(target_os = "macos")]
    {
        let status = Command::new("/usr/bin/ditto")
            .args(["-x", "-k"])
            .arg(&zip_path)
            .arg(&unpack)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .status()
            .map_err(|_| "解压安装包失败")?;
        if !status.success() { return Err("安装包解压失败"); }
        let new_app = unpack.join("DS5-Control-Center.app");
        if !is_regular_nonempty(&new_app.join("Contents/MacOS/DS5-Control-Center")) {
            return Err("安装包缺少完整的 macOS 应用结构");
        }
        let backup = stage.path.join("backup.app");
        std::fs::rename(target, &backup).map_err(|_| "无法替换当前应用目录")?;
        if std::fs::rename(&new_app, target).is_err() {
            let _ = std::fs::rename(&backup, target);
            return Err("写入新版应用失败，已回滚原版本");
        }
        let target_arg = target.to_path_buf();
        let port_arg = port.to_string();
        let script = r#"sleep 0.6; if [ "$2" = "8765" ]; then open -n "$1" >/dev/null 2>&1 || "$1/Contents/MacOS/DS5-Control-Center" >/dev/null 2>&1; else open -n "$1" --args --port "$2" >/dev/null 2>&1 || "$1/Contents/MacOS/DS5-Control-Center" --port "$2" >/dev/null 2>&1; fi"#;
        let _ = Command::new("/bin/sh")
            .args(["-c", script, "_", target_arg.to_str().unwrap_or(""), &port_arg])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn();
        let _ = stage;
        Ok(())
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ps = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        let expand = Command::new(&ps)
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
                "Expand-Archive -LiteralPath $env:DS5_ZIP -DestinationPath $env:DS5_UNPACK -Force"])
            .env("DS5_ZIP", &zip_path)
            .env("DS5_UNPACK", &unpack)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status()
            .map_err(|_| "解压安装包失败")?;
        if !expand.success() { return Err("安装包解压失败"); }
        let src = unpack.join("DS5-Control-Center");
        let staged_exe = src.join("DS5-Control-Center.exe");
        if !is_regular_nonempty(&staged_exe) {
            return Err("安装包缺少 DS5-Control-Center.exe");
        }
        let dst_exe = target.join("DS5-Control-Center.exe");
        let updater = r#"
            $ErrorActionPreference = 'SilentlyContinue'
            Wait-Process -Id ([int]$env:DS5_PID) -Timeout 15
            Start-Sleep -Milliseconds 350
            Get-ChildItem -LiteralPath $env:DS5_SRC -Force | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $env:DS5_DST -Recurse -Force
            }
            Remove-Item -LiteralPath $env:DS5_STAGE -Recurse -Force
            if ($env:DS5_PORT -and $env:DS5_PORT -ne '8765') {
                Start-Process -FilePath $env:DS5_EXE -ArgumentList @('--port', $env:DS5_PORT)
            } else {
                Start-Process -FilePath $env:DS5_EXE
            }
        "#;
        Command::new(&ps)
            .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", updater])
            .env("DS5_PID", std::process::id().to_string())
            .env("DS5_STAGE", &stage.path)
            .env("DS5_SRC", &src)
            .env("DS5_DST", target)
            .env("DS5_EXE", &dst_exe)
            .env("DS5_PORT", port)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .creation_flags(0x0800_0200)
            .spawn()
            .map_err(|_| "无法启动更新替换进程")?;
        stage.keep = true;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (port, &stage);
        Err("当前平台暂不支持客户端自动更新")
    }
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
    if method == "POST" && path == "/api/self-update" {
        if origin != Some(server.origin.as_str()) || !token_matches(token.unwrap_or(""), &server.token) {
            return reply(&mut stream, 403, "text/plain", b"Invalid session", false);
        }
        let Some((url, expected_sha)) = self_update_request(query) else {
            return reply(&mut stream, 400, "text/plain", b"Unsupported self-update request", false);
        };
        let target = match install_target() {
            Ok(p) => p,
            Err(note) => return reply(&mut stream, 400, "text/plain", note.as_bytes(), false),
        };
        if server.downloading.swap(true, Ordering::AcqRel) {
            return reply(&mut stream, 503, "text/plain", b"A download is already running", false);
        }
        let dl = download_release(&url);
        let outcome = match dl {
            Ok(bytes) => {
                let port = server.host.rsplit(':').next().unwrap_or("8765");
                perform_self_update(&bytes, &expected_sha, &target, port)
                    .map_err(|msg| (400u16, msg))
            }
            Err(message) => Err((502u16, message)),
        };
        server.downloading.store(false, Ordering::Release);
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;
        return match outcome {
            Ok(()) => {
                let res = reply(&mut stream, 200, "application/json", br#"{"updated":true,"restarting":true}"#, false);
                server.stopping.store(true, Ordering::Release);
                res
            }
            Err((code, msg)) => reply(&mut stream, code, "text/plain", msg.as_bytes(), false),
        };
    }
    if method != "GET" && !head { return reply(&mut stream, 405, "text/plain", b"Method not allowed", false); }
    if path == "/api/local" {
        let asset = self_asset_name().unwrap_or("");
        let (can_update, note) = match install_target() {
            Ok(_) => (true, ""),
            Err(reason) => (false, reason),
        };
        let data = format!(
            r#"{{"application":"DS5 Control Center","token":"{}","version":"{}","mode":"native","asset":"{}","canSelfUpdate":{},"updateNote":"{}"}}"#,
            server.token, json_escape(APP_VERSION), json_escape(asset), can_update, json_escape(note)
        );
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

// Finder reopens an already-running .app by delivering an Apple event to its
// application delegate; it does not execute the binary a second time.
#[cfg(target_os = "macos")]
mod macos_lifecycle {
    use std::{ffi::{c_char, c_void, CStr}, mem, ptr, sync::OnceLock};
    use super::open_browser;

    type Id = *mut c_void;
    static ORIGIN: OnceLock<String> = OnceLock::new();

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Id;
        fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
        fn objc_registerClassPair(class: Id);
        fn class_addMethod(class: Id, selector: Id, implementation: extern "C" fn(), types: *const c_char) -> bool;
        fn objc_msgSend();
    }

    unsafe fn selector(name: &'static CStr) -> Id { sel_registerName(name.as_ptr()) }
    unsafe fn send0(target: Id, name: &'static CStr) -> Id {
        let send: unsafe extern "C" fn(Id, Id) -> Id = mem::transmute(objc_msgSend as *const ());
        send(target, selector(name))
    }
    unsafe fn send1(target: Id, name: &'static CStr, value: Id) {
        let send: unsafe extern "C" fn(Id, Id, Id) = mem::transmute(objc_msgSend as *const ());
        send(target, selector(name), value);
    }
    extern "C" fn reopen(_delegate: Id, _cmd: Id, _app: Id, _visible: bool) -> bool {
        if let Some(origin) = ORIGIN.get() { open_browser(origin); }
        true
    }

    pub fn run(origin: String) -> std::io::Result<()> {
        ORIGIN.set(origin).map_err(|_| std::io::Error::other("Application already initialized"))?;
        unsafe {
            let pool = send0(objc_getClass(c"NSAutoreleasePool".as_ptr()), c"new");
            let app = send0(objc_getClass(c"NSApplication".as_ptr()), c"sharedApplication");
            let class = objc_allocateClassPair(objc_getClass(c"NSObject".as_ptr()), c"DS5ControlCenterDelegate".as_ptr(), 0);
            if class.is_null() { return Err(std::io::Error::other("Cannot initialize application delegate")); }
            let imp: extern "C" fn() = mem::transmute(reopen as extern "C" fn(Id, Id, Id, bool) -> bool);
            if !class_addMethod(class, selector(c"applicationShouldHandleReopen:hasVisibleWindows:"), imp, c"B@:@B".as_ptr()) {
                return Err(std::io::Error::other("Cannot register application delegate"));
            }
            objc_registerClassPair(class);
            let delegate = send0(class, c"new");
            send1(app, c"setDelegate:", delegate);
            send0(app, c"run");
            send1(app, c"setDelegate:", ptr::null_mut());
            send0(delegate, c"release");
            send0(pool, c"drain");
        }
        Ok(())
    }

    pub fn stop() {
        unsafe {
            let app = send0(objc_getClass(c"NSApplication".as_ptr()), c"sharedApplication");
            let send: unsafe extern "C" fn(Id, Id, Id, Id, bool) = mem::transmute(objc_msgSend as *const ());
            // stop: only exits after another event arrives; terminate: also
            // works when this background-only application has no windows.
            send(app, selector(c"performSelectorOnMainThread:withObject:waitUntilDone:"), selector(c"terminate:"), ptr::null_mut(), false);
        }
    }
}

fn serve_loop(listener: TcpListener, server: Arc<Server>) -> io::Result<()> {
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
    #[cfg(target_os = "macos")]
    if open {
        let origin = server.origin.clone();
        let worker = thread::spawn(move || { let result = serve_loop(listener, server); macos_lifecycle::stop(); result });
        macos_lifecycle::run(origin)?;
        return worker.join().map_err(|_| io::Error::other("Server thread failed"))?;
    }
    serve_loop(listener, server)
}
fn main() {
    if let Err(e) = run() { eprintln!("{e}"); std::process::exit(1); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_nist_vectors() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha256_hex(b"hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    }

    #[test]
    fn self_update_query_rejects_foreign_repo_and_bad_sha() {
        let Some(asset) = self_asset_name() else { return; };
        let good_sha = "a".repeat(64);
        let q = format!("repo=lx8s8%2Fds5dongle-bl618-opensource-gyro&tag=v3.18-g2.4-rc8&name={asset}&sha256={good_sha}");
        assert!(self_update_request(&q).is_some());
        assert!(self_update_request(&format!("repo=evil%2Frepo&tag=v1&name={asset}&sha256={good_sha}")).is_none());
        assert!(self_update_request("repo=lx8s8%2Fds5dongle-bl618-opensource-gyro&tag=v1&name=other.zip&sha256=aaaa").is_none());
        assert!(self_update_request(&format!("repo=lx8s8%2Fds5dongle-bl618-opensource-gyro&tag=v1&name={asset}&sha256=short")).is_none());
    }
}
