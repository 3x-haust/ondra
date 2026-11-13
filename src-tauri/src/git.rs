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

/// One side of a changed file, for the changes editor: the file at a commit
/// (`rev`), or as it is on disk now (`rev` None). Paths are from the repo top,
/// as `git diff` prints them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAt {
    /// None when binary or missing at that side.
    text: Option<String>,
    size: u64,
    binary: bool,
    /// not there at that side (an added file's old side, a deleted file's new one)
    missing: bool,
    /// longer than FILE_CAP: only the start is in `text`
    cut: bool,
}

const FILE_CAP: usize = 1024 * 1024;

fn git_bytes(cwd: &str, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", user_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

fn top_of(cwd: &str) -> String {
    git(cwd, &["rev-parse", "--show-toplevel"]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| cwd.to_string())
}

pub fn file_at(cwd: &str, rev: Option<&str>, path: &str) -> FileAt {
    let top = top_of(cwd);
    let bytes = match rev {
        None => std::fs::read(Path::new(&top).join(path)).ok(),
        Some(r) => git_bytes(&top, &["show", &format!("{r}:{path}")]),
    };
    let Some(mut bytes) = bytes else { return FileAt { text: None, size: 0, binary: false, missing: true, cut: false } };
    let size = bytes.len() as u64;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return FileAt { text: None, size, binary: true, missing: false, cut: false };
    }
    let cut = bytes.len() > FILE_CAP;
    if cut {
        let end = bytes[..FILE_CAP].iter().rposition(|b| *b == b'\n').map_or(FILE_CAP, |i| i + 1);
        bytes.truncate(end);
    }
    FileAt { text: Some(String::from_utf8_lossy(&bytes).into_owned()), size, binary: false, missing: false, cut }
}

#[tauri::command]
pub async fn git_file_at(cwd: String, rev: Option<String>, path: String) -> FileAt {
    tauri::async_runtime::spawn_blocking(move || file_at(&cwd, rev.as_deref(), &path))
        .await
        .unwrap_or(FileAt { text: None, size: 0, binary: false, missing: true, cut: false })
}

