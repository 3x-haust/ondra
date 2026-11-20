// The main window stays where the user put it, at the size they gave it.
//
// With Stage Manager on, macOS rearranges a window it puts back on its stage: after Mission
// Control it comes back narrowed to fit between the strips, centred (a 1291-wide window came back
// 1084 wide), and coming back from the side strip it can come back moved (161 → 44, same size).
// Plain AppKit windows get the same treatment; we measured it with a bare NSWindow as well as
// Ondra's. The user never asked for either, so the window is put back as it was.
//
// What counts as the user's own: a drag (the mouse is down) or a live resize, the green button,
// full screen, macOS tiling (halves, quarters, fill), another display, and any change made while
// the window has been in front for a while (a window manager's shortcut, Window › Center). What is
// undone: a change nobody dragged that the system made while the window was away from the stage,
// or right as it came back (within `SETTLE`), or that has the Mission Control shape anywhere.

/// A window frame in AppKit's screen coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Frame {
    fn same(self, o: Frame) -> bool {
        (self.x - o.x).abs() <= 1.0 && (self.y - o.y).abs() <= 1.0 && (self.w - o.w).abs() <= 1.0 && (self.h - o.h).abs() <= 1.0
    }
    fn near(self, o: Frame) -> bool {
        (self.x - o.x).abs() <= 2.0 && (self.y - o.y).abs() <= 2.0 && (self.w - o.w).abs() <= 2.0 && (self.h - o.h).abs() <= 2.0
    }
    fn centre_in(self, s: Frame) -> bool {
        let (cx, cy) = (self.x + self.w / 2.0, self.y + self.h / 2.0);
        cx >= s.x && cx <= s.x + s.w && cy >= s.y && cy <= s.y + s.h
    }
}

/// how long after the window comes back to the front a change is still the system's arranging
pub const SETTLE_MS: u64 = 1500;

/// Was `now` (from `intent`, the size the user chose) the system fitting the window onto its
/// stage, inside `screen` (the screen's full frame)? This shape is undone whenever it shows up.
pub fn squeezed_onto_stage(intent: Frame, now: Frame, screen: Frame) -> bool {
    let smaller = now.w < intent.w - 1.0 || now.h < intent.h - 1.0;
    let grew = now.w > intent.w + 1.0 || now.h > intent.h + 1.0;
    let left = now.x - screen.x;
    let right = (screen.x + screen.w) - (now.x + now.w);
    smaller && !grew && left >= 24.0 && (left - right).abs() <= 3.0
}

/// macOS tiling (and the green button's fill): halves, quarters or the whole usable area.
pub fn tiled(now: Frame, visible: Frame) -> bool {
    let (x, y, w, h) = (visible.x, visible.y, visible.w, visible.h);
    let (hw, hh) = (w / 2.0, h / 2.0);
    [
        Frame { x, y, w, h },
        Frame { x, y, w: hw, h },
        Frame { x: x + hw, y, w: hw, h },
        Frame { x, y: y + hh, w, h: hh },
        Frame { x, y, w, h: hh },
        Frame { x, y: y + hh, w: hw, h: hh },
        Frame { x: x + hw, y: y + hh, w: hw, h: hh },
        Frame { x, y, w: hw, h: hh },
        Frame { x: x + hw, y, w: hw, h: hh },
    ]
    .iter()
    .any(|t| now.near(*t))
}

