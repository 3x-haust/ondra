//! What a task changed in its folder: `git status` + numstat + a unified diff
//! (untracked files shown as new files), for the Changes panel.

use crate::engine::user_path;
use serde::Serialize;
use std::{collections::HashMap, path::Path, process::Command};

const PATCH_CAP: usize = 400 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    path: String,
    add: u64,
    del: u64,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanges {
    is_repo: bool,
    branch: Option<String>,
    files: Vec<GitFile>,
    patch: String,
}

/// Put a space's environment (`space_env`: its git identity, GitHub login, ssh
/// config, CLI shims) on a command Ondra runs for that space. Its PATH goes first.
pub fn space_env_into(cmd: &mut Command, env: &[(String, String)]) {
    cmd.env("PATH", user_path());
    for (k, v) in env {
        if k == "PATH" {
            cmd.env("PATH", format!("{v}:{}", user_path()));
        } else {
            cmd.env(k, v);
        }
    }
}

fn git(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", user_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn has_head(cwd: &str) -> bool {
    git(cwd, &["rev-parse", "--verify", "-q", "HEAD"]).is_some()
}

fn untracked_diff(cwd: &str, path: &str, budget: usize) -> (String, u64) {
    let full = Path::new(cwd).join(path);
    let Ok(bytes) = std::fs::read(&full) else { return (String::new(), 0) };
    if bytes.contains(&0) {
        return (format!("diff --git a/{path} b/{path}\nnew file mode 100644\nBinary files /dev/null and b/{path} differ\n"), 0);
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n", lines.len());
    for l in &lines {
        if out.len() > budget {
            break;
        }
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    (out, lines.len() as u64)
}

/// Changes in `cwd`: against HEAD, or against `base` (a task worktree's start
/// commit) so the agent's own commits are included too.
pub fn changes(cwd: &str, base: Option<&str>) -> GitChanges {
    let empty = GitChanges { is_repo: false, branch: None, files: vec![], patch: String::new() };
    if cwd.is_empty() || git(cwd, &["rev-parse", "--is-inside-work-tree"]).map(|s| s.trim() == "true") != Some(true) {
        return empty;
    }
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let head = has_head(cwd);
    let since = base.filter(|b| git(cwd, &["cat-file", "-e", &format!("{b}^{{commit}}")]).is_some());
    let base = since.unwrap_or(if head { "HEAD" } else { "--cached" });

    // status: XY path\0 (renames carry the old path as the next field)
    let mut statuses: Vec<(String, String)> = vec![];
    if let Some(raw) = git(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]) {
        let mut fields = raw.split('\0').filter(|s| !s.is_empty());
        while let Some(entry) = fields.next() {
            if entry.len() < 4 {
                continue;
            }
            let xy = &entry[..2];
            let path = entry[3..].to_string();
            let code = if xy == "??" {
                "?"
            } else if xy.contains('R') {
                fields.next();
                "R"
            } else if xy.contains('A') {
                "A"
            } else if xy.contains('D') {
                "D"
            } else {
                "M"
            };
            if since.is_none() || code == "?" {
                statuses.push((path, code.to_string()));
            }
        }
    }
    if let Some(b) = since {
        // committed + uncommitted changes since the task started
        if let Some(raw) = git(cwd, &["diff", "--name-status", "-z", b]) {
            let mut fields = raw.split('\0').filter(|s| !s.is_empty());
            while let Some(code) = fields.next() {
                let c = code.chars().next().unwrap_or('M');
                if c == 'R' || c == 'C' {
                    fields.next();
                }
                if let Some(path) = fields.next() {
                    let code = match c { 'A' => "A", 'D' => "D", 'R' => "R", _ => "M" };
                    statuses.insert(0, (path.to_string(), code.to_string()));
                }
            }
        }
    }

    let mut counts: HashMap<String, (u64, u64)> = HashMap::new();
    let numstat_args: Vec<&str> = vec!["diff", "--numstat", base];
    if let Some(raw) = git(cwd, &numstat_args) {
        for line in raw.lines() {
            let mut parts = line.splitn(3, '\t');
            let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else { continue };
            // Renames look like "old => new" or "dir/{old => new}"; key by the new path.
            let p = if let (Some(l), Some(r)) = (p.find('{'), p.find('}')) {
                let inner = &p[l + 1..r];
                let new = inner.split(" => ").last().unwrap_or(inner);
                format!("{}{}{}", &p[..l], new, &p[r + 1..]).replace("//", "/")
            } else {
                p.split(" => ").last().unwrap_or(p).to_string()
            };
            counts.insert(p, (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
        }
    }

    let mut patch = git(cwd, &["diff", base]).unwrap_or_default();
    if patch.len() > PATCH_CAP {
        patch.truncate(floor_char_boundary(&patch, PATCH_CAP));
        patch.push_str("\n… (diff truncated)\n");
    }

    let mut files = vec![];
    for (path, status) in statuses {
        let (add, del) = if status == "?" {
            let budget = PATCH_CAP.saturating_sub(patch.len());
            let (diff, n) = untracked_diff(cwd, &path, budget);
            if patch.len() < PATCH_CAP {
                patch.push_str(&diff);
            }
            (n, 0)
        } else {
            counts.get(&path).copied().unwrap_or((0, 0))
        };
        files.push(GitFile { path, add, del, status });
    }
    GitChanges { is_repo: true, branch, files, patch }
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[tauri::command]
pub async fn git_changes(cwd: String, base: Option<String>) -> GitChanges {
    let cwd = if let Some(rest) = cwd.strip_prefix("~/") {
        crate::engine::home().join(rest).display().to_string()
    } else {
        cwd
    };
    tauri::async_runtime::spawn_blocking(move || changes(&cwd, base.as_deref())).await.unwrap_or(GitChanges {
        is_repo: false,
        branch: None,
        files: vec![],
        patch: String::new(),
    })
}

#[cfg(test)]
mod tests {
    /// `cargo test -- --ignored --nocapture git_` against a real repo on this machine.
    #[test]
    #[ignore]
    fn git_real_repo() {
        let dir = std::env::var("ONDRA_GIT_TEST").unwrap_or_else(|_| env!("CARGO_MANIFEST_DIR").to_string());
        let c = super::changes(&dir, None);
        println!("repo={} branch={:?} files={} patch={}B", c.is_repo, c.branch, c.files.len(), c.patch.len());
        for f in c.files.iter().take(5) {
            println!("  {} {} +{} -{}", f.status, f.path, f.add, f.del);
        }
        let none = super::changes("/tmp", None);
        assert!(!none.is_repo);
    }
}

/// Run a command in `cwd` with the space's environment and return stdout, or the
/// last lines of stderr as the error.
fn run(cwd: &str, cmd: &str, args: &[&str], env: &[(String, String)]) -> Result<String, String> {
    let mut c = Command::new(cmd);
    c.args(args).current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0");
    space_env_into(&mut c, env);
    let out = c.output().map_err(|e| format!("{cmd}: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
        Err(tail[tail.len().saturating_sub(3)..].join("\n"))
    }
}

// Commit, push and PR run as the job's space: its git name and email, its
// GitHub login, its ssh keys (`env` = that space's `space_env`).

/// Commit everything in the folder with a message. Returns the short hash.
#[tauri::command]
pub async fn git_commit(cwd: String, message: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    let env = env.unwrap_or_default();
    run(&cwd, "git", &["add", "-A"], &env)?;
    run(&cwd, "git", &["commit", "-m", &message], &env)?;
    run(&cwd, "git", &["rev-parse", "--short", "HEAD"], &env)
}

/// Push the current branch to origin (sets upstream the first time).
#[tauri::command]
pub async fn git_push(cwd: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    let env = env.unwrap_or_default();
    let branch = run(&cwd, "git", &["rev-parse", "--abbrev-ref", "HEAD"], &env)?;
    run(&cwd, "git", &["push", "-u", "origin", &branch], &env)?;
    Ok(branch)
}

/// Open a pull request for the current branch with the GitHub CLI. Returns its URL.
#[tauri::command]
pub async fn git_pr(cwd: String, title: String, body: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    let _ = git_push(cwd.clone(), env.clone()).await?;
    run(&cwd, "gh", &["pr", "create", "--title", &title, "--body", &body], &env.unwrap_or_default())
        .map(|out| out.lines().last().unwrap_or("").to_string())
}

/// A pull request as the job's space sees it, for watching: its state, checks,
/// comments and reviews (`pr`), its line comments (`lines`) and who this space
/// is on GitHub (`me`). One JSON object; the app works out what is new.
#[tauri::command]
pub async fn gh_pr_state(url: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = env.unwrap_or_default();
        let tmp = std::env::temp_dir();
        let cwd = tmp.to_string_lossy();
        let pr = run(&cwd, "gh", &["pr", "view", &url, "--json", "state,mergeable,headRefOid,statusCheckRollup,comments,reviews"], &env)?;
        let path = url.trim_start_matches("https://github.com/").replace("/pull/", "/pulls/");
        let lines = run(
            &cwd,
            "gh",
            &["api", "--paginate", &format!("repos/{path}/comments?per_page=100"), "--jq", ".[] | {id, who: .user.login, bot: (.user.type == \"Bot\"), body, path, line: (.line // .original_line), at: .created_at}"],
            &env,
        )?;
        let me = run(&cwd, "gh", &["api", "user", "--jq", ".login"], &env).unwrap_or_default();
        let lines: Vec<&str> = lines.lines().filter(|l| !l.trim().is_empty()).collect();
        Ok(format!("{{\"pr\":{pr},\"lines\":[{}],\"me\":{}}}", lines.join(","), serde_json::to_string(&me).unwrap_or_else(|_| "\"\"".into())))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Throw away uncommitted changes to one file (back to the last commit).
#[tauri::command]
pub async fn git_revert_file(cwd: String, path: String) -> Result<(), String> {
    if run(&cwd, "git", &["ls-files", "--error-unmatch", &path], &[]).is_ok() {
        run(&cwd, "git", &["checkout", "--", &path], &[]).map(|_| ())
    } else {
        std::fs::remove_file(std::path::Path::new(&cwd).join(&path)).map_err(|e| e.to_string())
    }
}
