use std::path::Path;
use std::process::Command;

fn main() {
    // Stamp the binary with the attax repo's HEAD commit so every run record can
    // name the exact build that produced it (the S2 lab driver reads it back via
    // `attax-agree --version`). Falls back to "unknown" outside a git checkout;
    // never fails the build.
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let repo = Path::new(&manifest).join("../..");
    let head = repo.join(".git/HEAD");
    if head.exists() {
        println!("cargo:rerun-if-changed={}", head.display());
    }
    let sha = Command::new("git")
        .args(["-C", &repo.to_string_lossy(), "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ATTAX_BUILD={sha}");
}
