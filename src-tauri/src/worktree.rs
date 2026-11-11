//! One git worktree per task, so tasks in the same repo never write over each
//! other. Created on a new branch from the latest the remote has for the
//! checked-out branch (the local HEAD when it has commits of its own, or the
//! remote can't be reached); merged back
//! into whatever branch the repo has checked out; removed when the task is
//! merged, thrown away or deleted (deleting keeps the branch so nothing is lost).

use crate::engine::home;
use serde::Serialize;
use std::{path::Path, process::Command};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// Top folder of the original repo.
    repo: String,
    /// Where the worktree lives.
    path: String,
    branch: String,
    /// Commit the branch started from (diffs are shown against it).
    base: String,
    /// The task's folder relative to the repo top ("" = the top itself).
    sub: String,
}

fn expand(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => home().join(rest).display().to_string(),
        None if p == "~" => home().display().to_string(),
        None => p.to_string(),
    }
}

thread_local! {
    /// The job's space environment for the git commands of one call (see `with_env`).
    static ENV: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Run `f` with every git command in it using the space's environment (its git
/// identity, GitHub login, ssh keys), so a commit or fetch in a company repo
/// never goes out as the personal account.
fn with_env<T>(env: Vec<(String, String)>, f: impl FnOnce() -> T) -> T {
    ENV.with(|e| *e.borrow_mut() = env);
    let out = f();
    ENV.with(|e| e.borrow_mut().clear());
    out
}

fn git_cmd(cwd: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
    ENV.with(|e| crate::git::space_env_into(&mut cmd, &e.borrow()));
    cmd
}

/// Run git; Ok(stdout) or Err(stderr, trimmed).
fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(cwd).args(args).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err })
    }
}

