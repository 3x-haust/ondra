use std::{ffi::OsString, path::{Path, PathBuf}, process::Command};

const MISSING: &str = "작업에 필요한 Bash를 찾지 못했습니다. Git for Windows(https://git-scm.com/download/win)를 설치하거나 호환되는 bash.exe가 있는 폴더를 PATH에 추가한 뒤 Ondra를 다시 시작하세요. PowerShell만으로는 이 작업을 실행할 수 없습니다.";

/// Match the coding agent's default lookup (utils/shell.ts), without running code from the job folder.
fn require_bash(roots: impl Iterator<Item = PathBuf>, path: impl Iterator<Item = PathBuf>) -> Result<(), String> {
    let mut candidates = roots.map(|r| r.join("Git").join("bin").join("bash.exe"))
        .chain(path.filter(|d| d.is_absolute()).map(|d| d.join("bash.exe")));
    if candidates.any(|p| p.is_file()) { Ok(()) } else { Err(MISSING.into()) }
}

fn uses_bash(args: &[String]) -> bool {
    if args.iter().any(|s| s == "--no-tools") { return false; }
    !args.windows(2).any(|w| w[0] == "--tools" && !w[1].split(',').any(|n| n == "bash" || n.starts_with('+')))
}

fn env(cmd: &Command, key: &str) -> Option<OsString> {
    cmd.get_envs().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.map(|s| s.to_owned())).unwrap_or_else(|| std::env::var_os(key))
}

pub(super) fn check(cmd: &Command, args: &[String], cwd: &Path, home: &Path) -> Result<(), String> {
    if !uses_bash(args) { return Ok(()); }
    let roots = ["ProgramFiles", "ProgramFiles(x86)"].into_iter().filter_map(|k| env(cmd, k)).map(PathBuf::from);
    let path = env(cmd, "PATH").unwrap_or_default();
    let found = require_bash(roots, std::env::split_paths(&path));
    if found.is_err() && env(cmd, "ONDRA_MAIN").as_deref() != Some(std::ffi::OsStr::new("1")) {
        // The built-in job tool can also use Pi's explicit shellPath. Let Pi apply its own
        // trust/validation rules in that case; main's deferred bash tool has no such setting.
        let account = env(cmd, "PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".pi/agent"));
        for dir in [cwd.join(".pi"), account] {
            let settings = std::fs::read(dir.join("settings.json")).ok()
                .and_then(|s| serde_json::from_slice::<serde_json::Value>(&s).ok());
            if let Some(shell) = settings.as_ref().and_then(|v| v["shellPath"].as_str()) {
                let p = Path::new(shell);
                let p = p.strip_prefix("~").map(|rel| home.join(rel)).unwrap_or_else(|_| cwd.join(p));
                if p.is_file() { return Ok(()); }
                return Err("엔진 설정의 shellPath에서 Bash를 찾지 못했습니다. settings.json의 shellPath를 설치된 bash.exe의 경로로 바꾸세요.".into());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_git_executable_is_not_a_bash_installation() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("Git/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("git.exe"), []).unwrap();
        let lookup = || require_bash([dir.path().into()].into_iter(), [].into_iter());
        assert_eq!(lookup(), Err(MISSING.into()));
        std::fs::write(bin.join("bash.exe"), []).unwrap();
        assert!(lookup().is_ok());
        assert!(require_bash([].into_iter(), [bin].into_iter()).is_ok());
    }

    #[test]
    fn start_reports_install_steps_without_bash_but_keeps_an_explicit_job_shell() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = Command::new("unused");
        cmd.env("ProgramFiles", dir.path()).env("ProgramFiles(x86)", dir.path()).env("PATH", dir.path())
            .env("PI_CODING_AGENT_DIR", dir.path()).env("ONDRA_MAIN", "0");
        assert_eq!(check(&cmd, &[], dir.path(), dir.path()), Err(MISSING.into()));
        std::fs::write(dir.path().join("custom.exe"), []).unwrap();
        std::fs::write(dir.path().join("settings.json"), br#"{"shellPath":"custom.exe"}"#).unwrap();
        assert!(check(&cmd, &[], dir.path(), dir.path()).is_ok());
        cmd.env("ONDRA_MAIN", "1");
        assert_eq!(check(&cmd, &[], dir.path(), dir.path()), Err(MISSING.into()));
        assert!(check(&cmd, &["--no-tools".into()], dir.path(), dir.path()).is_ok());
    }

    #[test]
    fn read_only_and_talk_only_agents_do_not_need_bash() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(!uses_bash(&args(&["--no-tools"])));
        assert!(!uses_bash(&args(&["--tools", "read,grep,ls"])));
        assert!(uses_bash(&args(&["--tools", "+ci"])));
        assert!(uses_bash(&args(&["--no-builtin-tools", "--extension", "lazy-core.ts"])));
    }
}
