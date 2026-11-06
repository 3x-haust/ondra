//! Focus guard: when an app that a job started comes to the front by itself,
//! give the front back to the app the user had. Only apps a job started count:
//! ones running under a job's process, or launched just now by a job's command
//! that names them. Any other app coming forward is the user's doing and is
//! left alone, whatever the jobs are running. An app the user brings back
//! right after a restore is theirs from then on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// A tool call counts as "just now" for this long after it ends: apps opened
/// by a short command (`open`, `simctl launch`) show their window a moment later.
const TOOL_GRACE: Duration = Duration::from_secs(3);
/// An app launched this long ago or less still counts as just launched.
const LAUNCH_WINDOW: Duration = Duration::from_secs(60);
/// The app coming back this soon after a restore, with the user's input, means they want it.
const INSIST_WINDOW: Duration = Duration::from_secs(10);
/// Once the user wants an app, leave it alone this long.
const USER_KEEPS: Duration = Duration::from_secs(120);
/// Restores per app inside `INSIST_WINDOW` before giving up on an app that keeps coming back.
const MAX_RESTORES: usize = 3;

static ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

/// What one activation looks like, gathered where it happens.
#[derive(Debug, Clone, Copy, Default)]
pub struct Signals {
    pub enabled: bool,
    /// The app is Ondra, or there is no previous app to give the front back to.
    pub skip: bool,
    /// Seconds since the last mouse button press / modifier change / key press.
    pub since_click: f64,
    pub since_flags: f64,
    pub since_key: f64,
    /// The app's process descends from a job's engine process.
    pub from_job: bool,
    /// The app was launched just now, while a job's command that names it ran.
    pub launched_by_tool: bool,
    /// We gave the front back from this app a moment ago.
    pub restored_lately: usize,
    /// The user took this app back after a restore, not long ago.
    pub user_keeps: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Leave,
    Restore,
    /// The user brought the app back after a restore: keep it theirs.
    UserTook,
}

pub fn decide(s: &Signals) -> Verdict {
    if !s.enabled || s.skip || s.user_keeps {
        return Verdict::Leave;
    }
    // a click or ⌘-Tab right before: the user switched
    if s.since_click < 1.0 || s.since_flags < 0.4 {
        return if s.restored_lately > 0 { Verdict::UserTook } else { Verdict::Leave };
    }
    if s.restored_lately > 0 {
        // back right after a restore: typed in Spotlight/Raycast, or the app won't stay behind
        if s.since_key < 1.0 {
            return Verdict::UserTook;
        }
        if s.restored_lately >= MAX_RESTORES {
            return Verdict::Leave;
        }
    }
    if s.from_job || s.launched_by_tool {
        Verdict::Restore
    } else {
        Verdict::Leave
    }
}

/// Tool calls of jobs, as start/end times and their arguments (lowercased), kept for a couple of minutes.
#[derive(Default)]
struct Tools {
    running: HashMap<String, (Instant, String)>,
    done: Vec<(Instant, Instant, String)>,
}

impl Tools {
    fn prune(&mut self, now: Instant) {
        self.done.retain(|(_, end, _)| now.duration_since(*end) < LAUNCH_WINDOW + TOOL_GRACE);
    }
    /// A call that ran at `at` (or just before) and names one of `names`.
    fn named_at(&self, at: Instant, names: &[String]) -> bool {
        let names_it = |cmd: &str| names.iter().any(|n| n.len() >= 3 && cmd.contains(n.as_str()));
        self.running.values().any(|(start, cmd)| *start <= at + TOOL_GRACE && names_it(cmd))
            || self.done.iter().any(|(start, end, cmd)| *start <= at + TOOL_GRACE && at <= *end + TOOL_GRACE && names_it(cmd))
    }
}

/// What a command would call an app: its name, bundle id, executable, and the tool that starts it.
pub fn app_names(name: &str, bundle: &str, exe: &str) -> Vec<String> {
    let mut v: Vec<String> = [name, bundle, exe].iter().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    if bundle.eq_ignore_ascii_case("com.apple.iphonesimulator") {
        v.push("simctl".into());
    }
    v
}

static TOOLS: Mutex<Option<Tools>> = Mutex::new(None);

fn tools<R>(f: impl FnOnce(&mut Tools) -> R) -> R {
    let mut g = TOOLS.lock().unwrap();
    f(g.get_or_insert_with(Tools::default))
}

/// Called from the engine's event stream: a job's tool call started (with its arguments) or ended.
pub fn tool(job: &str, call: &str, start: Option<&str>) {
    let key = format!("{job}\u{0}{call}");
    let now = Instant::now();
    tools(|t| {
        if let Some(args) = start {
            t.running.insert(key, (now, args.to_lowercase()));
        } else if let Some((s, cmd)) = t.running.remove(&key) {
            t.done.push((s, now, cmd));
        }
        t.prune(now);
    });
}

/// A job's engine process ended: its calls are over.
pub fn job_gone(job: &str) {
    let prefix = format!("{job}\u{0}");
    let now = Instant::now();
    tools(|t| {
        let ended: Vec<String> = t.running.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in ended {
            if let Some((s, cmd)) = t.running.remove(&k) {
                t.done.push((s, now, cmd));
            }
        }
    });
}