/// A change to the main window that nobody dragged: should it be put back to `intent`?
/// `arriving` says the window is away from the stage or came back to the front within `SETTLE_MS`.
pub fn undo(intent: Frame, now: Frame, screen: Frame, visible: Frame, arriving: bool) -> bool {
    if now.same(intent) {
        return false;
    }
    // moved to another display (or the one it was on went away): that stays
    if !intent.centre_in(screen) {
        return false;
    }
    if squeezed_onto_stage(intent, now, screen) {
        return true;
    }
    arriving && !tiled(now, visible)
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{undo, Frame, SETTLE_MS};
    use objc2::{class, msg_send, runtime::AnyObject};
    use objc2_foundation::NSRect;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    struct Held {
        /// where the user put the window, at the size they gave it
        intent: Option<Frame>,
        restoring: bool,
        /// when the window last came to the front
        arrived: Option<Instant>,
        /// a change nobody dragged that was kept, with where the window was before it: the system
        /// may move the window a moment before the focus comes, and then that is undone too
        before: Option<(Frame, Instant)>,
    }
    static HELD: Mutex<Held> = Mutex::new(Held { intent: None, restoring: false, arrived: None, before: None });

    const FULL_SCREEN: usize = 1 << 14;

    fn frame(r: NSRect) -> Frame {
        Frame { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height }
    }

    struct Seen {
        now: Frame,
        live: bool,
        full: bool,
        screen: Option<(Frame, Frame)>,
        active: bool,
        mouse: bool,
    }

    fn look(app: &AppHandle) -> Option<Seen> {
        let win = app.get_window("main")?;
        let ns = win.ns_window().ok()?;
        let ns = unsafe { (ns as *mut AnyObject).as_ref() }?;
        unsafe {
            let now: NSRect = msg_send![ns, frame];
            let live: bool = msg_send![ns, inLiveResize];
            let style: usize = msg_send![ns, styleMask];
            let screen: *mut AnyObject = msg_send![ns, screen];
            let screen = screen.as_ref().map(|s| {
                let f: NSRect = msg_send![s, frame];
                let v: NSRect = msg_send![s, visibleFrame];
                (frame(f), frame(v))
            });
            let nsapp: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let active: bool = nsapp.as_ref().map(|a| msg_send![a, isActive]).unwrap_or(true);
            let buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];
            Some(Seen { now: frame(now), live, full: style & FULL_SCREEN != 0, screen, active, mouse: buttons != 0 })
        }
    }

    /// Called on the main thread for every move or resize of the main window.
    pub fn on_change(app: &AppHandle) {
        let Some(s) = look(app) else { return };
        let mut held = HELD.lock().unwrap();
        if held.restoring || s.full {
            return;
        }
        let Some(intent) = held.intent else {
            held.intent = Some(s.now);
            return;
        };
        // the user's own hand on it: a drag or a live resize
        if s.live || (s.mouse && s.active) {
            held.intent = Some(s.now);
            held.before = None;
            return;
        }
        // arranged while away from the stage: judged when it comes back (`on_focus`)
        if !s.active {
            return;
        }
        let arriving = held.arrived.is_some_and(|t| t.elapsed() < Duration::from_millis(SETTLE_MS));
        match s.screen {
            Some((screen, visible)) if undo(intent, s.now, screen, visible, arriving) => {
                held.restoring = true;
                held.arrived = None;
                drop(held);
                put_back(app, intent);
            }
            // anything else (zoom, tiling, another display, a shortcut while in front) is kept
            _ => {
                if !intent.same(s.now) {
                    held.before = Some((intent, Instant::now()));
                }
                held.intent = Some(s.now);
            }
        }
    }

    /// Called when the main window gains or loses focus. Coming back to the front (from the side
    /// strip, another app or Mission Control), whatever the system did to it meanwhile is undone.
    pub fn on_focus(app: &AppHandle, focused: bool) {
        if !focused {
            return;
        }
        HELD.lock().unwrap().arrived = Some(Instant::now());
        // the system may have rearranged it before the focus came: check once it has settled
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            let back = app.clone();
            let _ = app.run_on_main_thread(move || {
                let Some(s) = look(&back) else { return };
                let mut held = HELD.lock().unwrap();
                // a change kept just before the focus came was the system's arranging after all
                let settle = Duration::from_millis(SETTLE_MS);
                let intent = match held.before {
                    Some((f, t)) if t.elapsed() < settle => f,
                    _ => match held.intent {
                        Some(f) => f,
                        None => return,
                    },
                };
                if held.restoring || s.full || s.live || s.mouse || !s.active {
                    return;
                }
                if let Some((screen, visible)) = s.screen {
                    if undo(intent, s.now, screen, visible, true) {
                        held.restoring = true;
                        held.arrived = None;
                        held.before = None;
                        held.intent = Some(intent);
                        drop(held);
                        put_back(&back, intent);
                    }
                }
            });
        });
    }

    /// let the system finish its arrangement first, then put the window back once
    fn put_back(app: &AppHandle, intent: Frame) {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            let back = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = back.get_window("main") {
                    if let Ok(ns) = win.ns_window() {
                        if let Some(ns) = unsafe { (ns as *mut AnyObject).as_ref() } {
                            let live: bool = unsafe { msg_send![ns, inLiveResize] };
                            if !live {
                                let r = NSRect::new(
                                    objc2_foundation::NSPoint::new(intent.x, intent.y),
                                    objc2_foundation::NSSize::new(intent.w, intent.h),
                                );
                                let _: () = unsafe { msg_send![ns, setFrame: r, display: true] };
                            }
                        }
                    }
                }
                HELD.lock().unwrap().restoring = false;
            });
        });
    }
}

