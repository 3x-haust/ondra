//! The keys the native side answers to, as Settings › 단축키 binds them: the quick
//! input's global hotkey (⌥Space), Quit held down (⌘Q) and the app menu's Close (⌘W).
//! The app sends each as chord text (src/lib/shortcuts.ts `chordText`: "alt+Space",
//! physical key last; null for unbound). They are kept in keys.json too, so the next
//! launch registers them in `setup`, before the page loads.

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Mutex,
};
use tauri::{menu::MenuItem, AppHandle, Manager, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Keys {
    /// the quick input, from any app
    pub capture: Option<String>,
    /// held to quit
    pub quit: Option<String>,
    /// the menu's Close: the focused pane, else the panel
    pub close_pane: Option<String>,
}

impl Default for Keys {
    fn default() -> Self {
        Self { capture: Some("alt+Space".into()), quit: Some("cmd+KeyQ".into()), close_pane: Some("cmd+KeyW".into()) }
    }
}

/// What a menu item stands for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    /// the app menu's and the tray's Quit
    Quit,
    /// the app menu's Close
    Close,
    /// the tray's quick input, whose title shows the hotkey
    Capture,
}

#[derive(Default)]
pub struct Native {
    items: Mutex<Vec<(Role, MenuItem<Wry>)>>,
    capture: Mutex<Option<Shortcut>>,
}

const NO_KEY: u16 = u16::MAX;
/// the macOS key code Quit waits on while it is held (kVK_ANSI_Q)
static QUIT_KEY: AtomicU16 = AtomicU16::new(12);
/// the key Quit is held on, if it has one hold_to_quit can watch
pub fn quit_key() -> Option<u16> {
    Some(QUIT_KEY.load(Ordering::Relaxed)).filter(|k| *k != NO_KEY)
}

/// The chord as muda (menu accelerators) and global-hotkey read it: the same text, both
/// take "cmd" for ⌘ and the e.code name for the key. None: no key (modifiers held on
/// their own, "none").
pub fn accelerator(text: &str) -> Option<String> {
    let mut parts: Vec<&str> = text.split('+').collect();
    let code = parts.pop().filter(|c| c.chars().next().is_some_and(|c| c.is_ascii_uppercase()))?;
    let mods = parts.iter().all(|p| ["ctrl", "alt", "shift", "cmd"].contains(p));
    (mods && code.chars().all(|c| c.is_ascii_alphanumeric())).then(|| text.to_string())
}

fn key_code(code: &str) -> Option<u16> {
    // kVK_* from HIToolbox/Events.h: the ANSI positions, so any layout's Q is 12
    Some(match code {
        "KeyA" => 0, "KeyS" => 1, "KeyD" => 2, "KeyF" => 3, "KeyH" => 4, "KeyG" => 5, "KeyZ" => 6, "KeyX" => 7,
        "KeyC" => 8, "KeyV" => 9, "IntlBackslash" => 10, "KeyB" => 11, "KeyQ" => 12, "KeyW" => 13, "KeyE" => 14,
        "KeyR" => 15, "KeyY" => 16, "KeyT" => 17, "Digit1" => 18, "Digit2" => 19, "Digit3" => 20, "Digit4" => 21,
        "Digit6" => 22, "Digit5" => 23, "Equal" => 24, "Digit9" => 25, "Digit7" => 26, "Minus" => 27, "Digit8" => 28,
        "Digit0" => 29, "BracketRight" => 30, "KeyO" => 31, "KeyU" => 32, "BracketLeft" => 33, "KeyI" => 34,
        "KeyP" => 35, "Enter" => 36, "KeyL" => 37, "KeyJ" => 38, "Quote" => 39, "KeyK" => 40, "Semicolon" => 41,
        "Backslash" => 42, "Comma" => 43, "Slash" => 44, "KeyN" => 45, "KeyM" => 46, "Period" => 47, "Tab" => 48,
        "Space" => 49, "Backquote" => 50, "Backspace" => 51, "Escape" => 53, "F17" => 64, "F18" => 79, "F19" => 80,
        "F20" => 90, "F5" => 96, "F6" => 97, "F7" => 98, "F3" => 99, "F8" => 100, "F9" => 101, "F11" => 103,
        "F13" => 105, "F16" => 106, "F14" => 107, "F10" => 109, "F12" => 111, "F15" => 113, "Home" => 115,
        "PageUp" => 116, "Delete" => 117, "F4" => 118, "End" => 119, "F2" => 120, "PageDown" => 121, "F1" => 122,
        "ArrowLeft" => 123, "ArrowRight" => 124, "ArrowDown" => 125, "ArrowUp" => 126,
        _ => return None,
    })
}
/// the macOS key code of a chord's key ("cmd+KeyQ" → 12)
pub fn keycode(text: &str) -> Option<u16> {
    key_code(text.rsplit('+').next()?)
}

