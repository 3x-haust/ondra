//! One git worktree per task, so tasks in the same repo never write over each
//! other. Created from the repo's current HEAD on a new branch; merged back
//! into whatever branch the repo has checked out; removed when the task is
//! merged, thrown away or deleted (deleting keeps the branch so nothing is lost).

use crate::engine::{home, user_path};
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

/// Run git; Ok(stdout) or Err(stderr, trimmed).
fn run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", user_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err })
    }
}

fn create(cwd: &str, dest: &str, branch: &str) -> Result<Worktree, String> {
    let cwd = expand(cwd);
    if !Path::new(&cwd).is_dir() {
        return Err("폴더가 없어요".into());
    }
    let top = run(&cwd, &["rev-parse", "--show-toplevel"]).map_err(|_| "git 저장소가 아니에요".to_string())?;
    let base = run(&top, &["rev-parse", "HEAD"]).map_err(|_| "커밋이 하나도 없어요".to_string())?;
    let sub = Path::new(&cwd)
        .canonicalize()
        .ok()
        .and_then(|c| Path::new(&top).canonicalize().ok().and_then(|t| c.strip_prefix(&t).ok().map(|s| s.display().to_string())))
        .unwrap_or_default();
    if let Some(parent) = Path::new(dest).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    run(&top, &["worktree", "add", "-b", branch, dest, &base])?;
    Ok(Worktree { repo: top, path: dest.to_string(), branch: branch.to_string(), base, sub })
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

fn remove(repo: &str, path: &str, branch: &str, keep_branch: bool) -> Result<(), String> {
    if keep_branch && Path::new(path).is_dir() {
        let _ = commit_all(path, "작업 중 저장");
    }
    if Path::new(path).exists() {
        run(repo, &["worktree", "remove", "--force", path])?;
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
pub async fn worktree_create(cwd: String, dest: String, branch: String) -> Result<Worktree, String> {
    blocking(move || create(&cwd, &dest, &branch)).await
}

/// Commit what is left in the worktree and merge its branch into the repo's current branch.
/// Returns that branch's name. On conflict the merge is aborted and the error returned.
#[tauri::command]
pub async fn worktree_merge(repo: String, path: String, branch: String, message: String) -> Result<String, String> {
    blocking(move || merge(&repo, &path, &branch, &message)).await
}

#[tauri::command]
pub async fn worktree_remove(repo: String, path: String, branch: String, keep_branch: bool) -> Result<(), String> {
    blocking(move || remove(&repo, &path, &branch, keep_branch)).await
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
}