#[cfg(target_os = "macos")]
pub use mac::{on_change, on_focus};

#[cfg(not(target_os = "macos"))]
pub fn on_change(_app: &tauri::AppHandle) {}
#[cfg(not(target_os = "macos"))]
pub fn on_focus(_app: &tauri::AppHandle, _focused: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
    const VISIBLE: Frame = Frame { x: 0.0, y: 0.0, w: 1512.0, h: 949.0 };
    const CHOSEN: Frame = Frame { x: 161.0, y: 0.0, w: 1291.0, h: 949.0 };

    #[test]
    fn undoes_the_stage_fit() {
        // what Mission Control left: 1084 wide, 214 on each side
        assert!(squeezed_onto_stage(CHOSEN, Frame { x: 214.0, y: 0.0, w: 1084.0, h: 949.0 }, SCREEN));
        assert!(undo(CHOSEN, Frame { x: 214.0, y: 0.0, w: 1084.0, h: 949.0 }, SCREEN, VISIBLE, false));
    }

    #[test]
    fn undoes_a_move_on_coming_back() {
        // back from the side strip: same size, 117 to the left
        let moved = Frame { x: 44.0, ..CHOSEN };
        assert!(undo(CHOSEN, moved, SCREEN, VISIBLE, true));
        // and the other way, pushed off the strip
        assert!(undo(Frame { x: 44.0, ..CHOSEN }, CHOSEN, SCREEN, VISIBLE, true));
    }

    #[test]
    fn keeps_a_move_made_while_in_front() {
        // a window manager's shortcut or Window › Center, long after it came to the front
        assert!(!undo(CHOSEN, Frame { x: 110.0, ..CHOSEN }, SCREEN, VISIBLE, false));
    }

    #[test]
    fn keeps_what_the_user_did() {
        // tiled to the left half, to a quarter, filled: even right as it comes back
        for t in [
            Frame { x: 0.0, y: 0.0, w: 756.0, h: 949.0 },
            Frame { x: 756.0, y: 474.5, w: 756.0, h: 474.5 },
            Frame { x: 0.0, y: 0.0, w: 1512.0, h: 949.0 },
        ] {
            assert!(tiled(t, VISIBLE));
            assert!(!undo(CHOSEN, t, SCREEN, VISIBLE, true));
        }
        // smaller but not centred (an edge drag that ended off a live resize)
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 161.0, y: 0.0, w: 1100.0, h: 949.0 }, SCREEN));
        // centred with no room left on the sides
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 10.0, y: 0.0, w: 1492.0, h: 900.0 }, SCREEN));
        // nothing changed
        assert!(!undo(CHOSEN, CHOSEN, SCREEN, VISIBLE, true));
    }

    #[test]
    fn keeps_another_display() {
        let right = Frame { x: 1512.0, y: 0.0, w: 1920.0, h: 1200.0 };
        let there = Frame { x: 1600.0, y: 0.0, w: 1291.0, h: 949.0 };
        assert!(!undo(CHOSEN, there, right, right, true));
    }

    #[test]
    fn on_a_second_screen_too() {
        let right = Frame { x: 1512.0, y: 0.0, w: 1920.0, h: 1200.0 };
        let chosen = Frame { x: 1600.0, y: 0.0, w: 1800.0, h: 1100.0 };
        assert!(squeezed_onto_stage(chosen, Frame { x: 1512.0 + 200.0, y: 0.0, w: 1520.0, h: 1100.0 }, right));
        assert!(undo(chosen, Frame { x: 1512.0 + 200.0, y: 0.0, w: 1520.0, h: 1100.0 }, right, right, false));
    }
}