/// "⌥Space", as the tray's menu shows it beside 빠른 입력
pub fn label(text: &str) -> String {
    let mut parts: Vec<&str> = text.split('+').collect();
    let code = parts.pop().unwrap_or_default();
    let mods = [("ctrl", "⌃"), ("alt", "⌥"), ("shift", "⇧"), ("cmd", "⌘")];
    let mut out: String = mods.iter().filter(|(m, _)| parts.contains(m)).map(|(_, g)| *g).collect();
    let key = match code {
        "Comma" => ",", "Period" => ".", "Slash" => "/", "Backslash" => "\\", "Backquote" => "`", "BracketLeft" => "[",
        "BracketRight" => "]", "Semicolon" => ";", "Quote" => "'", "Equal" => "=", "Minus" => "−", "Tab" => "⇥",
        "Enter" => "↵", "Backspace" => "⌫", "Delete" => "⌦", "Escape" => "⎋", "ArrowLeft" => "←", "ArrowRight" => "→",
        "ArrowUp" => "↑", "ArrowDown" => "↓",
        c => c.strip_prefix("Key").or_else(|| c.strip_prefix("Digit")).unwrap_or(c),
    };
    out.push_str(key);
    out
}
const QUICK_INPUT: &str = "빠른 입력";
pub fn capture_title(keys: &Keys) -> String {
    match &keys.capture {
        Some(k) => format!("{QUICK_INPUT}  {}", label(k)),
        None => QUICK_INPUT.into(),
    }
}

