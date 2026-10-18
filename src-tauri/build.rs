fn main() {
    tauri_build::build();
    // The tray and the dialogs import Windows functions that only exist in version 6 of the common
    // controls, which a program asks for in its manifest. Tauri embeds one in the app, but the
    // library's unit tests are plain executables without it and would not even start
    // (STATUS_ENTRYPOINT_NOT_FOUND). Loading that DLL only when a function of it is first called
    // lets them start: no test ever calls one, and the app has its manifest by then.
    let target = |name| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rustc-link-arg=delayimp.lib");
        println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    }
}
