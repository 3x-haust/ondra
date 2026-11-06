//! Ondra's native shell: the main window and ⌥Space quick input, the menu bar
//! item, and the modules that own processes and files:
//!   engine  — agent processes (bundled 3xhaustPi engine, RPC over stdio)
//!   pty     — in-app terminals (and account login)
//!   tools   — bundled agent-browser + Chrome, agent-desktop, permissions
//!   browser — the one shared browser every job uses (own tab, shared logins)
//!   keychain — sign-in from the macOS keychain without the agent seeing it
//!   store   — state file, accounts, opening files, inbox folder
//!   git     — what a task changed
//!   import  — rules, skills, memory and sessions from other agent tools

mod update;
mod browser;
mod inbrowser;
mod devices;
mod engine;
pub mod focus;
mod keychain;
mod git;
mod import;
mod pty;
mod store;
mod tools;
mod worktree;
mod fs;
#[cfg(debug_assertions)]
mod devbridge;
mod bridge;
mod embed;

use tauri::{
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TRAY_ID: &str = "main";

// The main window also holds the in-app browser's webview, so it is found as a
// window (show, focus, title) and its page as a webview (events), never as a
// single "webview window", which a window with two webviews isn't.
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_capture(app: &AppHandle) {
    let Some(w) = app.get_webview_window("capture") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("capture:opened", ());
    }
}

#[tauri::command]
fn open_capture(app: AppHandle) {
    toggle_capture(&app);
}

#[tauri::command]
fn hide_capture(app: AppHandle) {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
}

/// The quick input hands a task to the main window, where the captain picks it up.
#[tauri::command]
fn submit_capture(app: AppHandle, text: String, space: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("내용이 비어 있습니다".into());
    }
    app.emit_to("main", "capture:submitted", serde_json::json!({ "text": text, "space": space }))
        .map_err(|e| e.to_string())?;
    hide_capture(app);
    Ok(())
}

/// Running / waiting counts next to the menu bar icon.
#[tauri::command]
fn set_tray_count(app: AppHandle, running: u32, waiting: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let mut parts = vec![];
        if running > 0 {
            parts.push(format!("▶︎{running}"));
        }
        if waiting > 0 {
            parts.push(format!("●{waiting}"));
        }
        let title = if parts.is_empty() { String::new() } else { format!(" {}", parts.join(" ")) };
        let _ = tray.set_title(Some(title));
    }
}

fn kill_children(app: &AppHandle) {
    app.state::<engine::Engine>().kill_all();
    app.state::<pty::Ptys>().kill_all();
    browser::stop(app);
}

/// `ondra --keychain-credential`: agent-browser's credential plugin (see keychain.rs).
/// Returns the exit code when the binary was started as a plugin.
pub fn plugin_mode() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    (args.first().map(String::as_str) == Some(keychain::FLAG)).then(|| keychain::plugin_main(&args[1..]))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Local settings that don't belong in the code (see `.env.example`): read
/// `KEY=value` lines from `<data dir>/.env` (and, in a dev build, the repo's
/// `.env`). Variables already set win. Jobs inherit them.
fn load_env() {
    let mut files = vec![];
    if let Some(home) = std::env::var_os("HOME") {
        files.push(std::path::PathBuf::from(home).join("Library/Application Support/dev.3xhaust.ondra/.env"));
    }
    #[cfg(debug_assertions)]
    files.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env"));
    for f in files {
        let Ok(text) = std::fs::read_to_string(&f) else { continue };
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else { continue };
            let (k, v) = (k.trim(), v.trim().trim_matches('"').trim_matches('\''));
            if !k.is_empty() && std::env::var_os(k).is_none() {
                // SAFETY: runs first thing in `run`, before any other thread exists
                unsafe { std::env::set_var(k, v) };
            }
        }
    }
}

