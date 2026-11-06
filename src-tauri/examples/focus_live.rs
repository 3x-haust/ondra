//! Live check of the focus guard: start an app the way a job would and see
//! whether the front comes back. `cargo run --example focus_live -- <App>`
#[cfg(target_os = "macos")]
fn main() {
    use objc2_foundation::{NSDate, NSRunLoop};
    use std::process::Command;
    use std::time::{Duration, Instant};

    let app = std::env::args().nth(1).unwrap_or_else(|| "Calculator".into());
    let front = || {
        let out = Command::new("lsappinfo").arg("info").arg("-only").arg("name").arg(String::from_utf8_lossy(&Command::new("lsappinfo").arg("front").output().unwrap().stdout).trim()).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };
    ondra_lib::focus::install(|| vec![std::process::id() as i32]);
    let before = front();
    // a job's tool call: `open -a <App>` without -g brings it forward
    ondra_lib::focus::tool("live", "call-1", true);
    let started = Instant::now();
    let mut child = Command::new("open").arg("-a").arg(&app).spawn().unwrap();
    let run = NSRunLoop::mainRunLoop();
    let mut seen = Vec::new();
    while started.elapsed() < Duration::from_secs(6) {
        run.runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.05));
        let f = front();
        if seen.last() != Some(&f) {
            seen.push(f);
        }
        if child.try_wait().ok().flatten().is_some() {
            ondra_lib::focus::tool("live", "call-1", false);
        }
    }
    println!("front before: {before}");
    println!("front over time: {seen:?}");
    println!("front after: {}", front());
    println!("restore: {:?}", ondra_lib::focus::last_restore());
}

#[cfg(not(target_os = "macos"))]
fn main() {}
