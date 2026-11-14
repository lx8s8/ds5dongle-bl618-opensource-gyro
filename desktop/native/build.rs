use std::{env, fs, path::Path};

fn collect(dir: &Path, root: &Path, entries: &mut Vec<String>) {
    let mut files: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for path in files {
        assert!(!path.is_symlink(), "Web assets must not be symlinks");
        if path.is_dir() {
            collect(&path, root, entries);
        } else {
            let name = path.strip_prefix(root).unwrap().to_str().unwrap().replace('\\', "/");
            let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
                "html" => "text/html; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "js" | "mjs" => "text/javascript; charset=utf-8",
                "svg" => "image/svg+xml",
                "json" => "application/json",
                _ => panic!("Unexpected asset type: {name}"),
            };
            entries.push(format!("({:?}, {:?}, include_bytes!({:?})),", format!("/{name}"), mime, path.to_str().unwrap()));
        }
    }
}
fn main() {
    let root = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../web").canonicalize().unwrap();
    println!("cargo:rerun-if-changed={}", root.display());
    let mut entries = Vec::new();
    collect(&root, &root, &mut entries);
    let source = format!("static ASSETS: &[(&str, &str, &[u8])] = &[\n{}\n];", entries.join("\n"));
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("assets.rs"), source).unwrap();
}
