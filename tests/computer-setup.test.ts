import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src-tauri/src/computer_setup.rs", import.meta.url), "utf8");

// Compile the actual state machine; only the VM/OS boundary is replaced. No VM,
// credentials, GUI, SSH, or engine binary is used by this fixture.
describe("컴퓨터 준비의 앱 소유 상태", () => {
  it("명시적 명령은 blocking worker와 봉인된 자산만 사용한다", () => {
    expect(source).toContain("tauri::async_runtime::spawn_blocking");
    expect(source).toContain("assets::COMPUTER_ASSETS");
    expect(source).toMatch(/app\s*\.path\(\)\s*\.resource_dir\(\)/);
    expect(source).toContain("libc::mkdtemp");
    expect(source).toContain('directory: root.join("vm")');
    expect(source).not.toContain("std::env::var");
    expect(source).toContain("deny_unknown_fields");
  });

  it("작업 귀속·직렬화·오류·종료 순서를 VM 없이 검사한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "ondra-setup-test-"));
    try {
      const fixture = resolve("scripts/computer-host/native-tests");
      copyFileSync(join(fixture, "Cargo.toml"), join(directory, "Cargo.toml"));
      copyFileSync(join(fixture, "Cargo.lock"), join(directory, "Cargo.lock"));
      const definitions = source.slice(source.indexOf("type Result<T>"), source.indexOf("#[derive(Deserialize)]"));
      const program = `
#![allow(dead_code)]
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError, atomic::{AtomicBool, Ordering}};
pub struct OwnedVm { active: AtomicBool }
struct ComputerSetup {
    vm: Arc<OwnedVm>, calls: Mutex<Vec<String>>, fail: AtomicBool, setup_pending: AtomicBool, dropped: Arc<AtomicBool>, stopped: Arc<AtomicBool>,
}
impl ComputerSetup {
    fn new() -> Self { Self { vm: Arc::new(OwnedVm { active: AtomicBool::new(false) }),
        calls: Mutex::new(vec![]), fail: AtomicBool::new(false), setup_pending: AtomicBool::new(true), dropped: Arc::new(AtomicBool::new(false)), stopped: Arc::new(AtomicBool::new(false)) } }
    fn shutdown(&self) -> Result<()> {
        self.stopped.store(true, Ordering::Release);
        if self.fail.load(Ordering::Acquire) { Err("OWNED_PROCESS_NOT_STOPPED") } else { Ok(()) }
    }
    fn current_vm(&self) -> Option<Arc<OwnedVm>> {
        self.vm.active.load(Ordering::Acquire).then(|| self.vm.clone())
    }
    fn setup_pending(&self) -> bool { self.setup_pending.load(Ordering::Acquire) }
    fn open_setup_viewer(&self) -> Result<()> {
        self.calls.lock().unwrap().push("viewer".into());
        if self.fail.load(Ordering::Acquire) { return Err("SETUP_VIEWER_UNAVAILABLE"); }
        Ok(())
    }
    fn start(&self, id: &str) -> Result<Arc<OwnedVm>> {
        self.calls.lock().unwrap().push(format!("start:{id}"));
        if self.fail.load(Ordering::Acquire) { return Err("TEST_BOOT_FAILED"); }
        self.setup_pending.store(false, Ordering::Release);
        self.vm.active.store(true, Ordering::Release); Ok(self.vm.clone())
    }
    fn recover(&self, id: &str) -> Result<Arc<OwnedVm>> {
        if self.setup_pending() { return Err("EXPLICIT_RECOVERY_REQUIRED"); }
        self.start(id)
    }
}
impl Drop for ComputerSetup { fn drop(&mut self) { self.dropped.store(true, Ordering::Release); } }
${definitions}
#[cfg(test)] mod setup_tests {
    use super::*;
    #[test] fn initial_state_and_invalid_ids_do_not_boot() {
        let state = ComputerState::default();
        assert_eq!(serde_json::to_value(state.snapshot().unwrap()).unwrap(), serde_json::json!({
            "phase": "idle", "busy": false, "prepared": false, "taskId": null, "error": null
        }));
        assert!(state.engine_access().unwrap().current_vm("t:a").is_none());
        for id in ["", "t:", "a", "captain:a", "t:a:b", "t:a/b", "t:한글", "t:a b"] {
            assert!(matches!(state.start(id, false), Err("INVALID_TASK_ID")));
        }
        assert!(task_suffix(&format!("t:{}", "a".repeat(129))).is_err());
        assert_eq!(task_suffix("t:task_1-A"), Ok("task_1-A"));
        assert!(matches!(state.start("t:a", false), Err("COMPUTER_NOT_PREPARED")));
    }
    #[test] fn prepare_is_explicit_and_never_replaces_an_existing_owner() {
        let state = ComputerState::default();
        let result = state.prepare(|| Ok(ComputerSetup::new())).unwrap();
        assert!(result.prepared); assert_eq!(result.phase, "setup");
        assert!(state.owner.lock().unwrap().as_ref().unwrap().calls.lock().unwrap().is_empty());
        assert!(matches!(state.prepare(|| panic!("must not prepare twice")), Err("COMPUTER_ALREADY_PREPARED")));
        assert_eq!(state.snapshot().unwrap().phase, "setup", "duplicate prepare hid setup controls");
        state.open_viewer().unwrap();
        assert_eq!(*state.owner.lock().unwrap().as_ref().unwrap().calls.lock().unwrap(), ["viewer"]);
    }
    #[test] fn only_exact_authorized_task_receives_the_current_vm() {
        let state = ComputerState::default();
        state.prepare(|| Ok(ComputerSetup::new())).unwrap();
        let result = state.start("t:task_1", false).unwrap();
        assert_eq!(result.task_id.as_deref(), Some("t:task_1"));
        assert_eq!(result.phase, "ready");
        let access = state.engine_access().unwrap();
        assert!(access.current_vm("t:task_1").is_some());
        for id in ["t:other", "task_1", "captain:task_1", "t:"] { assert!(access.current_vm(id).is_none(), "unexpected authority: {id}"); }
        assert_eq!(*access.owner.as_ref().unwrap().calls.lock().unwrap(), ["start:task_1"]);
        access.owner.as_ref().unwrap().vm.active.store(false, Ordering::Release);
        assert!(access.current_vm("t:task_1").is_none());
        drop(access);
        assert_eq!(state.snapshot().unwrap().error, Some("GUEST_REVOKED"));
    }
    #[test] fn busy_status_does_not_wait_and_reentry_is_rejected() {
        let state = ComputerState::default();
        let operation = state.begin("preparing").unwrap();
        let status = state.snapshot().unwrap();
        assert!(status.busy); assert_eq!(status.phase, "preparing");
        assert!(matches!(state.begin("starting"), Err("COMPUTER_BUSY")));
        assert!(matches!(state.engine_access(), Err("COMPUTER_BUSY")));
        drop(operation);
        let status = state.snapshot().unwrap();
        assert!(!status.busy); assert_eq!(status.error, Some("COMPUTER_WORKER_FAILED"));
    }
    #[test] fn failed_boot_is_reported_and_cannot_transfer_task_binding() {
        let state = ComputerState::default();
        state.prepare(|| { let setup = ComputerSetup::new(); setup.fail.store(true, Ordering::Release); Ok(setup) }).unwrap();
        assert!(matches!(state.start("t:one", false), Err("TEST_BOOT_FAILED")));
        let status = state.snapshot().unwrap();
        assert!(!status.busy); assert!(status.prepared); assert_eq!(status.error, Some("TEST_BOOT_FAILED"));
        assert!(state.engine_access().unwrap().current_vm("t:one").is_none());
        assert_eq!(status.phase, "setup", "failure before runner replacement must allow explicit start again");
        assert!(matches!(state.start("t:two", false), Err("COMPUTER_TASK_MISMATCH")));
        assert!(matches!(state.start("t:one", true), Err("EXPLICIT_RECOVERY_REQUIRED")));
        state.owner.lock().unwrap().as_ref().unwrap().fail.store(false, Ordering::Release);
        assert_eq!(state.start("t:one", false).unwrap().phase, "ready");
    }
    #[test] fn viewer_failure_keeps_setup_retry_available() {
        let state = ComputerState::default();
        state.prepare(|| { let setup = ComputerSetup::new(); setup.fail.store(true, Ordering::Release); Ok(setup) }).unwrap();
        assert!(matches!(state.open_viewer(), Err("SETUP_VIEWER_UNAVAILABLE")));
        let status = state.snapshot().unwrap();
        assert_eq!(status.phase, "setup", "viewer failure hid setup controls");
        assert_eq!(status.error, Some("SETUP_VIEWER_UNAVAILABLE"));
        assert!(!status.busy);
        state.owner.lock().unwrap().as_ref().unwrap().fail.store(false, Ordering::Release);
        assert_eq!(state.open_viewer().unwrap().phase, "setup");
    }
    #[test] fn automation_failure_requires_recovery_not_setup() {
        let state = ComputerState::default();
        state.prepare(|| Ok(ComputerSetup::new())).unwrap();
        state.start("t:one", false).unwrap();
        state.owner.lock().unwrap().as_ref().unwrap().fail.store(true, Ordering::Release);
        assert!(matches!(state.start("t:one", true), Err("TEST_BOOT_FAILED")));
        assert_eq!(state.snapshot().unwrap().phase, "error");
        state.owner.lock().unwrap().as_ref().unwrap().fail.store(false, Ordering::Release);
        assert_eq!(state.start("t:one", true).unwrap().phase, "ready");
    }
    #[test] fn shutdown_reaps_engines_before_dropping_vm_owner_and_closes_admission() {
        let state = ComputerState::default();
        let setup = ComputerSetup::new(); let dropped = setup.dropped.clone(); let stopped = setup.stopped.clone();
        state.prepare(|| Ok(setup)).unwrap();
        state.shutdown(|| {
            assert!(!dropped.load(Ordering::Acquire));
            assert!(!stopped.load(Ordering::Acquire));
        }).unwrap();
        assert!(stopped.load(Ordering::Acquire), "VM shutdown must finish before owner drop");
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(state.snapshot().unwrap().phase, "closed");
        assert!(matches!(state.engine_access(), Err("COMPUTER_CLOSED")));
        assert!(matches!(state.prepare(|| panic!("closed")), Err("COMPUTER_CLOSED")));
    }
    #[test] fn shutdown_failure_is_reported_without_reopening_admission() {
        let state = ComputerState::default();
        let setup = ComputerSetup::new(); setup.fail.store(true, Ordering::Release);
        let stopped = setup.stopped.clone(); let dropped = setup.dropped.clone();
        state.prepare(|| Ok(setup)).unwrap();
        assert_eq!(state.shutdown(|| {}), Err("OWNED_PROCESS_NOT_STOPPED"));
        assert!(stopped.load(Ordering::Acquire)); assert!(dropped.load(Ordering::Acquire));
        let status = state.snapshot().unwrap();
        assert_eq!(status.phase, "closed"); assert_eq!(status.error, Some("OWNED_PROCESS_NOT_STOPPED"));
        assert!(matches!(state.engine_access(), Err("COMPUTER_CLOSED")));
    }
    #[test] fn resumed_guest_is_stopped_until_a_task_starts_it() {
        let state = ComputerState::default();
        let status = state.resume(|| { let setup = ComputerSetup::new(); setup.setup_pending.store(false, Ordering::Release); Ok(setup) }).unwrap();
        assert!(status.prepared); assert_eq!(status.phase, "stopped"); assert_eq!(status.task_id, None);
        assert!(state.engine_access().unwrap().current_vm("t:one").is_none(), "a resumed guest is not authorized before boot");
        assert!(matches!(state.prepare(|| panic!("resumed guest replaced")), Err("COMPUTER_ALREADY_PREPARED")));
        assert!(matches!(state.start("t:one", true), Err("COMPUTER_NOT_STARTED")));
        assert_eq!(state.start("t:one", false).unwrap().phase, "ready");
        let unfinished = ComputerState::default();
        assert_eq!(unfinished.resume(|| Ok(ComputerSetup::new())).unwrap().phase, "setup");
        let refused = ComputerState::default();
        assert!(matches!(refused.resume(|| Err("GUEST_STILL_RUNNING")), Err("GUEST_STILL_RUNNING")));
        assert!(!refused.snapshot().unwrap().prepared);
        assert_eq!(refused.prepare(|| Ok(ComputerSetup::new())).unwrap().phase, "setup");
    }
    #[test] fn preparation_errors_clear_busy_and_allow_a_new_explicit_attempt() {
        let state = ComputerState::default();
        assert!(matches!(state.prepare(|| Err("COMPUTER_ASSETS_UNAVAILABLE")), Err("COMPUTER_ASSETS_UNAVAILABLE")));
        let status = state.snapshot().unwrap();
        assert!(!status.busy); assert!(!status.prepared); assert_eq!(status.phase, "error");
        assert_eq!(state.prepare(|| Ok(ComputerSetup::new())).unwrap().phase, "setup");
    }
}
`;
      writeFileSync(join(directory, "lib.rs"), program);
      const args = ["--offline", "--locked", "--manifest-path", join(directory, "Cargo.toml")];
      const options = { encoding: "utf8" as const, timeout: 60_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), "ondra-computer-setup-tests-target") } };
      execFileSync("cargo", ["check", ...args, "--tests"], options);
      for (let repeat = 0; repeat < 3; repeat++) {
        const output = execFileSync("cargo", ["test", ...args, "setup_tests::", "--", "--test-threads=1"], options);
        expect(output).toContain("11 passed; 0 failed");
      }
      // Mutation check: a cross-task authorization regression must be caught.
      writeFileSync(join(directory, "lib.rs"), program.replace(' || status.task_id.as_deref() != Some(id)', ""));
      const mutation = spawnSync("cargo", ["test", ...args, "setup_tests::only_exact_authorized_task_receives_the_current_vm"], options);
      expect(mutation.status).toBe(101);
      expect(mutation.stdout).toContain("unexpected authority: t:other");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