pub fn run() {
    load_env();
    let capture_shortcut = Shortcut::new(Some(Modifiers::ALT), Code::Space);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if shortcut == &capture_shortcut && event.state() == ShortcutState::Pressed {
                        toggle_capture(app);
                    }
                })
                .build(),
        )
        .manage(engine::Engine::default())
        .manage(pty::Ptys::default())
        .manage(browser::Shared::default())
        .setup(move |app| {
            #[cfg(debug_assertions)]
            devbridge::start(app.handle().clone());
            store::watch_inbox(app.handle().clone());
            {
                let handle = app.handle().clone();
                focus::install(move || handle.state::<engine::Engine>().pids());
            }
            // ⌘W closes the right panel, not the window (the window hides with ⌘H or its button)
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                for kind in menu.items()? {
                    let Some(sub) = kind.as_submenu() else { continue };
                    for (i, item) in sub.items()?.into_iter().enumerate() {
                        let close = item.as_predefined_menuitem().is_some_and(|p| p.text().is_ok_and(|t| t.contains("Close")));
                        if close {
                            sub.remove(&item)?;
                            let panel = MenuItem::with_id(app, "close-panel", "패널 닫기", true, Some("CmdOrCtrl+W"))?;
                            sub.insert(&panel, i)?;
                        }
                    }
                }
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id.as_ref() == "close-panel" {
                        if let Some(w) = app.get_webview("main") {
                            let _ = w.emit("panel:close", ());
                        }
                    }
                });
            }
            bridge::start(app.handle().clone());
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            // A dev build is a bare executable, not an .app: Stage Manager and
            // notifications show its file icon (a blank page). Give the file the
            // brand icon after every rebuild; the bundled app has it from Info.plist.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if let Ok(exe) = std::env::current_exe() {
                let icns = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/icon.icns");
                let js = format!(
                    "ObjC.import('AppKit');$.NSWorkspace.sharedWorkspace.setIconForFileOptions($.NSImage.alloc.initWithContentsOfFile({:?}),{:?},0)",
                    icns.to_string_lossy(),
                    exe.to_string_lossy()
                );
                let _ = std::process::Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", &js]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
            }

            if let Err(e) = app.global_shortcut().register(capture_shortcut) {
                eprintln!("⌥Space is taken by another app ({e}); quick input stays in the menu");
            }

            // The display name comes only from `productName` in tauri.conf.json.
            let name = app.package_info().name.clone();
            for (label, title) in [("main", name.clone()), ("capture", format!("{name} 빠른 입력"))] {
                if let Some(w) = app.get_window(label) {
                    let _ = w.set_title(&title);
                }
            }

            let open = MenuItem::with_id(app, "open", format!("{name} 열기"), true, None::<&str>)?;
            let capture = MenuItem::with_id(app, "capture", "빠른 입력  ⌥Space", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&open, &capture, &PredefinedMenuItem::separator(app)?, &quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "capture" => toggle_capture(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match (window.label(), event) {
            // Closing the main window keeps the app running in the menu bar.
            ("main", WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // The quick input behaves like Spotlight: it goes away when focus leaves.
            ("capture", WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            update::update_check,
            update::update_install,
            open_capture,
            hide_capture,
            submit_capture,
            set_tray_count,
            focus::focus_guard,
            engine::engine_info,
            engine::agent_spawn,
            engine::agent_send,
            engine::agent_kill,
            engine::agent_alive,
            engine::engine_models,
            pty::pty_open,
            pty::pty_open_login,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            store::state_load,
            store::sessions_prune,
            store::memory_mirror,
            store::memory_sources,
            store::memory_folder,
            store::artifacts_list,
            store::state_save,
            store::artifacts_dir,
            store::pick_folder,
            store::reveal_path,
            store::open_url,
            store::open_in_editor,
            store::open_in_terminal,
            store::account_dir_path,
            store::account_providers,
            store::account_remove,
            store::memory_git_commit,
            store::memory_git_log,
            store::memory_git_show,
            store::paths_exist,
            git::git_changes,
            worktree::worktree_create,
            fs::fs_files,
            fs::fs_repos,
            fs::fs_read,
            fs::save_paste,
            fs::clipboard_files,
            fs::save_download,
            fs::ensure_dir,
            fs::space_logs,
            worktree::worktree_merge,
            worktree::worktree_remove,
            worktree::worktree_landed,
            store::pick_files,
            #[cfg(debug_assertions)]
            devbridge::dev_report,
            bridge::bridge_reply,
            embed::embed_texts,
            import::scan_agents,
            import::read_transcript,
            tools::tool_status,
            tools::request_accessibility,
            tools::open_privacy_settings,
            tools::worker_env,
            tools::worker_skills,
            tools::global_skills,
            tools::space_env,
            tools::space_tools,
            tools::space_gh_login,
            tools::space_git_identity,
            tools::skill_list,
            tools::skill_save,
            tools::skill_remove,
            tools::hooks_load,
            tools::hooks_save,
            tools::worker_extensions,
            store::account_limits,
            store::account_email,
            tools::notify,
            git::git_commit,
            git::git_push,
            git::git_pr,
            git::gh_pr_state,
            git::gh_pr_view,
            git::git_revert_file,
            tools::browser_stream_port,
            browser::shared_browser_open,
            browser::browser_check,
            browser::shared_browser_go,
            inbrowser::inbrowser_show,
            inbrowser::inbrowser_hide,
            inbrowser::inbrowser_go,
            inbrowser::inbrowser_share,
            browser::browser_release,
            devices::devices_list,
            devices::device_boot,
            devices::device_shutdown,
            devices::device_delete,
            devices::device_shot,
            devices::device_input,
            devices::job_devices_release,
            devices::live::device_stream,
            devices::live::device_stream_stop,
            devices::live::device_stream_poke,
            devices::live::device_input_warm,
            devices::live::device_touch,
            devices::live::device_release,
            devices::live::device_key,
            devices::live::device_keyboard,
            devices::live::device_rotate,
            devices::live::device_landscape,
            devices::live::device_screenshot,
            devices::live::device_record,
            devices::live::device_recording,
        ])
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|app, event| match event {
        RunEvent::Reopen { .. } => show_main(app),
        // Never leave agent or terminal processes behind.
        RunEvent::Exit => kill_children(app),
        _ => {}
    });
}