fn file(app: &AppHandle) -> std::path::PathBuf {
    crate::engine::data_dir(app).join("keys.json")
}
/// What was set last time, else the defaults.
pub fn load(app: &AppHandle) -> Keys {
    std::fs::read_to_string(file(app)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// A menu item that follows a key (made in `setup`, with `load`'s accelerator).
pub fn track(app: &AppHandle, role: Role, item: MenuItem<Wry>) {
    app.state::<Native>().items.lock().unwrap_or_else(|e| e.into_inner()).push((role, item));
}

/// Puts the keys in place: menu accelerators, the hold-to-quit key and the global
/// hotkey. Returns what couldn't be taken ("capture": another app holds that hotkey).
pub fn apply(app: &AppHandle, keys: &Keys) -> Vec<String> {
    let native = app.state::<Native>();
    for (role, item) in native.items.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        let _ = match role {
            Role::Quit => item.set_accelerator(keys.quit.as_deref().and_then(accelerator)),
            Role::Close => item.set_accelerator(keys.close_pane.as_deref().and_then(accelerator)),
            Role::Capture => item.set_text(capture_title(keys)),
        };
    }
    QUIT_KEY.store(keys.quit.as_deref().and_then(keycode).unwrap_or(NO_KEY), Ordering::Relaxed);

    let mut failed = Vec::new();
    let next = keys.capture.as_deref().and_then(accelerator).and_then(|a| a.parse::<Shortcut>().ok());
    let mut held = native.capture.lock().unwrap_or_else(|e| e.into_inner());
    if *held != next {
        if let Some(old) = held.take() {
            let _ = app.global_shortcut().unregister(old);
        }
        if let Some(s) = next {
            match app.global_shortcut().register(s) {
                Ok(()) => *held = Some(s),
                Err(e) => {
                    eprintln!("{} is taken by another app ({e}); quick input stays in the menu", keys.capture.as_deref().unwrap_or_default());
                    failed.push("capture".into());
                }
            }
        }
    }
    failed
}

/// the hotkey quick input answers to now
pub fn is_capture(app: &AppHandle, shortcut: &Shortcut) -> bool {
    app.state::<Native>().capture.lock().unwrap_or_else(|e| e.into_inner()).as_ref() == Some(shortcut)
}

/// Settings › 단축키 changed one of them: in place now, and with `save` from the next launch
/// on (not while a key is being recorded, when they are all let go for the page to see).
#[tauri::command]
pub fn keys_apply(app: AppHandle, keys: Keys, save: bool) -> Vec<String> {
    if let Some(json) = save.then(|| serde_json::to_string(&keys).ok()).flatten() {
        let _ = std::fs::write(file(&app), json);
    }
    apply(&app, &keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_the_app_writes() {
        let keys: Keys = serde_json::from_str(r#"{"capture":"ctrl+alt+Space","quit":null}"#).unwrap();
        // a field not there keeps its default; null is unbound
        assert_eq!(keys, Keys { capture: Some("ctrl+alt+Space".into()), quit: None, close_pane: Some("cmd+KeyW".into()) });
        assert_eq!(serde_json::from_str::<Keys>("{}").unwrap(), Keys::default());
        let round: Keys = serde_json::from_str(&serde_json::to_string(&keys).unwrap()).unwrap();
        assert_eq!(round, keys);
    }

    #[test]
    fn speaks_muda_and_global_hotkey() {
        assert_eq!(accelerator("cmd+KeyQ").as_deref(), Some("cmd+KeyQ"));
        assert_eq!(accelerator("ctrl+alt+shift+cmd+BracketLeft").as_deref(), Some("ctrl+alt+shift+cmd+BracketLeft"));
        assert_eq!(accelerator("F7").as_deref(), Some("F7"));
        for bad in ["", "cmd", "cmd+", "hyper+KeyQ", "none", "cmd+Key-Q"] {
            assert_eq!(accelerator(bad), None, "{bad}");
        }
        // the global hotkey reads it as the same chord
        let s: Shortcut = accelerator("alt+Space").unwrap().parse().unwrap();
        assert_eq!(s, Shortcut::new(Some(tauri_plugin_global_shortcut::Modifiers::ALT), tauri_plugin_global_shortcut::Code::Space));
        let s: Shortcut = accelerator("shift+cmd+KeyK").unwrap().parse().unwrap();
        use tauri_plugin_global_shortcut::{Code, Modifiers};
        assert_eq!(s, Shortcut::new(Some(Modifiers::SHIFT | Modifiers::SUPER), Code::KeyK));
        for text in ["ctrl+Backquote", "alt+cmd+ArrowUp", "cmd+Comma", "ctrl+F5", "cmd+Digit1", "cmd+Equal", "cmd+Slash"] {
            assert!(accelerator(text).unwrap().parse::<Shortcut>().is_ok(), "{text}");
        }
    }

    #[test]
    fn knows_the_held_key() {
        assert_eq!(keycode("cmd+KeyQ"), Some(12));
        assert_eq!(keycode("ctrl+cmd+KeyW"), Some(13));
        assert_eq!(keycode("alt+F4"), Some(118));
        assert_eq!(keycode("cmd+ArrowUp"), Some(126));
        assert_eq!(keycode("cmd+NumpadEnter"), None);
    }

    #[test]
    fn titles_the_tray_item() {
        assert_eq!(capture_title(&Keys::default()), "빠른 입력  ⌥Space");
        assert_eq!(label("ctrl+alt+shift+cmd+KeyD"), "⌃⌥⇧⌘D");
        assert_eq!(label("ctrl+Backquote"), "⌃`");
        assert_eq!(capture_title(&Keys { capture: None, ..Keys::default() }), "빠른 입력");
    }
}