/// What `from`..`to` changed, in the same shape as `changes` (commits only, nothing on disk).
pub fn changes_between(cwd: &str, from: &str, to: &str) -> GitChanges {
    let branch = None;
    let mut files = vec![];
    let mut counts: HashMap<String, (u64, u64)> = HashMap::new();
    if let Some(raw) = git(cwd, &["diff", "--numstat", "-z", from, to]) {
        // "a\td\tpath\0", or "a\td\t\0old\0new\0" for a rename
        let mut fields = raw.split('\0');
        while let Some(head) = fields.next() {
            let mut parts = head.splitn(3, '\t');
            let (Some(a), Some(d), Some(p)) = (parts.next(), parts.next(), parts.next()) else { continue };
            let path = if p.is_empty() {
                fields.next();
                fields.next().unwrap_or("").to_string()
            } else {
                p.to_string()
            };
            counts.insert(path, (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
        }
    }
    if let Some(raw) = git(cwd, &["diff", "--name-status", "-z", from, to]) {
        let mut fields = raw.split('\0').filter(|s| !s.is_empty());
        while let Some(code) = fields.next() {
            let c = code.chars().next().unwrap_or('M');
            if c == 'R' || c == 'C' {
                fields.next();
            }
            if let Some(path) = fields.next() {
                let status = match c { 'A' | 'C' => "A", 'D' => "D", 'R' => "R", _ => "M" };
                let (add, del) = counts.get(path).copied().unwrap_or((0, 0));
                files.push(GitFile { path: path.to_string(), add, del, status: status.to_string() });
            }
        }
    }
    let mut patch = git(cwd, &["diff", from, to]).unwrap_or_default();
    if patch.len() > PATCH_CAP {
        patch.truncate(floor_char_boundary(&patch, PATCH_CAP));
        patch.push_str("\n… (diff truncated)\n");
    }
    GitChanges { is_repo: true, branch, files, patch }
}

/// A merged job's work, after its worktree is gone: the merge `into` made of
/// `branch` (from the reflog: the commit before it and the one it made), or, while
/// the branch is still there (a pull request kept it), `base`..`branch`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    from: String,
    to: String,
    changes: GitChanges,
}

pub fn merged(repo: &str, branch: &str, into: Option<&str>, base: &str) -> Option<Merged> {
    let commit = |r: &str| git(repo, &["rev-parse", "--verify", "-q", &format!("{r}^{{commit}}")]).map(|s| s.trim().to_string());
    let mut pair: Option<(String, String)> = None;
    if let Some(into) = into.filter(|s| !s.is_empty()) {
        if let Some(log) = git(repo, &["reflog", "show", "--format=%H%x09%gs", &format!("refs/heads/{into}")]) {
            let rows: Vec<(&str, &str)> = log.lines().filter_map(|l| l.split_once('\t')).collect();
            let tag = format!("merge {branch}:");
            if let Some(i) = rows.iter().position(|(_, s)| s.starts_with(&tag)) {
                if let Some((before, _)) = rows.get(i + 1) {
                    pair = Some((before.to_string(), rows[i].0.to_string()));
                }
            }
        }
    }
    if pair.is_none() {
        if let (Some(b), Some(tip)) = (commit(base), commit(branch)) {
            pair = Some((b, tip));
        }
    }
    let (from, to) = pair?;
    let changes = changes_between(repo, &from, &to);
    Some(Merged { from, to, changes })
}

#[tauri::command]
pub async fn git_merged(repo: String, branch: String, into: Option<String>, base: String) -> Option<Merged> {
    tauri::async_runtime::spawn_blocking(move || merged(&repo, &branch, into.as_deref(), &base)).await.ok().flatten()
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

    fn sh(cwd: &str, args: &[&str]) {
        assert!(std::process::Command::new("git").args(args).current_dir(cwd).status().unwrap().success(), "git {args:?}");
    }

    #[test]
    fn file_at_and_merged() {
        let root = std::env::temp_dir().join(format!("git-at-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        let r = root.display().to_string();
        sh(&r, &["init", "-q", "-b", "main"]);
        sh(&r, &["config", "user.email", "t@t"]);
        sh(&r, &["config", "user.name", "t"]);
        sh(&r, &["config", "commit.gpgsign", "false"]);
        std::fs::write(root.join("src/a.ts"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("old.txt"), "same\nsame\nsame\nsame\n").unwrap();
        sh(&r, &["add", "-A"]);
        sh(&r, &["commit", "-q", "-m", "init"]);
        let base = super::git(&r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        sh(&r, &["checkout", "-q", "-b", "task/x"]);
        std::fs::write(root.join("src/a.ts"), "one\nTWO\n").unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2]).unwrap();
        sh(&r, &["mv", "old.txt", "new.txt"]);
        sh(&r, &["add", "-A"]);
        sh(&r, &["commit", "-q", "-m", "work"]);

        let at = super::file_at(&r, Some(&base), "src/a.ts");
        assert_eq!(at.text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(super::file_at(&r, None, "src/a.ts").text.as_deref(), Some("one\nTWO\n"));
        assert!(super::file_at(&r, Some(&base), "b.bin").missing);
        assert!(super::file_at(&r, None, "b.bin").binary);

        sh(&r, &["checkout", "-q", "main"]);
        sh(&r, &["merge", "-q", "--no-edit", "task/x"]);
        let m = super::merged(&r, "task/x", Some("main"), &base).expect("found in the reflog");
        assert_eq!(m.from, base);
        let mut got: Vec<(String, String)> = m.changes.files.iter().map(|f| (f.status.clone(), f.path.clone())).collect();
        got.sort();
        assert_eq!(got, vec![("A".into(), "b.bin".into()), ("M".into(), "src/a.ts".into()), ("R".into(), "new.txt".into())]);
        assert!(m.changes.patch.contains("rename from old.txt"));
        let _ = std::fs::remove_dir_all(&root);
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
    tauri::async_runtime::spawn_blocking(move || pr_json(&url, &env.unwrap_or_default(), "state,mergeable,headRefOid,statusCheckRollup,comments,reviews", false))
        .await
        .map_err(|e| e.to_string())?
}

/// Everything the PR view shows: the watch fields plus title, branches, files
/// and the diff (`diff`, cut at PR_DIFF_MAX bytes; `cut` says it was).
#[tauri::command]
pub async fn gh_pr_view(url: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        pr_json(
            &url,
            &env.unwrap_or_default(),
            "number,title,url,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,author,reviewDecision,statusCheckRollup,comments,reviews,files,additions,deletions",
            true,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Issues of the repo the folder belongs to (gh finds it from the git remote),
/// with a GitHub search such as `is:open assignee:@me`. A JSON array.
#[tauri::command]
pub async fn gh_issues(cwd: String, search: String, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let search = if search.trim().is_empty() { "is:open".to_string() } else { search };
        run(
            &cwd,
            "gh",
            &["issue", "list", "--limit", "100", "--search", &search, "--json", "number,title,state,labels,assignees,author,updatedAt,url"],
            &env.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One issue with its body and comments, for reading it and handing it to a job.
#[tauri::command]
pub async fn gh_issue(cwd: String, number: u64, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run(
            &cwd,
            "gh",
            &["issue", "view", &number.to_string(), "--json", "number,title,state,body,labels,assignees,author,url,comments"],
            &env.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a routine watches on the folder's GitHub repo (raw JSON for routineEvents.ts): `issue` and `pr`
/// (open ones, newest first), `review` (PRs asking me to review), `comment` (my open PRs with their
/// comments and reviews, each PR tagged with my login as `me`), `ci` (finished runs on the default
/// branch), `release`. `search` narrows issue/pr/review with GitHub search words.
#[tauri::command]
pub async fn gh_watch(cwd: String, event: String, search: Option<String>, env: Option<Vec<(String, String)>>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let env = env.unwrap_or_default();
        let search = search.unwrap_or_default();
        let search = search.trim();
        const ITEM: &str = "number,title,url,createdAt,author,body,isDraft";
        let with_search = |base: &str| if search.is_empty() { base.to_string() } else { format!("{base} {search}") };
        match event.as_str() {
            "issue" => run(&cwd, "gh", &["issue", "list", "--limit", "30", "--search", &with_search("is:open sort:created-desc"), "--json", "number,title,url,createdAt,author,body"], &env),
            "pr" => run(&cwd, "gh", &["pr", "list", "--limit", "30", "--search", &with_search("is:open sort:created-desc"), "--json", ITEM], &env),
            "review" => run(&cwd, "gh", &["pr", "list", "--limit", "30", "--search", &with_search("is:open review-requested:@me"), "--json", ITEM], &env),
            "comment" => {
                let me = run(&cwd, "gh", &["api", "user", "--jq", ".login"], &env).unwrap_or_default();
                let raw = run(&cwd, "gh", &["pr", "list", "--author", "@me", "--state", "open", "--limit", "20", "--json", "number,title,url,comments,reviews"], &env)?;
                let mut list: Vec<serde_json::Value> = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                for pr in list.iter_mut() {
                    if let Some(o) = pr.as_object_mut() {
                        o.insert("me".into(), serde_json::Value::String(me.clone()));
                    }
                }
                serde_json::to_string(&list).map_err(|e| e.to_string())
            }
            "ci" => {
                let branch = run(&cwd, "gh", &["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], &env)?;
                run(&cwd, "gh", &["run", "list", "--branch", branch.trim(), "--status", "completed", "--limit", "20", "--json", "databaseId,displayTitle,url,createdAt,headBranch,workflowName,conclusion"], &env)
            }
            "release" => run(&cwd, "gh", &["release", "list", "--limit", "10", "--json", "name,tagName,publishedAt,createdAt,isDraft"], &env),
            other => Err(format!("unknown event: {other}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

const PR_DIFF_MAX: usize = 1_500_000;

fn pr_json(url: &str, env: &[(String, String)], fields: &str, with_diff: bool) -> Result<String, String> {
    let tmp = std::env::temp_dir();
    let cwd = tmp.to_string_lossy();
    let pr = run(&cwd, "gh", &["pr", "view", url, "--json", fields], env)?;
    let path = url.trim_start_matches("https://github.com/").replace("/pull/", "/pulls/");
    let lines = run(
        &cwd,
        "gh",
        &[
            "api",
            "--paginate",
            &format!("repos/{path}/comments?per_page=100"),
            "--jq",
            ".[] | {id, who: .user.login, bot: (.user.type == \"Bot\"), body, path, line: (.line // .original_line), side, reply: .in_reply_to_id, url: .html_url, at: .created_at}",
        ],
        env,
    )?;
    let me = run(&cwd, "gh", &["api", "user", "--jq", ".login"], env).unwrap_or_default();
    let lines: Vec<&str> = lines.lines().filter(|l| !l.trim().is_empty()).collect();
    let quote = |s: &str| serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into());
    let mut out = format!("{{\"pr\":{pr},\"lines\":[{}],\"me\":{}", lines.join(","), quote(&me));
    if with_diff {
        let mut diff = run(&cwd, "gh", &["pr", "diff", url, "--color", "never"], env).unwrap_or_default();
        let cut = diff.len() > PR_DIFF_MAX;
        if cut {
            let mut end = PR_DIFF_MAX;
            while !diff.is_char_boundary(end) {
                end -= 1;
            }
            diff.truncate(end);
        }
        out.push_str(&format!(",\"diff\":{},\"cut\":{cut}", quote(&diff)));
    }
    out.push('}');
    Ok(out)
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
