// The main window keeps the size the user gave it.
//
// With Stage Manager on, macOS puts a window back on its stage after Mission Control (or after it
// comes back from the side strip) narrowed to fit between the strips, centred: a 1291-wide window
// comes back 1084 wide. Plain AppKit windows get the same treatment; we measured it with a bare
// NSWindow as well as Ondra's. The user never asked for that, so the window is put back as it was.
//
// Only that one shape is undone: a size change nobody dragged, that made the window smaller and
// left it centred on its screen with room on both sides. A drag, the green button, full screen
// and macOS tiling (left/right halves, quarters, fill) are the user's and are kept.

/// A window frame in AppKit's screen coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Was `now` (from `intent`, the size the user chose) the system fitting the window onto its
/// stage, inside `screen` (the screen's full frame)?
pub fn squeezed_onto_stage(intent: Frame, now: Frame, screen: Frame) -> bool {
    let smaller = now.w < intent.w - 1.0 || now.h < intent.h - 1.0;
    let grew = now.w > intent.w + 1.0 || now.h > intent.h + 1.0;
    let left = now.x - screen.x;
    let right = (screen.x + screen.w) - (now.x + now.w);
    smaller && !grew && left >= 24.0 && (left - right).abs() <= 3.0
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{squeezed_onto_stage, Frame};
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::NSRect;
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    struct Held {
        intent: Option<Frame>,
        restoring: bool,
    }
    static HELD: Mutex<Held> = Mutex::new(Held { intent: None, restoring: false });

    const FULL_SCREEN: usize = 1 << 14;

    fn frame(r: NSRect) -> Frame {
        Frame { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height }
    }

    /// Called on the main thread for every move or resize of the main window.
    pub fn on_change(app: &AppHandle) {
        let Some(win) = app.get_window("main") else { return };
        let Ok(ns) = win.ns_window() else { return };
        let Some(ns) = (unsafe { (ns as *mut AnyObject).as_ref() }) else { return };
        let (now, live, style, screen) = unsafe {
            let now: NSRect = msg_send![ns, frame];
            let live: bool = msg_send![ns, inLiveResize];
            let style: usize = msg_send![ns, styleMask];
            let screen: *mut AnyObject = msg_send![ns, screen];
            let screen = screen.as_ref().map(|s| {
                let f: NSRect = msg_send![s, frame];
                frame(f)
            });
            (frame(now), live, style, screen)
        };
        let mut held = HELD.lock().unwrap();
        if held.restoring || style & FULL_SCREEN != 0 {
            return;
        }
        let Some(intent) = held.intent else {
            held.intent = Some(now);
            return;
        };
        let same_size = (now.w - intent.w).abs() <= 1.0 && (now.h - intent.h).abs() <= 1.0;
        if live || same_size {
            held.intent = Some(now);
            return;
        }
        match screen {
            Some(screen) if squeezed_onto_stage(intent, now, screen) => {
                held.restoring = true;
                drop(held);
                let app = app.clone();
                // let the system finish its arrangement first, then put the window back once
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
            // anything else that changed the size (zoom, tiling, a display going away) is kept
            _ => held.intent = Some(now),
        }
    }
}

#[cfg(target_os = "macos")]
pub use mac::on_change;

#[cfg(not(target_os = "macos"))]
pub fn on_change(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Frame = Frame { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
    const CHOSEN: Frame = Frame { x: 161.0, y: 0.0, w: 1291.0, h: 949.0 };

    #[test]
    fn undoes_the_stage_fit() {
        // what Mission Control left: 1084 wide, 214 on each side
        assert!(squeezed_onto_stage(CHOSEN, Frame { x: 214.0, y: 0.0, w: 1084.0, h: 949.0 }, SCREEN));
    }

    #[test]
    fn keeps_what_the_user_did() {
        // tiled to the left half, to a quarter, filled, or made bigger
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 0.0, y: 0.0, w: 756.0, h: 949.0 }, SCREEN));
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 756.0, y: 491.0, w: 756.0, h: 491.0 }, SCREEN));
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 0.0, y: 0.0, w: 1512.0, h: 949.0 }, SCREEN));
        // smaller but not centred (an edge drag that ended off a live resize)
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 161.0, y: 0.0, w: 1100.0, h: 949.0 }, SCREEN));
        // centred with no room left on the sides
        assert!(!squeezed_onto_stage(CHOSEN, Frame { x: 10.0, y: 0.0, w: 1492.0, h: 900.0 }, SCREEN));
    }

    #[test]
    fn on_a_second_screen_too() {
        let right = Frame { x: 1512.0, y: 0.0, w: 1920.0, h: 1200.0 };
        let chosen = Frame { x: 1600.0, y: 0.0, w: 1800.0, h: 1100.0 };
        assert!(squeezed_onto_stage(chosen, Frame { x: 1512.0 + 200.0, y: 0.0, w: 1520.0, h: 1100.0 }, right));
    }
}
