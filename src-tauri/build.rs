use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let script = manifest.join("../scripts/computer-assets.mjs");
    let assets = manifest.join("resources/computer");
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("output directory")).join("computer_assets.rs");
    let profile = env::var("PROFILE").expect("build profile");
    let target = env::var("TARGET").expect("build target");
    println!("cargo:rerun-if-changed={}", script.display());
    println!("cargo:rerun-if-changed={}", assets.display());
    if profile == "debug" {
        // Tauri's resource mapping may be empty when the feature is unavailable.
        fs::create_dir_all(&assets).expect("computer resource directory");
    }
    let sealed = Command::new("node")
        .arg(&script)
        .arg("seal")
        .arg(&assets)
        .arg(&output)
        .arg(&profile)
        .arg(&target)
        .output()
        .expect("Node.js is required to seal computer assets");
    if !sealed.status.success() {
        panic!(
            "computer asset sealing failed: {}",
            String::from_utf8_lossy(&sealed.stderr)
        );
    }
    if !sealed.stderr.is_empty() {
        println!(
            "cargo:warning={}",
            String::from_utf8_lossy(&sealed.stderr).trim()
        );
    }
    tauri_build::build()
}