/// Watch only the engine event types that matter here.
pub fn on_event(job: &str, ev: &serde_json::Value) {
    let start = match ev.get("type").and_then(|v| v.as_str()) {
        Some("tool_execution_start") => true,
        Some("tool_execution_end") => false,
        _ => return,
    };
    if let Some(call) = ev.get("toolCallId").and_then(|v| v.as_str()) {
        let args = ev.get("args").map(|a| a.to_string()).unwrap_or_default();
        tool(job, call, start.then_some(args.as_str()));
    }
}

/// What the last restore did, for checks.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Restored {
    pub app: String,
    pub back_to: String,
    /// From the app coming forward until the user's app was front again.
    pub ms: Option<u128>,
}

pub fn last_restore() -> Option<Restored> {
    imp::LAST.lock().unwrap().clone()
}

#[tauri::command]
pub fn focus_guard(on: bool) {
    set_enabled(on);
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install(_roots: impl Fn() -> Vec<i32> + 'static) {}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub static LAST: std::sync::Mutex<Option<super::Restored>> = std::sync::Mutex::new(None);
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace, NSWorkspaceApplicationKey, NSWorkspaceDidActivateApplicationNotification};
    use objc2_foundation::NSNotification;
    use std::ptr::NonNull;

    pub static LAST: Mutex<Option<Restored>> = Mutex::new(None);

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState and event types
    const SESSION: i32 = 0;
    const LEFT_DOWN: u32 = 1;
    const RIGHT_DOWN: u32 = 3;
    const KEY_DOWN: u32 = 10;
    const FLAGS: u32 = 12;
    const OTHER_DOWN: u32 = 25;

    fn since(kind: u32) -> f64 {
        unsafe { CGEventSourceSecondsSinceLastEventType(SESSION, kind) }
    }

    pub fn parent(pid: i32) -> Option<i32> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
        (n == size).then_some(info.pbi_ppid as i32)
    }

    /// Whether `pid` is one of `roots` or below one of them.
    pub fn descends(pid: i32, roots: &[i32]) -> bool {
        let mut p = pid;
        for _ in 0..64 {
            if roots.contains(&p) {
                return true;
            }
            match parent(p) {
                Some(pp) if pp > 1 && pp != p => p = pp,
                _ => return false,
            }
        }
        false
    }

    struct State {
        front: Option<i32>,
        /// pid → restore times
        restored: HashMap<i32, Vec<Instant>>,
        user_keeps: HashMap<i32, Instant>,
        /// pid of the app we gave the front back to, the job app's name, and when it came forward
        pending: Option<(i32, String, Instant)>,
    }

    fn name(app: &NSRunningApplication) -> String {
        app.localizedName().map(|s| s.to_string()).unwrap_or_else(|| app.processIdentifier().to_string())
    }

    fn on_activate(app: &NSRunningApplication, st: &mut State, roots: &dyn Fn() -> Vec<i32>) {
        let now = Instant::now();
        let pid = app.processIdentifier();
        let prev = st.front.replace(pid);

        if let Some((back, job_app, at)) = st.pending.take() {
            if back == pid {
                *LAST.lock().unwrap() = Some(Restored { app: job_app, back_to: name(app), ms: Some(now.duration_since(at).as_millis()) });
                return;
            }
        }

        st.restored.retain(|_, v| {
            v.retain(|t| now.duration_since(*t) < INSIST_WINDOW);
            !v.is_empty()
        });
        st.user_keeps.retain(|_, t| now.duration_since(*t) < USER_KEEPS);

        let own = pid as u32 == std::process::id();
        let prev_app = prev.filter(|p| *p != pid).and_then(NSRunningApplication::runningApplicationWithProcessIdentifier).filter(|a| !a.isTerminated());
        let names = app_names(
            &name(app),
            &app.bundleIdentifier().map(|s| s.to_string()).unwrap_or_default(),
            &app.executableURL().and_then(|u| u.lastPathComponent()).map(|s| s.to_string()).unwrap_or_default(),
        );
        let launched_by_tool = app
            .launchDate()
            .map(|d| -d.timeIntervalSinceNow())
            .filter(|age| *age >= 0.0 && *age < LAUNCH_WINDOW.as_secs_f64())
            .and_then(|age| now.checked_sub(Duration::from_secs_f64(age)))
            .is_some_and(|at| tools(|t| t.named_at(at, &names)));
        let s = Signals {
            enabled: ENABLED.load(Ordering::Relaxed),
            skip: own || prev_app.is_none(),
            since_click: since(LEFT_DOWN).min(since(RIGHT_DOWN)).min(since(OTHER_DOWN)),
            since_flags: since(FLAGS),
            since_key: since(KEY_DOWN),
            from_job: descends(pid, &roots()),
            launched_by_tool,
            restored_lately: st.restored.get(&pid).map_or(0, Vec::len),
            user_keeps: st.user_keeps.contains_key(&pid),
        };
        match decide(&s) {
            Verdict::Leave => {}
            Verdict::UserTook => {
                st.restored.remove(&pid);
                st.user_keeps.insert(pid, now);
            }
            Verdict::Restore => {
                let Some(back) = prev_app else { return };
                #[allow(deprecated)]
                let ok = back.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
                if ok {
                    st.restored.entry(pid).or_default().push(now);
                    st.pending = Some((back.processIdentifier(), name(app), now));
                }
            }
        }
    }

    /// Start watching. Runs on the main thread (the observer fires there).
    /// `roots` gives the pids of the jobs' engine processes.
    pub fn install(roots: impl Fn() -> Vec<i32> + 'static) {
        let ws = NSWorkspace::sharedWorkspace();
        let front = ws.frontmostApplication().map(|a| a.processIdentifier());
        let state = Mutex::new(State { front, restored: HashMap::new(), user_keeps: HashMap::new(), pending: None });
        let block = block2::RcBlock::new(move |n: NonNull<NSNotification>| {
            let n = unsafe { n.as_ref() };
            let Some(info) = n.userInfo() else { return };
            let Some(obj) = (unsafe { info.objectForKey(NSWorkspaceApplicationKey) }) else { return };
            let Ok(app) = obj.downcast::<NSRunningApplication>() else { return };
            let app: Retained<NSRunningApplication> = app;
            if let Ok(mut st) = state.lock() {
                on_activate(&app, &mut st, &roots);
            }
        });
        let token = unsafe { ws.notificationCenter().addObserverForName_object_queue_usingBlock(Some(NSWorkspaceDidActivateApplicationNotification), None, None, &block) };
        // watch for the app's whole life
        std::mem::forget(token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job() -> Signals {
        Signals { enabled: true, since_click: 30.0, since_flags: 30.0, since_key: 30.0, from_job: true, ..Default::default() }
    }

    #[test]
    fn job_app_coming_forward_is_sent_back() {
        assert_eq!(decide(&job()), Verdict::Restore);
        assert_eq!(decide(&Signals { from_job: false, launched_by_tool: true, ..job() }), Verdict::Restore);
    }

    #[test]
    fn any_other_app_is_the_users_even_while_jobs_work() {
        // switched by a gesture, a hotkey, a notification or a slow launch: no click right before
        assert_eq!(decide(&Signals { from_job: false, ..job() }), Verdict::Leave);
    }

    #[test]
    fn typing_elsewhere_does_not_count_as_the_user_switching() {
        assert_eq!(decide(&Signals { since_key: 0.05, ..job() }), Verdict::Restore);
    }

    #[test]
    fn user_switches_are_left_alone() {
        assert_eq!(decide(&Signals { since_click: 0.2, ..job() }), Verdict::Leave);
        assert_eq!(decide(&Signals { since_flags: 0.1, ..job() }), Verdict::Leave);
        assert_eq!(decide(&Signals { skip: true, ..job() }), Verdict::Leave);
        assert_eq!(decide(&Signals { enabled: false, ..job() }), Verdict::Leave);
    }

    #[test]
    fn bringing_it_back_after_a_restore_makes_it_the_users() {
        assert_eq!(decide(&Signals { restored_lately: 1, since_click: 0.3, ..job() }), Verdict::UserTook);
        assert_eq!(decide(&Signals { restored_lately: 1, since_key: 0.3, ..job() }), Verdict::UserTook);
        assert_eq!(decide(&Signals { user_keeps: true, ..job() }), Verdict::Leave);
    }

    #[test]
    fn an_app_that_keeps_coming_back_is_not_fought_forever() {
        assert_eq!(decide(&Signals { restored_lately: 2, ..job() }), Verdict::Restore);
        assert_eq!(decide(&Signals { restored_lately: MAX_RESTORES, ..job() }), Verdict::Leave);
    }

    #[test]
    fn only_a_command_that_names_the_app_counts() {
        let mut t = Tools::default();
        let t0 = Instant::now();
        let calc = app_names("Calculator", "com.apple.calculator", "Calculator");
        let slack = app_names("Slack", "com.tinyspeck.slackmacgap", "Slack");
        t.done.push((t0, t0 + Duration::from_secs(1), r#"{"command":"open -g -a calculator"}"#.into()));
        assert!(t.named_at(t0 + Duration::from_secs(3), &calc));
        assert!(!t.named_at(t0 + Duration::from_secs(3), &slack));
        assert!(!t.named_at(t0 + Duration::from_secs(5), &calc));
        t.running.insert("j\u{0}c".into(), (t0, r#"{"command":"xcrun simctl boot abc"}"#.into()));
        assert!(t.named_at(t0 + Duration::from_secs(30), &app_names("Simulator", "com.apple.iphonesimulator", "Simulator")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn ancestry_finds_our_own_children() {
        let me = std::process::id() as i32;
        let child = std::process::Command::new("/bin/sleep").arg("2").spawn().unwrap();
        assert!(imp::descends(child.id() as i32, &[me]));
        assert!(!imp::descends(me, &[child.id() as i32]));
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
    }
}
