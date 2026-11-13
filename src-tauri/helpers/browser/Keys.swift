// Key names (`Enter`, `Control+a`, `Shift+Tab`) → CDP key events.

import Foundation

struct KeyDef {
    let key: String
    let code: String
    let keyCode: Int
    let text: String?
}

private let named: [String: KeyDef] = {
    var m: [String: KeyDef] = [:]
    func add(_ names: [String], _ key: String, _ code: String, _ kc: Int, _ text: String? = nil) {
        for n in names { m[n.lowercased()] = KeyDef(key: key, code: code, keyCode: kc, text: text) }
    }
    add(["Enter", "Return"], "Enter", "Enter", 13, "\r")
    add(["Tab"], "Tab", "Tab", 9)
    add(["Escape", "Esc"], "Escape", "Escape", 27)
    add(["Backspace"], "Backspace", "Backspace", 8)
    add(["Delete", "Del"], "Delete", "Delete", 46)
    add(["Space", " "], " ", "Space", 32, " ")
    add(["ArrowUp", "Up"], "ArrowUp", "ArrowUp", 38)
    add(["ArrowDown", "Down"], "ArrowDown", "ArrowDown", 40)
    add(["ArrowLeft", "Left"], "ArrowLeft", "ArrowLeft", 37)
    add(["ArrowRight", "Right"], "ArrowRight", "ArrowRight", 39)
    add(["Home"], "Home", "Home", 36)
    add(["End"], "End", "End", 35)
    add(["PageUp"], "PageUp", "PageUp", 33)
    add(["PageDown"], "PageDown", "PageDown", 34)
    add(["Insert"], "Insert", "Insert", 45)
    add(["Shift"], "Shift", "ShiftLeft", 16)
    add(["Control", "Ctrl"], "Control", "ControlLeft", 17)
    add(["Alt", "Option"], "Alt", "AltLeft", 18)
    add(["Meta", "Command", "Cmd"], "Meta", "MetaLeft", 91)
    for i in 1...12 { add(["F\(i)"], "F\(i)", "F\(i)", 111 + i) }
    return m
}()

/// One key without modifiers: a name from the table, or one character.
func keyDef(_ name: String) -> KeyDef? {
    if let d = named[name.lowercased()] { return d }
    guard name.count == 1, let ch = name.first else { return nil }
    let s = String(ch)
    if ch.isLetter, ch.isASCII {
        let up = s.uppercased()
        return KeyDef(key: s, code: "Key\(up)", keyCode: Int(up.unicodeScalars.first!.value), text: s)
    }
    if ch.isNumber, ch.isASCII {
        return KeyDef(key: s, code: "Digit\(s)", keyCode: Int(s.unicodeScalars.first!.value), text: s)
    }
    let punct: [Character: (String, Int)] = [
        "-": ("Minus", 189), "=": ("Equal", 187), "[": ("BracketLeft", 219), "]": ("BracketRight", 221),
        "\\": ("Backslash", 220), ";": ("Semicolon", 186), "'": ("Quote", 222), ",": ("Comma", 188),
        ".": ("Period", 190), "/": ("Slash", 191), "`": ("Backquote", 192),
    ]
    if let (code, kc) = punct[ch] { return KeyDef(key: s, code: code, keyCode: kc, text: s) }
    return KeyDef(key: s, code: "", keyCode: 0, text: s)
}

/// CDP modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
func modifierBit(_ name: String) -> Int? {
    switch name.lowercased() {
    case "alt", "option": return 1
    case "control", "ctrl": return 2
    case "meta", "command", "cmd", "controlormeta": return 4
    case "shift": return 8
    default: return nil
    }
}

/// `Control+Shift+a` → (modifiers, key). The last part is the key.
func parseCombo(_ combo: String) throws -> (Int, KeyDef) {
    var parts = combo.components(separatedBy: "+")
    // "+" itself, or "Control++"
    if combo.hasSuffix("++") || combo == "+" { parts = Array(parts.dropLast(2)) + ["+"] }
    guard let last = parts.last, !last.isEmpty, let def = keyDef(last) else { throw BrowserError("Unknown key: \(combo)") }
    var mods = 0
    for m in parts.dropLast() {
        guard let bit = modifierBit(m) else { throw BrowserError("Unknown modifier \(m) in \(combo)") }
        mods |= bit
    }
    return (mods, def)
}

/// The editing command macOS Chrome would run for a shortcut (CDP does not map them itself).
func editingCommand(_ mods: Int, _ def: KeyDef) -> String? {
    guard mods & 6 != 0, mods & 1 == 0 else { return nil }
    switch def.key.lowercased() {
    case "a": return "selectAll"
    case "c": return "copy"
    case "x": return "cut"
    case "v": return "paste"
    case "z": return mods & 8 != 0 ? "redo" : "undo"
    default: return nil
    }
}
