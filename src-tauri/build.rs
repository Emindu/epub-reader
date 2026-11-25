fn main() {
    // `embedded_llm`: llama.cpp is linked in (llm_embedded.rs) instead of
    // shelling out to `llama-cli`. Always on iOS, opt-in elsewhere.
    println!("cargo:rustc-check-cfg=cfg(embedded_llm)");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let embedded = target_os == "ios" || std::env::var_os("CARGO_FEATURE_EMBEDDED_LLM").is_some();
    if embedded {
        println!("cargo:rustc-cfg=embedded_llm");
        // On iOS the final link is done by Xcode's clang, which brings the
        // runtime itself (and tauri's swift-rs links it too).
        if target_os == "macos" {
            link_clang_runtime();
        }
    }
    tauri_build::build()
}

/// ggml's Metal code uses `@available(...)`, which compiles to calls to
/// `__isPlatformVersionAtLeast` whenever the deployment target is older than
/// the checked OS version. That lives in clang's runtime library, which rustc
/// doesn't link (`-nodefaultlibs`), so link it here.
fn link_clang_runtime() {
    let out = std::process::Command::new("clang")
        .arg("--print-resource-dir")
        .output()
        .expect("run `clang --print-resource-dir` (are the Xcode tools installed?)");
    let resource_dir = String::from_utf8(out.stdout).expect("utf-8 path");
    let lib_dir = std::path::Path::new(resource_dir.trim()).join("lib").join("darwin");
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
