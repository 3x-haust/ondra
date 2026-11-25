// Key names (`Enter`, `Control+a`, `Shift+Tab`) → CDP key events.

use crate::util::Res;

#[derive(Clone)]
pub struct KeyDef {
    pub key: String,
    pub code: String,
    pub key_code: i64,
    pub text: Option<String>,
}

fn def(key: &str, code: &str, kc: i64, text: Option<&str>) -> KeyDef {
    KeyDef { key: key.into(), code: code.into(), key_code: kc, text: text.map(String::from) }
}

fn named(name: &str) -> Option<KeyDef> {
    let n = name.to_lowercase();
    Some(match n.as_str() {
        "enter" | "return" => def("Enter", "Enter", 13, Some("\r")),
        "tab" => def("Tab", "Tab", 9, None),
        "escape" | "esc" => def("Escape", "Escape", 27, None),
        "backspace" => def("Backspace", "Backspace", 8, None),
        "delete" | "del" => def("Delete", "Delete", 46, None),
        "space" | " " => def(" ", "Space", 32, Some(" ")),
        "arrowup" | "up" => def("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => def("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => def("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => def("ArrowRight", "ArrowRight", 39, None),
        "home" => def("Home", "Home", 36, None),
        "end" => def("End", "End", 35, None),
        "pageup" => def("PageUp", "PageUp", 33, None),
        "pagedown" => def("PageDown", "PageDown", 34, None),
        "insert" => def("Insert", "Insert", 45, None),
        "shift" => def("Shift", "ShiftLeft", 16, None),
        "control" | "ctrl" => def("Control", "ControlLeft", 17, None),
        "alt" | "option" => def("Alt", "AltLeft", 18, None),
        "meta" | "command" | "cmd" => def("Meta", "MetaLeft", 91, None),
        _ => {
            let f: i64 = n.strip_prefix('f')?.parse().ok().filter(|i| (1..=12).contains(i))?;
            let k = format!("F{f}");
            def(&k, &k, 111 + f, None)
        }
    })
}

/// One key without modifiers: a name from the table, or one character.
pub fn key_def(name: &str) -> Option<KeyDef> {
    if let Some(d) = named(name) {
        return Some(d);
    }
    let mut it = name.chars();
    let ch = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let s = ch.to_string();
    if ch.is_ascii_alphabetic() {
        let up = s.to_uppercase();
        return Some(def(&s, &format!("Key{up}"), up.chars().next().unwrap() as i64, Some(&s)));
    }
    if ch.is_ascii_digit() {
        return Some(def(&s, &format!("Digit{s}"), ch as i64, Some(&s)));
    }
    let punct = match ch {
        '-' => Some(("Minus", 189)),
        '=' => Some(("Equal", 187)),
        '[' => Some(("BracketLeft", 219)),
        ']' => Some(("BracketRight", 221)),
        '\\' => Some(("Backslash", 220)),
        ';' => Some(("Semicolon", 186)),
        '\'' => Some(("Quote", 222)),
        ',' => Some(("Comma", 188)),
        '.' => Some(("Period", 190)),
        '/' => Some(("Slash", 191)),
        '`' => Some(("Backquote", 192)),
        _ => None,
    };
    if let Some((code, kc)) = punct {
        return Some(def(&s, code, kc, Some(&s)));
    }
    Some(def(&s, "", 0, Some(&s)))
}

/// CDP modifier bits: Alt 1, Control 2, Meta 4, Shift 8. `ControlOrMeta` is Control off macOS.
pub fn modifier_bit(name: &str) -> Option<i64> {
    match name.to_lowercase().as_str() {
        "alt" | "option" => Some(1),
        "control" | "ctrl" => Some(2),
        "controlormeta" => Some(if cfg!(target_os = "macos") { 4 } else { 2 }),
        "meta" | "command" | "cmd" => Some(4),
        "shift" => Some(8),
        _ => None,
    }
}

/// `Control+Shift+a` → (modifiers, key). The last part is the key.
pub fn parse_combo(combo: &str) -> Res<(i64, KeyDef)> {
    let mut parts: Vec<String> = combo.split('+').map(String::from).collect();
    // "+" itself, or "Control++"
    if combo.ends_with("++") || combo == "+" {
        parts.truncate(parts.len().saturating_sub(2));
        parts.push("+".into());
    }
    let last = parts.last().filter(|l| !l.is_empty()).ok_or_else(|| format!("Unknown key: {combo}"))?;
    let d = key_def(last).ok_or_else(|| format!("Unknown key: {combo}"))?;
    let mut mods = 0;
    for m in &parts[..parts.len() - 1] {
        mods |= modifier_bit(m).ok_or_else(|| format!("Unknown modifier {m} in {combo}"))?;
    }
    Ok((mods, d))
}

/// The editing command Chrome would run for a shortcut (CDP does not map them itself).
pub fn editing_command(mods: i64, d: &KeyDef) -> Option<String> {
    if mods & 6 == 0 || mods & 1 != 0 {
        return None;
    }
    Some(
        match d.key.to_lowercase().as_str() {
            "a" => "selectAll",
            "c" => "copy",
            "x" => "cut",
            "v" => "paste",
            "z" => {
                if mods & 8 != 0 {
                    "redo"
                } else {
                    "undo"
                }
            }
            _ => return None,
        }
        .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combos() {
        let (m, d) = parse_combo("Control+Shift+a").unwrap();
        assert_eq!((m, d.code.as_str()), (10, "KeyA"));
        assert_eq!(parse_combo("Control++").unwrap().1.key, "+");
        assert_eq!(parse_combo("F5").unwrap().1.key_code, 116);
        assert!(parse_combo("Hyper+a").is_err());
        assert_eq!(editing_command(2, &key_def("a").unwrap()).as_deref(), Some("selectAll"));
    }
}