/// `git fetch` for the checked-out branch's remote, given up after `secs`.
fn fetch(top: &str, secs: u64) -> bool {
    let remote = run(top, &["config", &format!("branch.{}.remote", run(top, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default())]).unwrap_or_else(|_| "origin".into());
    let Ok(mut child) = git_cmd(top)
        .args(["fetch", "--quiet", "--no-tags", &remote])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let end = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.success(),
            Ok(None) if std::time::Instant::now() < end => std::thread::sleep(std::time::Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Where a new task starts: the remote's tip of the checked-out branch when the
/// local branch is only behind it (nothing of its own), else the local HEAD.
fn start_point(top: &str) -> Result<String, String> {
    let head = run(top, &["rev-parse", "HEAD"]).map_err(|_| "커밋이 하나도 없어요".to_string())?;
    if run(top, &["rev-parse", "--abbrev-ref", "@{u}"]).is_err() || !fetch(top, 20) {
        return Ok(head);
    }
    match run(top, &["rev-parse", "@{u}"]) {
        Ok(up) if run(top, &["merge-base", "--is-ancestor", "HEAD", "@{u}"]).is_ok() => Ok(up),
        _ => Ok(head),
    }
}

fn create(cwd: &str, dest: &str, branch: &str) -> Result<Worktree, String> {
    let cwd = expand(cwd);
    if !Path::new(&cwd).is_dir() {
        return Err("폴더가 없어요".into());
    }
    let top = run(&cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "git 저장소가 아니에요".to_string())?;
    let base = start_point(&top)?;
    let sub = Path::new(&cwd)
        .canonicalize()
        .ok()
        .and_then(|c| Path::new(&top).canonicalize().ok().and_then(|t| c.strip_prefix(&t).ok().map(|s| s.display().to_string())))
        .unwrap_or_default();
    if let Some(parent) = Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    run(&top, &["worktree", "add", "-b", branch, dest, &base])?;
    keep_notes_out(&top);
    Ok(Worktree { repo: top, path: dest.to_string(), branch: branch.to_string(), base, sub })
}

/// Ondra's own notes (`.ondra/`) never go into the user's commits: list them in the
/// repo's local exclude file (shared by its worktrees, never committed).
fn keep_notes_out(top: &str) {
    let Ok(common) = run(top, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else { return };
    let file = Path::new(&common).join("info").join("exclude");
    let now = std::fs::read_to_string(&file).unwrap_or_default();
    if now.lines().any(|l| matches!(l.trim(), ".ondra" | ".ondra/" | "/.ondra" | "/.ondra/")) {
        return;
    }
    let _ = std::fs::create_dir_all(file.parent().unwrap());
    let sep = if now.is_empty() || now.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&file, format!("{now}{sep}.ondra/\n"));
}

/// Commit everything left in the worktree. Ok(true) if a commit was made.
fn commit_all(path: &str, message: &str) -> Result<bool, String> {
    run(path, &["add", "-A"])?;
    if run(path, &["diff", "--cached", "--quiet"]).is_ok() {
        return Ok(false);
    }
    run(path, &["commit", "-q", "-m", message])?;
    Ok(true)
}

fn merge(repo: &str, path: &str, branch: &str, message: &str) -> Result<String, String> {
    commit_all(path, message)?;
    let target = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if target == "HEAD" {
        return Err("원래 폴더가 브랜치에 있지 않아요 (detached HEAD)".into());
    }
    if run(repo, &["merge-base", "--is-ancestor", branch, "HEAD"]).is_ok() {
        return Ok(target); // nothing new on the branch
    }
    if let Err(e) = run(repo, &["merge", "--no-edit", branch]) {
        let _ = run(repo, &["merge", "--abort"]);
        return Err(e);
    }
    Ok(target)
}

/// Whether the job's work is already on the remote's main line (the job pushed
/// and its PR was merged): nothing uncommitted, and HEAD is in the remote's
/// default branch. Returns that branch ("origin/main"), or None.
fn landed(path: &str) -> Option<String> {
    // Ondra's own folder (job notes, memory) is not work left behind
    if !Path::new(path).is_dir() || !run(path, &["status", "--porcelain", "--", ".", ":(exclude).ondra"]).ok()?.is_empty() {
        return None;
    }
    let remote = "origin";
    let _ = fetch(path, 20);
    let main = run(path, &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")])
        .ok()
        .or_else(|| ["main", "master"].iter().map(|b| format!("{remote}/{b}")).find(|b| run(path, &["rev-parse", "--verify", "-q", b]).is_ok()))?;
    run(path, &["merge-base", "--is-ancestor", "HEAD", &main]).ok().map(|_| main)
}

/// The job's branch is already merged on the remote: Some("origin/main").
#[tauri::command]
pub async fn worktree_landed(path: String, env: Option<Vec<(String, String)>>) -> Result<Option<String>, String> {
    blocking(move || Ok(with_env(env.unwrap_or_default(), || landed(&path)))).await
}

fn remove(repo: &str, path: &str, branch: &str, keep_branch: bool) -> Result<(), String> {
    // a checkout of its own (.git in it), not a folder git would read as part of one further up
    let checkout = Path::new(path).join(".git").exists();
    if keep_branch && checkout {
        let _ = commit_all(path, "작업 중 저장");
    }
    if Path::new(path).exists() {
        if let Err(e) = run(repo, &["worktree", "remove", "--force", path]) {
            // no longer a worktree, only what was written there after it went (a dev server's
            // cache, an empty folder): delete the folder itself
            if checkout {
                return Err(e);
            }
            std::fs::remove_dir_all(path).map_err(|x| x.to_string())?;
            let _ = run(repo, &["worktree", "prune"]);
        }
    } else {
        let _ = run(repo, &["worktree", "prune"]);
    }
    if !keep_branch {
        let _ = run(repo, &["branch", "-D", branch]);
    }
    Ok(())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn worktree_create(cwd: String, dest: String, branch: String, env: Option<Vec<(String, String)>>) -> Result<Worktree, String> {
    blocking(move || with_env(env.unwrap_or_default(), || create(&cwd, &dest, &branch))).await
}

/// Commit what is left in the worktree and merge its branch into the repo's current branch.
/// Returns that branch's name. On conflict the merge is aborted and the error returned.
#[tauri::command]
pub async fn worktree_merge(repo: String, path: String, branch: String, message: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    blocking(move || with_env(env.unwrap_or_default(), || merge(&repo, &path, &branch, &message))).await
}

#[tauri::command]
pub async fn worktree_remove(repo: String, path: String, branch: String, keep_branch: bool, env: Option<Vec<(String, String)>>) -> Result<(), String> {
    blocking(move || with_env(env.unwrap_or_default(), || remove(&repo, &path, &branch, keep_branch))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(cwd: &str, args: &[&str]) {
        run(cwd, args).unwrap();
    }

    #[test]
    fn worktree_roundtrip() {
        let root = std::env::temp_dir().join(format!("wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(repo.join("app")).unwrap();
        let r = repo.display().to_string();
        sh(&r, &["init", "-q", "-b", "main"]);
        sh(&r, &["config", "user.email", "t@t"]);
        sh(&r, &["config", "user.name", "t"]);
        sh(&r, &["config", "commit.gpgsign", "false"]);
        std::fs::write(repo.join("app/a.txt"), "one\n").unwrap();
        sh(&r, &["add", "-A"]);
        sh(&r, &["commit", "-q", "-m", "init"]);

        // two tasks from the same subfolder, side by side
        let a = root.join("wt/a").display().to_string();
        let b = root.join("wt/b").display().to_string();
        let wa = create(&repo.join("app").display().to_string(), &a, "task/a").unwrap();
        let wb = create(&repo.join("app").display().to_string(), &b, "task/b").unwrap();
        assert_eq!(wa.sub, "app");
        std::fs::create_dir_all(Path::new(&a).join(".ondra")).unwrap();
        std::fs::write(Path::new(&a).join(".ondra/goal.md"), "notes").unwrap();
        assert!(commit_all(&a, "notes only").map(|made| !made).unwrap(), "Ondra notes are not committed");
        std::fs::write(Path::new(&a).join("app/a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(Path::new(&b).join("app/b.txt"), "bee\n").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("app/a.txt")).unwrap(), "one\n");
        // the Changes panel sees committed + uncommitted work since the start
        run(&b, &["add", "-A"]).unwrap();
        run(&b, &["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "b"]).unwrap();
        let cb = crate::git::changes(&b, Some(&wb.base));
        let ca = crate::git::changes(&a, Some(&wa.base));
        assert_eq!(serde_json::to_value(&cb).unwrap()["files"][0]["path"], "app/b.txt");
        assert_eq!(serde_json::to_value(&ca).unwrap()["files"][0]["path"], "app/a.txt");

        assert_eq!(merge(&wa.repo, &a, "task/a", "a").unwrap(), "main");
        assert_eq!(merge(&wb.repo, &b, "task/b", "b").unwrap(), "main");
        assert_eq!(std::fs::read_to_string(repo.join("app/a.txt")).unwrap(), "one\ntwo\n");
        assert!(repo.join("app/b.txt").exists());

        remove(&wa.repo, &a, "task/a", false).unwrap();
        remove(&wb.repo, &b, "task/b", true).unwrap();
        assert!(!Path::new(&a).exists());
        // written there after it went (a dev server's cache): removing again deletes the folder
        std::fs::create_dir_all(Path::new(&a).join(".vite")).unwrap();
        remove(&wa.repo, &a, "task/a", true).unwrap();
        assert!(!Path::new(&a).exists());
        assert!(run(&r, &["rev-parse", "--verify", "task/b"]).is_ok());
        assert!(run(&r, &["rev-parse", "--verify", "task/a"]).is_err());

        // conflicting edits: second merge is refused and the repo stays clean
        let c = root.join("wt/c").display().to_string();
        let d = root.join("wt/d").display().to_string();
        create(&r, &c, "task/c").unwrap();
        create(&r, &d, "task/d").unwrap();
        std::fs::write(Path::new(&c).join("app/a.txt"), "cee\n").unwrap();
        std::fs::write(Path::new(&d).join("app/a.txt"), "dee\n").unwrap();
        merge(&r, &c, "task/c", "c").unwrap();
        assert!(merge(&r, &d, "task/d", "d").is_err());
        assert!(run(&r, &["status", "--porcelain"]).unwrap().is_empty());

        assert!(create("/tmp", &root.join("wt/x").display().to_string(), "task/x").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn starts_from_the_remote_when_behind() {
        let tmp = std::env::temp_dir().join(format!("ondra-wt-up-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let t = tmp.display().to_string();
        let git = |dir: &str, args: &[&str]| run(dir, args).unwrap();
        let origin = format!("{t}/origin.git");
        git(&t, &["init", "-q", "--bare", "-b", "main", &origin]);
        let a = format!("{t}/a");
        git(&t, &["clone", "-q", &origin, &a]);
        for (k, v) in [("user.email", "t@t"), ("user.name", "t")] { git(&a, &["config", k, v]); }
        std::fs::write(format!("{a}/f"), "1").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "one"]);
        git(&a, &["push", "-q", "-u", "origin", "main"]);
        // someone else pushes; this clone is now behind
        let b = format!("{t}/b");
        git(&t, &["clone", "-q", &origin, &b]);
        for (k, v) in [("user.email", "t@t"), ("user.name", "t")] { git(&b, &["config", k, v]); }
        std::fs::write(format!("{b}/f"), "2").unwrap();
        git(&b, &["commit", "-q", "-am", "two"]);
        git(&b, &["push", "-q"]);
        let tip = git(&b, &["rev-parse", "HEAD"]);
        let w = create(&a, &format!("{t}/w"), "task/x").unwrap();
        assert_eq!(w.base, tip);
        // with a commit of its own, the local HEAD is kept
        std::fs::write(format!("{a}/g"), "3").unwrap();
        git(&a, &["add", "-A"]);
        git(&a, &["commit", "-q", "-m", "mine"]);
        let mine = git(&a, &["rev-parse", "HEAD"]);
        let w2 = create(&a, &format!("{t}/w2"), "task/y").unwrap();
        assert_eq!(w2.base, mine);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn knows_when_the_work_is_merged_on_the_remote() {
        let root = std::env::temp_dir().join(format!("wt-landed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (up, repo) = (root.join("up.git"), root.join("repo"));
        std::fs::create_dir_all(&repo).unwrap();
        let (u, r) = (up.display().to_string(), repo.display().to_string());
        sh(&root.display().to_string(), &["init", "-q", "--bare", "-b", "main", &u]);
        sh(&r, &["init", "-q", "-b", "main"]);
        sh(&r, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "a"]);
        sh(&r, &["remote", "add", "origin", &u]);
        sh(&r, &["push", "-q", "-u", "origin", "main"]);
        sh(&r, &["remote", "set-head", "origin", "main"]);
        let wt = root.join("wt").display().to_string();
        sh(&r, &["worktree", "add", "-q", "-b", "job", &wt]);
        std::fs::write(root.join("wt/f.txt"), "x").unwrap();
        assert_eq!(landed(&wt), None, "uncommitted work");
        sh(&wt, &["add", "-A"]);
        sh(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "b"]);
        assert_eq!(landed(&wt), None, "not on the remote yet");
        sh(&wt, &["push", "-q", "origin", "job:main"]);
        assert_eq!(landed(&wt).as_deref(), Some("origin/main"));
        // Ondra's own notes in the folder are not work left behind
        std::fs::create_dir_all(root.join("wt/.ondra")).unwrap();
        std::fs::write(root.join("wt/.ondra/note.md"), "x").unwrap();
        assert_eq!(landed(&wt).as_deref(), Some("origin/main"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
