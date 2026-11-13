// The contract between the UI and the Rust side. Every Tauri command and
// event the app uses is declared here and nowhere else. Outside Tauri (plain
// `vite` in a browser) calls resolve to harmless fallbacks so the UI can be
// worked on without the shell.
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "../i18n";
import { logWarn } from "./log";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const call = <T>(cmd: string, args?: Record<string, unknown>, fallback?: T): Promise<T> =>
  inTauri ? invoke<T>(cmd, args).catch((e) => (failed(cmd, e), Promise.reject(e))) : Promise.resolve(fallback as T);

// A native command that failed goes to the app's log (lib/log.ts) for a feedback report: its name
// and the error, never its arguments. The same failure again within a minute is not repeated.
const failedAt = new Map<string, number>();
function failed(cmd: string, e: unknown) {
  if (cmd === "log_append") return;
  const line = `${cmd}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
  const now = Date.now();
  if (now - (failedAt.get(line) ?? 0) < 60_000) return;
  if (failedAt.size > 200) failedAt.clear();
  failedAt.set(line, now);
  logWarn("native", line);
}

export type Env = [string, string][];

// ───────────────────────── engine (3xhaustPi, bundled) ─────────────────────────
export interface EngineInfo {
  /** Absolute path of the bundled engine binary, null if missing. */
  enginePath: string | null;
  engineVersion: string | null;
  /** App data folder (state.json, sessions/, artifacts/, accounts/). */
  dataDir: string;
  /** The user's home folder, for expanding `~`. */
  home: string;
}
export const engineInfo = () =>
  call<EngineInfo>("engine_info", undefined, { enginePath: "/dev/engine", engineVersion: "dev", dataDir: "/tmp/ondra", home: "/Users/me" });

/**
 * Start `ondra-engine --no-extensions --mode rpc <args>` in `cwd` with `env`
 * added. Events arrive as `agent:event` {id, ev}; exit as `agent:exit`.
 * An env entry named PATH is prepended to the user's login-shell PATH.
 */
export const agentSpawn = async (id: string, cwd: string, args: string[], env: Env) => {
  // a first run whose engine is still coming in waits for it here
  await componentGate("engine");
  return call<void>("agent_spawn", { id, cwd, args, env });
};
/** Write one JSON command line to the agent's stdin. */
export const agentSend = (id: string, command: Record<string, unknown>) => call<void>("agent_send", { id, command });
export const agentKill = (id: string) => call<void>("agent_kill", { id });
/**
 * Stop one command the agent's shell runs, not the agent: the processes under its
 * engine whose command line is `program` with `arg` (SIGTERM, SIGKILL after 2s).
 * Resolves to how many were stopped.
 */
export const agentStopCommand = (id: string, program: string, arg?: string) => call<number>("agent_stop_command", { id, program, arg: arg ?? null }, 0);
export const agentAlive = () => call<string[]>("agent_alive", undefined, []);
/** "provider/model" ids this account can use. */
export const engineModels = (accountId: string) => call<string[]>("engine_models", { accountId }, ["openai-codex/gpt-5.6-terra"]);

// ───────────────────────── terminal (PTY) ─────────────────────────
/**
 * Open a PTY. `command` null = the user's login shell. Output arrives as
 * `pty:data` {id, data} (utf-8 text), exit as `pty:exit` {id, code}.
 */
export const ptyOpen = (id: string, cwd: string, command: string | null, args: string[], env: Env, cols: number, rows: number) =>
  call<void>("pty_open", { id, cwd, command, args, env, cols, rows });
/** A PTY running the bundled engine's interactive UI for one account (used for /login). */
export const ptyOpenLogin = (id: string, accountId: string, cols: number, rows: number) =>
  call<void>("pty_open_login", { id, accountId, cols, rows });
export const ptyWrite = (id: string, data: string) => call<void>("pty_write", { id, data });
export const ptyResize = (id: string, cols: number, rows: number) => call<void>("pty_resize", { id, cols, rows });
export const ptyClose = (id: string) => call<void>("pty_close", { id });

// ───────────────────────── state & files ─────────────────────────
export const stateLoad = () => call<string | null>("state_load", undefined, null);
export const stateSave = (json: string) => call<void>("state_save", { json });
/**
 * Save the state from its parts (see state/persist.ts): the state without its tasks, every
 * task's slot in order, and the tasks' JSON the native side doesn't hold yet. Returns the
 * slots it still lacks (nothing written then).
 */
export const stateSaveParts = (head: string, order: string[], tasks: Record<string, string>) => call<string[]>("state_save_parts", { head, order, tasks }, []);
/** The app is quitting and waits for the last save: it has been written. */
export const stateFlushed = () => call<void>("state_flushed");
export const artifactsDir = (workerId: string) => call<string>("artifacts_dir", { workerId }, "/tmp/ondra/artifacts");
export const pickFolder = (prompt: string) => call<string | null>("pick_folder", { prompt }, null);
export const revealPath = (path: string) => call<void>("reveal_path", { path });
/** The system's default browser (or Mail for mailto:). Links go through openLink (ui/links.ts), which picks this or the app's own browser. */
export const openExternal = (url: string) => call<void>("open_url", { url });
/** The app's log: append lines to a day's file (files before `keepFrom` are removed). */
export const logAppend = (day: string, lines: string[], keepFrom?: string) => call<void>("log_append", { day, lines, keepFrom: keepFrom ?? null });
/** The newest part of the app's log, up to `maxBytes`. */
export const logsRecent = (maxBytes: number) => call<string>("logs_recent", { maxBytes }, "2026-11-10 17:20:01 INFO  [app] start 0.38.5 · Mac OS X 15.1\n2026-11-10 17:21:44 ERROR [task] t1 failed: 엔진 종료 (코드 1)\n");
export const osVersion = () => call<string>("os_version", undefined, "macOS");
export const openInEditor = (path: string) => call<void>("open_in_editor", { path });
/** `env`: the space's spaceEnv, so the shell runs as that space. */
export const openInTerminal = (path: string, env: Env = []) => call<void>("open_in_terminal", { path, env });

export interface GitFile {
  path: string;
  add: number;
  del: number;
  /** "M" modified, "A" added, "D" deleted, "R" renamed, "?" untracked */
  status: string;
}
export interface GitChanges {
  isRepo: boolean;
  branch: string | null;
  files: GitFile[];
  /** Unified diff of the working tree against HEAD (untracked files included), capped. */
  patch: string;
}
const README_PATCH = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,14 +1,11 @@
 # ondra
 
-ondra is an experimental agent workspace. It was started as a weekend
-project and grew from there. Some of the notes below are out of date.
+여러 에이전트를 나란히 돌리는 macOS 작업 공간이에요.
 
-## Install (old)
-
-1. Install Rust nightly
-2. Install node 18
-3. Run \`make bootstrap\`
-4. Run \`make dev\`
+## 설치
+
+    pnpm install
+    pnpm tauri dev
 
 ## 구조
-See the wiki.
+\`src/\` 화면 · \`src-tauri/\` 네이티브 · \`engine/\` 에이전트
diff --git a/docs/setup.md b/docs/setup.md
--- a/docs/setup.md
+++ b/docs/setup.md
@@ -3,3 +3,5 @@
 ## 필요한 것
-- node 18
+- node 22
+- pnpm 10
+- Xcode 명령줄 도구
`;
// outside the app: the readme job's own sample, every other job the fixture's changes (fixtureChanges.ts)
export const gitChanges = (cwd: string, base?: string): Promise<GitChanges> =>
  inTauri || base === "readme"
    ? call<GitChanges>("git_changes", { cwd, base: base ?? null }, {
        isRepo: true,
        branch: "task/t3",
        files: [
          { path: "README.md", add: 6, del: 9, status: "M" },
          { path: "docs/setup.md", add: 3, del: 1, status: "M" },
        ],
        patch: README_PATCH,
      })
    : import("../state/fixtureChanges").then((m) => m.fixtureChanges());
/** One side of a changed file: at commit `rev`, or on disk now (`rev` null). `path` is from the repo top. */
export interface FileAt {
  text: string | null;
  size: number;
  binary: boolean;
  /** not there on that side (an added file's old side, a deleted file's new one) */
  missing: boolean;
  /** too long: `text` is its start */
  cut: boolean;
}
export const gitFileAt = (cwd: string, rev: string | null, path: string): Promise<FileAt> =>
  inTauri ? invoke<FileAt>("git_file_at", { cwd, rev, path }) : import("../state/fixtureChanges").then((m) => m.fixtureFileAt(rev, path));
/** A merged job's work once its worktree is gone: the commits it was merged between, and what changed. */
export interface Merged {
  from: string;
  to: string;
  changes: GitChanges;
}
export const gitMerged = (repo: string, branch: string, into: string | undefined, base: string): Promise<Merged | null> =>
  inTauri ? invoke<Merged | null>("git_merged", { repo, branch, into: into ?? null, base }) : import("../state/fixtureChanges").then((m) => m.fixtureMerged());

export interface WorktreeInfo {
  repo: string;
  path: string;
  branch: string;
  base: string;
  sub: string;
}
/** New worktree + branch for a task. Rejects when the folder is not a git repo with commits. */
// the git commands run as the job's space (`env` = its spaceEnv): its git identity, GitHub login, ssh keys
export const worktreeCreate = (cwd: string, dest: string, branch: string, env: Env = []) =>
  inTauri ? invoke<WorktreeInfo>("worktree_create", { cwd, dest, branch, env }) : Promise.reject(new Error(t("macOS 앱에서만 쓸 수 있어요")));
/** Commit what is left and merge into the repo's current branch; resolves to that branch's name. */
export const worktreeMerge = (repo: string, path: string, branch: string, message: string, env: Env = []) =>
  inTauri ? invoke<string>("worktree_merge", { repo, path, branch, message, env }) : Promise.reject(new Error(t("macOS 앱에서만 쓸 수 있어요")));
/** The job's branch is already in the remote's main line: its name ("origin/main"), else null. */
export const worktreeLanded = (path: string, env: Env = []) =>
  inTauri ? invoke<string | null>("worktree_landed", { path, env }) : Promise.resolve(null);
export const worktreeRemove = (repo: string, path: string, branch: string, keepBranch: boolean, env: Env = []) =>
  inTauri ? invoke<void>("worktree_remove", { repo, path, branch, keepBranch, env }) : Promise.resolve();
/** Every file in a folder, relative paths (git-tracked + new, or a capped walk). */
/** Git repos in a folder, one or two levels down (worktrees left out). */
export const fsRepos = (root: string) => call<string[]>("fs_repos", { root }, ["/Users/me/Work/projects/acme", "/Users/me/Work/projects/acme-web"]);
export const fsFiles = (cwd: string) => call<string[]>("fs_files", { cwd }, ["src/router.ts", "src/auth/session.ts", "src/auth/oauth.ts", "README.md", "package.json"]);
export interface FileText {
  text: string | null;
  size: number;
  binary: boolean;
  /** last change, ms since 1970 (0 when unknown) */
  modified?: number;
}
export const fsRead = (path: string) =>
  call<FileText>("fs_read", { path }, { text: "import { restore } from './auth/session';\n\nexport async function guard(to) {\n  await restore();\n  return to;\n}\n", size: 80, binary: false });
/** Lines in the folder's files containing `query` (case-insensitive), up to 500. */
export const fsGrep = (cwd: string, query: string) =>
  call<{ path: string; line: number; text: string }[]>("fs_grep", { cwd, query }, [
    { path: "src/router.ts", line: 4, text: "await restore();" },
    { path: "src/auth/session.ts", line: 12, text: "export async function restore() {" },
  ]);
/** Save edited text; rejects with "CHANGED" when the file moved on since `expect` (its modified time when read). Resolves to the new modified time. */
export const fsWrite = (path: string, text: string, expect?: number) => call<number>("fs_write", { path, text, expect: expect ?? null }, Date.now());
export const pickFiles = (prompt: string) => call<string[]>("pick_files", { prompt }, []);

// ───────────────────────── accounts ─────────────────────────
/** Login folder of an account ("default" = ~/.pi/agent). */
export const accountDirPath = (accountId: string) => call<string | null>("account_dir_path", { accountId }, null);
/** Providers with saved credentials in the account (keys of auth.json). */
export const accountProviders = (accountId: string) => call<string[]>("account_providers", { accountId }, []);
export const accountRemove = (accountId: string) => call<void>("account_remove", { accountId });

// ───────────────────────── direct connections ─────────────────────────
/** Where to ask. A null key or header value means the one stored in the keychain for `stored`. */
export type ProviderTarget = {
  baseUrl: string;
  api: string;
  key: string | null;
  headers: { name: string; value: string | null }[];
  stored: { accountId: string; provider: string } | null;
};
export type FoundModel = { id: string; name?: string; contextWindow?: number; maxTokens?: number; tools?: boolean; reasoning?: boolean; image?: boolean };
/** why a request didn't go through (see providers.rs) */
export type ProviderFail = { kind: string; status?: number | null; detail: string };
/** outside the app there is no server to ask: a short sample list, so the form can be looked at */
const SAMPLE: FoundModel[] = [
  { id: "qwen3-coder:30b", contextWindow: 262144, tools: true },
  { id: "llama3.1:8b", tools: true },
  { id: "gemma3:4b", tools: false, image: true },
];
export const providerModels = (target: ProviderTarget) => call<FoundModel[]>("provider_models", { target }, SAMPLE);
export const providerCheck = (target: ProviderTarget, model: string, reasoning: boolean) =>
  call<{ tools: boolean | null; ms: number }>("provider_check", { target, model, reasoning }, { tools: !model.includes("gemma"), ms: 420 });
/** Writes the connection into the account's models.json; the key and header values go to the keychain.
 *  key: "" removes it, null keeps the stored one. */
export const providerSave = (accountId: string, provider: string, entry: object, key: string | null, headers: { name: string; value: string | null }[]) =>
  call<void>("provider_save", { accountId, provider, entry, key, headers });
export const providerRemove = (accountId: string, provider: string) => call<void>("provider_remove", { accountId, provider });
/** delete a session folder's old conversation files, keeping the newest one */
export const sessionsPrune = (dir: string) => call<void>("sessions_prune", { dir }, undefined);

// ───────────────────────── importing from other agent tools ─────────────────────────
export type SourceId = "claude" | "codex" | "pi" | "3xhaust" | "omo" | "cursor" | "opencode";

export interface ImportSession {
  source: SourceId;
  /** Absolute path of the session file (jsonl) or folder. */
  path: string;
  /** Project folder the session ran in ("" if unknown). */
  cwd: string;
  /** First user message (or the tool's own title), one line, ≤120 chars. */
  title: string;
  /** Last modified, ms since epoch. */
  updatedAt: number;
  /** Number of user + assistant messages (approximate is fine). */
  messages: number;
}

export interface ImportSource {
  id: SourceId;
  /** Display name: "Claude Code", "Codex", "pi", "3xhaustPi", "OmO", "Cursor", "opencode". */
  name: string;
  found: boolean;
  root: string;
  /** Global instruction files: ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.pi/agent/AGENTS.md, … */
  rules: { path: string; text: string }[];
  /** Skills in Agent-Skills format (folders with SKILL.md). `description` from its front matter. */
  skills: { name: string; path: string; description: string }[];
  /** Memory notes (e.g. ~/.claude/projects/<p>/memory/*.md). `project` = decoded project path if known. */
  memories: { path: string; project: string; text: string }[];
  /** Newest first, at most 60. */
  sessions: ImportSession[];
  /** Credentials for this tool exist (informational; Ondra never copies tokens). */
  loggedIn: boolean;
}
/** Scan the home folder for other agent tools. Read-only; caps file sizes (rules/memory ≤ 32 KB each). */
export const scanAgents = () => call<ImportSource[]>("scan_agents", undefined, []);

export interface Transcript {
  cwd: string;
  /** Plain text turns, oldest first; tool calls summarised as one line; capped to the last ~120 turns / 60 KB. */
  turns: { role: "user" | "assistant" | "tool"; text: string }[];
}
/** Read one session from another tool as plain turns. */
export const readTranscript = (source: SourceId, path: string) => call<Transcript>("read_transcript", { source, path }, { cwd: "", turns: [] });

// ───────────────────────── bundled tools ─────────────────────────
export interface ToolStatus {
  browserVersion: string | null;
  /** The bundled Chrome ondra-browser drives (or a system Chrome). */
  chromeReady: boolean;
  desktopVersion: string | null;
  accessibility: boolean;
  screenRecording: boolean;
}
export const toolStatus = () =>
  call<ToolStatus>("tool_status", undefined, { browserVersion: "1.0.0", chromeReady: true, desktopVersion: "0.4.6", accessibility: true, screenRecording: true });
/** Ask macOS for Accessibility (shows the system prompt once). */
export const requestAccessibility = () => call<boolean>("request_accessibility", undefined, true);
export const openPrivacySettings = (pane: "accessibility" | "screen") => call<void>("open_privacy_settings", { pane });
export const remoteStart = () => call<void>("remote_start");
export const remoteStop = () => call<void>("remote_stop");
export const remoteCmd = (cmd: Record<string, unknown>) => call<void>("remote_cmd", { cmd });
export const remoteHostName = () => call<string>("remote_host_name", undefined, "Mac");
export const remoteAwake = (on: boolean) => call<void>("remote_awake", { on });
export const onRemote = (fn: (ev: Record<string, unknown>) => void): Promise<UnlistenFn> =>
  inTauri ? listen<Record<string, unknown>>("remote", (e) => fn(e.payload)) : Promise.resolve(() => {});
export const permissionGuide = (pane: "accessibility" | "screen", title: string, sub: string) => call<void>("permission_guide", { pane, title, sub });
/** Env every worker gets: bundled tools on PATH, its tab in the shared browser, keychain sign-in, artifacts dir. */
export const workerEnv = async (workerId: string, space?: string) => {
  // every job gets the shared browser: one whose browser is still coming in waits for it
  if (workerId !== "tools") await componentGate("chrome");
  return call<Env>("worker_env", { workerId, space: space ?? null }, []);
};
/** SKILL.md paths passed to workers with --skill. */
export const workerSkills = () => call<string[]>("worker_skills", undefined, []);
type SpaceRef = { id: string; cliHome?: string };
/** this space's command-line logins (gh, git, ssh, aws, vercel …), as environment for its agents */
export const spaceEnv = (s: SpaceRef) => call<[string, string][]>("space_env", { space: s.id, home: s.cliHome }, []);
export const spaceTools = (s: SpaceRef) =>
  call<{ home: string | null; gh_user: string | null; git_name: string | null; git_email: string | null } | null>("space_tools", { space: s.id, home: s.cliHome }, null);
export const spaceGhLogin = (s: SpaceRef) => call<void>("space_gh_login", { space: s.id, home: s.cliHome }, undefined);
export const spaceGitIdentity = (s: SpaceRef, name: string, email: string) => call<void>("space_git_identity", { space: s.id, home: s.cliHome, name, email }, undefined);
export const globalSkills = () => call<{ name: string; path: string; description: string }[]>("global_skills", undefined, []);
export interface Limit {
  provider: string;
  /** minutes: 300 = 5 hours, 10080 = a week */
  window: number;
  used: number;
  resetsAt?: number | null;
  /** window 0: paid credits on top of the plan ("12.5", "무제한", "$61.95 / $200") */
  credits?: string;
}
export const accountLimits = (accountId: string) =>
  call<Limit[]>("account_limits", { accountId }, [
    { provider: "openai-codex", window: 300, used: 41, resetsAt: Date.now() + 2.4 * 3_600_000 },
    { provider: "openai-codex", window: 10080, used: 100, resetsAt: Date.now() + 5.1 * 86_400_000 },
    { provider: "openai-codex", window: 0, used: 0, credits: "12.5" },
  ]);
export const accountEmail = (accountId: string) => call<string | null>("account_email", { accountId }, "me@example.com");
export const gitCommit = (cwd: string, message: string, env: Env = []) => call<string>("git_commit", { cwd, message, env }, "abc1234");
export const gitPush = (cwd: string, env: Env = []) => call<string>("git_push", { cwd, env }, "task/demo");
/** a pull request's state, checks, comments and reviews as the space sees it (raw JSON, see prWatch.ts) */
export const ghPrState = (url: string, env: Env = []) => call<string>("gh_pr_state", { url, env }, "");
/** everything the PR view shows, diff included (raw JSON, see prView.ts) */
/** Issues of the folder's repo for a GitHub search (JSON array as text). */
export const ghIssues = (cwd: string, search: string, env: Env = []) =>
  call<string>("gh_issues", { cwd, search, env }, JSON.stringify([
    { number: 214, title: "로그인 후 대시보드로 가지 않아요", state: "OPEN", labels: [{ name: "bug", color: "d73a4a" }], assignees: [{ login: "me" }], author: { login: "mina" }, updatedAt: new Date(Date.now() - 3.6e6).toISOString(), url: "https://github.com/acme/web/issues/214" },
    { number: 209, title: "요금제 페이지에 연간 결제 추가", state: "OPEN", labels: [{ name: "feature", color: "a2eeef" }, { name: "billing", color: "5319e7" }], assignees: [], author: { login: "jun" }, updatedAt: new Date(Date.now() - 8.6e7).toISOString(), url: "https://github.com/acme/web/issues/209" },
    { number: 198, title: "다크 모드에서 표 테두리가 안 보여요", state: "OPEN", labels: [{ name: "design", color: "fbca04" }], assignees: [], author: { login: "me" }, updatedAt: new Date(Date.now() - 2.6e8).toISOString(), url: "https://github.com/acme/web/issues/198" },
  ]));
/** One issue with body and comments (JSON as text). */
export const ghIssue = (cwd: string, number: number, env: Env = []) =>
  call<string>("gh_issue", { cwd, number, env }, JSON.stringify({ number, title: "로그인 후 대시보드로 가지 않아요", state: "OPEN", body: "로그인하면 `/login`에 그대로 머물러요.\n\n- 크롬, 사파리 둘 다\n- 새로고침하면 대시보드로 가요", labels: [{ name: "bug", color: "d73a4a" }], assignees: [], author: { login: "mina" }, url: `https://github.com/acme/web/issues/${number}`, comments: [] }));
export const ghPrView = (url: string, env: Env = []) => call<string>("gh_pr_view", { url, env }, "");
export const gitPr = (cwd: string, title: string, body: string, env: Env = []) => call<string>("git_pr", { cwd, title, body, env }, "https://github.com/acme/app/pull/42");
export const gitRevertFile = (cwd: string, path: string) => call<void>("git_revert_file", { cwd, path });
export const notify = (title: string, body: string) => call<void>("notify", { title, body });
export const workerExtensions = () => call<string[]>("worker_extensions", undefined, []);
export interface SkillFile {
  name: string;
  /** The SKILL.md workers get (the user's changed copy when there is one). */
  path: string;
  /** The user changed it; their copy is used. */
  overridden: boolean;
  /** The bundled original. */
  original: string;
}
/** The skills that ship with the app, each replaced by the user's changed copy if any. */
export const skillList = () =>
  call<SkillFile[]>("skill_list", undefined, [
    { name: "browser-use", path: "/skills/browser-use/SKILL.md", overridden: false, original: "/skills/browser-use/SKILL.md" },
    { name: "code-review", path: "/data/skill-overrides/code-review/SKILL.md", overridden: true, original: "/skills/code-review/SKILL.md" },
    { name: "device-use", path: "/skills/device-use/SKILL.md", overridden: false, original: "/skills/device-use/SKILL.md" },
  ]);
/**
 * Write a SKILL.md: `changed` = the user's copy of a bundled skill (workers get it
 * instead), else a skill made in the app. Resolves to the skill's folder.
 */
export const skillSave = (name: string, text: string, changed: boolean) =>
  call<string>("skill_save", { name, text, changed }, `/data/${changed ? "skill-overrides" : "skills"}/${name}`);
/** Remove a skill made in the app, or (`changed`) the user's change to a bundled one. */
export const skillRemove = (name: string, changed: boolean) => call<void>("skill_remove", { name, changed });
/** Hooks as JSON (an array), read by extensions/hooks.ts in every worker. */
export const hooksLoad = () => call<string>("hooks_load", undefined, "[]");
export const hooksSave = (json: string) => call<void>("hooks_save", { json });
/** Port of the worker's live browser stream (ondra-browser), null if closed. */
export const browserStreamPort = (workerId: string, space?: string) => call<number | null>("browser_stream_port", { workerId, space: space ?? null }, null);
/** A job ended: close its tab in the shared browser (logins stay). */
export const browserRelease = (workerId: string, space?: string) => call<void>("browser_release", { workerId, space: space ?? null });
/** Start (or find) the shared browser and the Browser view's own tab; its live stream port. */
export const sharedBrowserOpen = (space?: string) => call<number>("shared_browser_open", { space: space ?? null }, 0);
/** check the shared browser with a fresh connection and restart it if it hangs */
export const browserCheck = (space?: string) => call<number>("browser_check", { space: space ?? null }, 0);
/** Drive the Browser view's tab. */
export const sharedBrowserGo = (action: "open" | "back" | "forward" | "reload", url?: string, space?: string) =>
  call<void>("shared_browser_go", { action, url: url ?? null, space: space ?? null });

// ───────────────────────── in-app browser ─────────────────────────
/** Show the space's in-app browser (a real webview, its own cookies) over this area of the window; `url` opens a page. */
export const inBrowserShow = (r: { x: number; y: number; w: number; h: number }, space: string, url?: string) => call<void>("inbrowser_show", { ...r, url: url ?? null, space });
export const inBrowserHide = () => call<void>("inbrowser_hide");
/** Copy the in-app browser's cookies for `url` (or all) into the jobs' browser, and wait. */
export const inBrowserShare = (space: string, url?: string) => call<void>("inbrowser_share", { url: url ?? null, space });
export const inBrowserGo = (action: "open" | "back" | "forward" | "reload", space: string, url?: string) => call<void>("inbrowser_go", { action, url: url ?? null, space });
/** Each page it starts or finishes loading. */
export const onInBrowserPage = (f: (p: { url: string; loading: boolean; space: string }) => void): Promise<UnlistenFn> =>
  inTauri ? listen<{ url: string; loading: boolean; space: string }>("inbrowser-page", (e) => f(e.payload)) : Promise.resolve(() => {});

// ───────────────────────── windows ─────────────────────────
export const openCapture = () => call<void>("open_capture");
export const hideCapture = () => call<void>("hide_capture");
/** From the capture window: emits `capture:submitted` {text, space} to main. */
export const submitCapture = (text: string, space: string) => call<void>("submit_capture", { text, space });
export const setFocusGuard = (on: boolean) => call<void>("focus_guard", { on });
export const setTrayCount = (running: number, waiting: number) => call<void>("set_tray_count", { running, waiting });
/** The keys Rust answers to, as chord text (null: unbound): quick input's global hotkey, the menu's Quit
 * (held) and Close; with `save`, kept for the next launch too. Resolves to what couldn't be taken ("capture"). */
export const applyKeys = (keys: { capture: string | null; quit: string | null; closePane: string | null }, save = true) =>
  call<string[]>("keys_apply", { keys, save }, []);

/** A local file (screenshot, recording) as something an <img> can show. */
export const fileSrc = (path: string) => (inTauri && path.startsWith("/") ? convertFileSrc(path) : path);
/** A page to show in a frame: like fileSrc, but only the leading "/" is encoded, so the page's relative links
 *  (its css, scripts, images, other pages) resolve inside its own folder. */
export const pageSrc = (path: string) =>
  inTauri && path.startsWith("/") ? convertFileSrc("/") + path.slice(1).split("/").map(encodeURIComponent).join("/") : path;
export const pdfSrc = (path: string, modified?: number) => `/pdf.html?${new URLSearchParams({ file: fileSrc(path) + (modified === undefined ? "" : `?v=${modified}`) })}`;

export function onEvent<T>(name: string, fn: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<T>(name, (e) => fn(e.payload));
}
/** Save a pasted image into the app's folder; returns its path. */
export const savePaste = (bytes: number[], ext: string) => call<string | null>("save_paste", { bytes, ext }, null);
/** Paths of the files on the clipboard (copied in Finder or by a screenshot tool), none if it holds no files. */
export const clipboardFiles = () => call<string[]>("clipboard_files", undefined, []);
export interface ArtifactFile {
  path: string;
  name: string;
  size: number;
  modified: number;
}
/** Files a job left in its artifacts folder, newest first. */
export const artifactsList = (workerId: string) => call<ArtifactFile[]>("artifacts_list", { workerId }, []);
/** New lines of a job's reverse-engineering trace, from byte `from` on. */
export const reverseTrace = (workerId: string, from: number): Promise<{ text: string; end: number }> =>
  inTauri ? invoke("reverse_trace", { workerId, from }) : fixtureTrace(workerId, from);
// the fixture's one reversing job reads a real trace (ondra-binary on Ondra's own helper)
async function fixtureTrace(workerId: string, from: number) {
  if (!import.meta.env.DEV || workerId !== "t_re" || from > 0) return { text: "", end: from };
  const text = (await import("../state/fixture-reverse.jsonl?raw")).default;
  return { text, end: text.length };
}

// ── device hub
export interface Device {
  id: string;
  name: string;
  platform: "ios" | "android";
  kind: "simulator" | "emulator" | "phone";
  runtime: string;
  booted: boolean;
  serial?: string | null;
  lastUsed?: number | null;
}
export const devicesList = () =>
  call<Device[]>("devices_list", undefined, [
    { id: "A1B2", name: "iPhone 17 Pro", platform: "ios", kind: "simulator", runtime: "iOS 26.3", booted: true, lastUsed: Date.now() - 60_000 },
    { id: "C3D4", name: "pay-test", platform: "ios", kind: "simulator", runtime: "iOS 26.3", booted: false, lastUsed: Date.now() - 86_400_000 },
    { id: "Pixel_9", name: "Pixel 9", platform: "android", kind: "emulator", runtime: "Android 에뮬레이터", booted: true, serial: "emulator-5554" },
    { id: "pixel_test", name: "pixel test", platform: "android", kind: "emulator", runtime: "Android 에뮬레이터", booted: false },
  ]);
/** Shut down the devices jobs made and left behind, except those of the jobs in `keep`. */
export const jobDevicesRelease = (keep: string[]) => call<string[]>("job_devices_release", { keep }, []);
export const deviceBoot = (d: Device) => call<void>("device_boot", { platform: d.platform, id: d.id });
export const deviceShutdown = (d: Device) => call<void>("device_shutdown", { platform: d.platform, id: d.id, serial: d.serial ?? null });
export const deviceDelete = (d: Device) => call<void>("device_delete", { platform: d.platform, id: d.id });
export const deviceShot = (d: Device) => call<string>("device_shot", { platform: d.platform, id: d.id, serial: d.serial ?? null }, "");
export type DeviceAction = "tap" | "swipe" | "text" | "home" | "back" | "enter";
/** Drive a device. x/y are fractions of the screen (0..1); ms is a swipe's length. */
export const deviceInput = (d: Device, action: DeviceAction, o: { x?: number; y?: number; x2?: number; y2?: number; text?: string; ms?: number } = {}) =>
  call<void>("device_input", { platform: d.platform, id: d.id, serial: d.serial ?? null, action, x: o.x ?? null, y: o.y ?? null, x2: o.x2 ?? null, y2: o.y2 ?? null, text: o.text ?? null, ms: o.ms ?? null });
/**
 * The device's screen, live: iOS JPEG frames as the screen changes (up to `fps`),
 * Android PNG screenshots in a loop. An empty buffer means the stream ended.
 * Resolves to a token for `deviceStreamStop`; null outside Tauri.
 */
export const deviceStream = (d: Device, o: { max: number; fps: number }, onFrame: (frame: ArrayBuffer) => void): Promise<number | null> => {
  if (!inTauri) return Promise.resolve(null);
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (m) => onFrame(m instanceof ArrayBuffer ? m : new Uint8Array(m as unknown as number[]).buffer);
  return invoke<number>("device_stream", { platform: d.platform, id: d.id, serial: d.serial ?? null, max: Math.round(o.max), fps: Math.round(o.fps), onFrame: ch });
};
export const deviceStreamStop = (token: number) => call<void>("device_stream_stop", { token });
/** The user touched the device: a stream that slowed down on a still screen speeds up. */
export const deviceStreamPoke = (token: number) => call<void>("device_stream_poke", { token });
/** iOS: start the input helper before the first touch. */
export const deviceInputWarm = (d: Device) => call<void>("device_input_warm", { id: d.id });
/** iOS: one step of a live touch, x/y as 0..1. Send them one after another. */
export const deviceTouch = (d: Device, phase: "down" | "move" | "up", x: number, y: number) => call<void>("device_touch", { id: d.id, phase, x, y });
/** iOS: stop the input helper (the device view closed). */
export const deviceRelease = (d: Device) => call<void>("device_release", { id: d.id });
/** One key typed while the screen has focus (KeyboardEvent key, code and shift). */
export const deviceKey = (d: Device, k: { key: string; code: string; shift: boolean }) =>
  call<void>("device_key", { platform: d.platform, id: d.id, serial: d.serial ?? null, key: k.key, code: k.code, shift: k.shift });
/** iOS: show/hide the on-screen keyboard. Resolves to whether it is now shown. */
export const deviceKeyboard = (d: Device) => call<boolean>("device_keyboard", { id: d.id }, false);
/** Turn the device between portrait and landscape; resolves to true when now landscape. */
export const deviceRotate = (d: Device) => call<boolean>("device_rotate", { platform: d.platform, id: d.id, serial: d.serial ?? null }, false);
/** Whether the device was turned to landscape from here. */
export const deviceLandscape = (d: Device) => call<boolean>("device_landscape", { id: d.id }, false);
/** Full-size screenshot on the Desktop; resolves to its path. */
/** `space`: the space's name goes first in the file name, so each space's captures stay apart on the Desktop. */
export const deviceScreenshot = (d: Device, space = "") => call<string>("device_screenshot", { platform: d.platform, id: d.id, serial: d.serial ?? null, name: `${space ? `${space} ` : ""}${d.name}` }, "");
/** Start or stop recording; resolves to the saved file when it stops, "" when it starts. */
export const deviceRecord = (d: Device, space = "") => call<string>("device_record", { platform: d.platform, id: d.id, serial: d.serial ?? null, name: `${space ? `${space} ` : ""}${d.name}` }, "");
/** Ids of devices being recorded now. */
export const deviceRecording = () => call<string[]>("device_recording", undefined, []);
export const ensureDir = (path: string) => call<string>("ensure_dir", { path }, path);
/** A folder with only this space's job and main-chat logs (btw and the side chat read there). */
export const spaceLogs = (space: string, ids: string[]) => call<string>("space_logs", { space, ids }, "");
/** Write the memory as markdown files (one per piece + an index) into the app's memory folder. Returns the folder. */
/** memory/rule files other agent tools keep in a folder */
export const memorySources = (folder: string) => call<{ path: string; text: string }[]>("memory_sources", { folder }, []);
export const memoryMirror = (files: { path: string; text: string; once?: boolean }[], space?: string) => call<string>("memory_mirror", { files, space: space ?? null }, "");
export const memoryFolder = () => call<string>("memory_folder", undefined, "");
/** Save this version of the memory in its folder's git repo (null: nothing changed). */
export const memoryGitCommit = (msg: string, snapshot: string) => call<string | null>("memory_git_commit", { msg, snapshot }, null);
/** Saved versions of the memory, newest first. */
export const memoryGitLog = (limit = 60) => call<{ sha: string; at: number; msg: string }[]>("memory_git_log", { limit }, []);
/** The pieces (JSON) as saved in one version. */
export const memoryGitShow = (sha: string) => call<string>("memory_git_show", { sha }, "");
/** Which of these files exist. */
export const pathsExist = (paths: string[]) => call<boolean[]>("paths_exist", { paths }, paths.map(() => true));

// ───────────────────────── memory search by meaning + the tools' door ─────────────────────────
/** Unit vectors for texts from the local embedding model (downloaded once). */
export const embedTexts = (texts: string[], query = false) => call<number[][]>("embed_texts", { texts, query }, []);
/** Answer a `bridge:call` from an engine tool. */
export const bridgeReply = (id: number, value: string) => call<void>("bridge_reply", { id, value });
/** ONDRA_BRIDGE + its token, for main's engine (workers get them in workerEnv) */
export const bridgeEnv = () => call<Env>("bridge_env", undefined, []);

// ───────────────────────── components (engine, browser, analyzer) ─────────────────────────
/** One of the big parts that live outside the app (see src-tauri/src/components.rs). */
export interface ComponentStatus {
  name: "engine" | "chrome" | "binary-analysis" | string;
  version: string;
  state: "queued" | "copying" | "downloading" | "ready" | "failed";
  /** 0–100 while downloading */
  percent: number;
  size: number;
  error: string | null;
}
/** Each component of this build and how far it is (empty in development builds). */
export const componentsStatus = () => call<ComponentStatus[]>("components_status", undefined, []);
export const onComponents = (f: (list: ComponentStatus[]) => void): Promise<UnlistenFn> =>
  inTauri ? listen<ComponentStatus[]>("components:status", (e) => f(e.payload)) : Promise.resolve(() => {});
/** Resolves once a usable copy of the component is here (or it failed for now). */
export const componentsWait = (name: string) => call<ComponentStatus["state"]>("components_wait", { name }, "ready");
let componentGate: (name: string) => Promise<unknown> = componentsWait;
/** What a job start does to wait for a component (the app adds a notice to it). */
export const setComponentGate = (gate: (name: string) => Promise<unknown>) => void (componentGate = gate);

/** A newer release on GitHub, or null (always null in development builds). */
export const checkForUpdate = () => call<{ version: string; notes?: string } | null>("update_check", {}, null);
/** Fetch the newer release's package in the background; true once it is ready to install. */
export const prepareUpdate = () => call<boolean>("update_prepare", {}, false);
/** Install it (the package fetched before, else fetched now); the app restarts on success. */
export const installUpdate = () => call<void>("update_install");
/** How far the package download is: 0–100, or -1 when the size isn't known. */
export const onUpdateProgress = (f: (p: { version: string; percent: number }) => void): Promise<UnlistenFn> =>
  inTauri ? listen<{ version: string; percent: number }>("update:progress", (e) => f(e.payload)) : Promise.resolve(() => {});
/** Save bytes as a file in ~/Downloads (a free name); returns the path. */
export const saveDownload = (bytes: number[], name: string) => call<string>("save_download", { bytes, name }, `~/Downloads/${name}`);
/** Settings › 시크릿: the saved names (values stay in the keychain and never come back to the page). */
export interface SavedSecrets {
  global: string[];
  /** project id → names */
  projects: Record<string, string[]>;
}
export const secretList = () => call<SavedSecrets>("secret_list", undefined, { global: [], projects: {} });
/** For a project: `writeDotenv` also writes it into the project's .env; `addIgnore` first adds .env to .gitignore. */
export const secretSet = (o: { name: string; value: string; project?: string; folder?: string; writeDotenv?: boolean; addIgnore?: boolean }) =>
  call<SavedSecrets>("secret_set", o, { global: [], projects: {} });
export const secretDelete = (o: { name: string; project?: string; folder?: string }) => call<SavedSecrets>("secret_delete", o, { global: [], projects: {} });
/** Takes the keys, tokens and passwords this Mac's projects keep in .env into the keychain (values stay native). */
export const secretSync = (projects: [string, string][]) =>
  call<{ saved: SavedSecrets; added: string[] }>("secret_sync", { projects }, { saved: { global: [], projects: {} }, added: [] });
export interface SecretGroup {
  names: string[];
  /** project: undefined for a secret of every job; item: "NAME" or "dir/sub:NAME" */
  places: { project?: string | null; item: string }[];
}
/** Every saved secret, those with the same value as one (compared natively, values never sent). */
export const secretOverview = () => call<SecretGroup[]>("secret_overview", undefined, []);
/** What a routine watches on the folder's GitHub repo, as gh prints it (routineEvents.ts reads it). */
export const ghWatch = (cwd: string, event: string, search: string, env: Env = []) => call<string>("gh_watch", { cwd, event, search, env }, "[]");
