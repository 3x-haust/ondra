import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const engine = readFileSync(new URL("../src-tauri/src/engine.rs", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const spawn = engine.slice(engine.indexOf("pub fn agent_spawn("), engine.indexOf("pub fn agent_send("));

// Check the Tauri wiring separately from the native-only process tests below.
describe("컴퓨터 채널의 엔진 연결", () => {
  it("사용자 환경 적용 후 예약 힌트를 제거하고 네이티브 채널만 설정한다", () => {
    expect(spawn.indexOf("computer_channel::prepare(")).toBeGreaterThan(spawn.indexOf('cmd.env("PATH"'));
    expect(engine).toContain('cmd.env_remove("ONDRA_COMPUTER_SOCKET")');
  });

  it("앱이 승인한 동일 작업의 현재 VM만 채널에 전달한다", () => {
    expect(spawn).toContain("computer_state.engine_access()");
    expect(spawn).toContain("computer_access.current_vm(&id)");
    expect(engine).toContain("EngineChannel::prepare(&owner.directory, generation, vm)");
    expect(engine).not.toContain("ComputerSetup::prepare");
    expect(engine).not.toContain(".recover(");
    expect(spawn.indexOf("drop(computer_access)")).toBeGreaterThan(spawn.indexOf("Proc {"));
  });

  it("실제 Child를 바인딩한 뒤 프로세스에 채널을 보관한다", () => {
    expect(engine).toContain("computer: Option<computer_channel::Channel>");
    const bind = spawn.indexOf("channel.bind_child(&mut child, generation)");
    expect(bind).toBeGreaterThan(spawn.indexOf(".spawn()"));
    expect(bind).toBeLessThan(spawn.indexOf("Proc {"));
    expect(spawn).toMatch(/if let Err\(error\) = channel\.bind_child[\s\S]*?drop\(computer\);[\s\S]*?child\.kill\(\);[\s\S]*?child\.wait\(\);[\s\S]*?return Err/);
  });

  it("교체와 자연 EOF에서 기존 세대의 종료 함수를 사용한다", () => {
    expect(spawn).toContain("old.terminate()");
    expect(spawn).toContain("p.finish()");
    expect(spawn).toContain("p.generation != generation");
  });

  it("개별 종료와 전체 종료에서 동일한 폐기 경로를 사용한다", () => {
    const killAll = engine.slice(engine.indexOf("pub fn kill_all("), engine.indexOf("fn login_env("));
    const kill = engine.slice(engine.indexOf("pub fn agent_kill("), engine.indexOf("pub fn agent_alive("));
    expect(killAll).toContain("p.terminate()");
    expect(kill).toContain("p.terminate()");
    expect(engine).toMatch(/fn terminate\(&mut self\)[\s\S]*?self\.revoke\(\);[\s\S]*?self\.child\.kill\(\)/);
    expect(engine).toMatch(/fn finish\(&mut self\)[\s\S]*?self\.revoke\(\);[\s\S]*?self\.child\.wait\(\)/);
  });

  it("앱 종료는 기존 kill_all 경로를 재사용하고 VM을 자동 시작하지 않는다", () => {
    expect(shell).toContain('#[cfg(target_os = "macos")]\nmod computer;');
    expect(shell).toContain("app.state::<engine::Engine>().kill_all()");
    expect(shell).toContain("RunEvent::Exit => kill_children(app)");
    expect(shell).toContain("ComputerState>().shutdown(|| app.state::<engine::Engine>().kill_all())");
    for (const command of ["prepare", "open_setup_viewer", "start", "recover", "status"]) {
      expect(shell).toContain(`computer_setup::computer_${command}`);
    }
    expect(engine).not.toContain("OwnedVm::launch");
    const models = engine.slice(engine.indexOf("pub async fn engine_models("));
    expect(models).not.toContain("computer_channel::prepare");
  });
});

// Compile the unchanged process/channel definitions without Tauri or an engine binary.
// Like the guest admission tests, the native boundary uses only disposable local fixtures.
describe.skipIf(process.platform !== "darwin")("컴퓨터 채널의 네이티브 수명", () => {
  it("예약 환경, 소켓 권한, 세대 분리와 종료 시 정리를 검사한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "ondra-engine-test-"));
    try {
      const fixture = resolve("scripts/computer-host/native-tests");
      copyFileSync(join(fixture, "Cargo.toml"), join(directory, "Cargo.toml"));
      copyFileSync(join(fixture, "Cargo.lock"), join(directory, "Cargo.lock"));
      const definitions = engine.slice(engine.indexOf("struct Proc {"), engine.indexOf("/// GUI apps start"));
      writeFileSync(join(directory, "lib.rs"), `
#![allow(dead_code)]
#[path = ${JSON.stringify(resolve("src-tauri/src/computer.rs"))}]
mod computer;
use std::{collections::HashMap, process::{Child, ChildStdin}, sync::Mutex};
${definitions}
#[cfg(test)] mod engine_tests {
    use super::*;
    use std::{fs, os::unix::fs::MetadataExt, path::PathBuf, process::{Command, Stdio}};
    fn socket(cmd: &Command) -> PathBuf {
        PathBuf::from(cmd.get_envs().find(|(key, _)| *key == computer::SOCKET_ENV).unwrap().1.unwrap())
    }
    fn process(generation: u64) -> (Proc, PathBuf) {
        let mut cmd = Command::new("/bin/cat");
        let computer = computer_channel::prepare(&mut cmd, "t:test", generation, None).unwrap();
        let path = socket(&cmd);
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
        computer.as_ref().unwrap().bind_child(&mut child, generation).unwrap();
        let stdin = child.stdin.take().unwrap();
        (Proc { child, stdin, generation, computer }, path)
    }
    #[test] fn native_environment_overrides_user_hint_and_has_private_short_path() {
        let mut cmd = Command::new("/usr/bin/printenv");
        cmd.arg(computer::SOCKET_ENV).env(computer::SOCKET_ENV, "/untrusted.sock");
        let channel = computer_channel::prepare(&mut cmd, "t:job", 1, None).unwrap();
        let path = socket(&cmd);
        assert!(path.as_os_str().len() <= 100);
        let dir = path.parent().unwrap();
        assert_eq!(fs::canonicalize(dir).unwrap(), dir);
        assert_eq!(fs::metadata(dir).unwrap().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let output = cmd.output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), path.to_str().unwrap());
        drop(channel);
        assert!(!path.exists());
        assert!(!dir.exists());
    }
    #[test] fn non_jobs_cannot_keep_an_overridden_hint() {
        for id in ["captain:home", "probe:1", "login:a", "side:home", "btw:1", "t:", ""] {
            let mut cmd = Command::new("/usr/bin/printenv");
            cmd.arg(computer::SOCKET_ENV).env(computer::SOCKET_ENV, "/untrusted.sock");
            assert!(computer_channel::prepare(&mut cmd, id, 2, None).unwrap().is_none());
            let output = cmd.output().unwrap();
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
        }
    }
    #[test] fn revoke_precedes_child_exit_and_does_not_touch_next_generation() {
        let (mut old, old_path) = process(3);
        let (mut next, next_path) = process(4);
        old.revoke();
        assert!(!old_path.exists());
        assert!(!old_path.parent().unwrap().exists());
        assert!(old.child.try_wait().unwrap().is_none());
        assert!(next_path.exists());
        old.terminate();
        assert!(old.child.try_wait().unwrap().is_some());
        // EOF is delivered by closing stdin, not by launching an actual engine.
        let replacement = Command::new("/bin/cat").stdin(Stdio::piped()).stdout(Stdio::null()).spawn().unwrap();
        let mut replacement = replacement;
        drop(std::mem::replace(&mut next.stdin, replacement.stdin.take().unwrap()));
        assert_eq!(next.finish(), Some(0));
        assert!(!next_path.exists());
        let _ = replacement.kill();
        let _ = replacement.wait();
    }
    #[test] fn kill_all_and_drop_remove_sockets_and_reap_children() {
        let engine = Engine::default();
        let (p, path) = process(5);
        engine.procs.lock().unwrap().insert("t:job".into(), p);
        engine.kill_all();
        assert!(engine.pids().is_empty());
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
        let (p, path) = process(6);
        drop(p);
        assert!(!path.exists());
        assert!(!path.parent().unwrap().exists());
    }
}
`);
      const args = ["--offline", "--locked", "--manifest-path", join(directory, "Cargo.toml")];
      const options = { encoding: "utf8" as const, timeout: 60_000,
        env: { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), "ondra-computer-engine-tests-target") } };
      execFileSync("cargo", ["check", ...args, "--tests"], options);
      const output = execFileSync("cargo", ["test", ...args, "engine_tests::", "--", "--test-threads=1"], options);
      expect(output).toContain("4 passed; 0 failed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
