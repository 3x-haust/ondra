// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = ondra_lib::plugin_mode() {
        std::process::exit(code);
    }
    ondra_lib::run()
}
