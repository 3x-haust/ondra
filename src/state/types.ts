// Everything Ondra keeps. The whole AppState is saved to state.json.
import type { SourceId } from "../lib/native";

export type Permission = "ask" | "edits" | "full";
/** "home" = 개인 (always there); others are made by the user. */
export type SpaceId = string;
export type Status = "running" | "waiting" | "queued" | "done" | "paused" | "failed";
/** 0 = urgent … 3 = low */
export type Priority = 0 | 1 | 2 | 3;
/** heavy = needs the one machine-wide slot (simulator, builds, desktop control) */
export type Weight = "light" | "heavy";

export interface Space {
  id: SpaceId;
  label: string;
  /** Folder new tasks start in. */
  folder: string;
  /** Extra instructions every agent in this space follows. */
  rules: string;
  /** Home folder for this space's command-line logins (gh, git, aws, vercel …).
   * Empty: 개인 uses the Mac's own, every other space a folder of its own. */
  cliHome?: string;
  /** The Aside account (u0, u4 …) this space's jobs browse with. Empty: they use the built-in browser. */
  aside?: string;
  /** The user's own simulators, emulators and phones that belong to this space (device ids). */
  devices?: string[];
}

/** One turn's tokens plus the plan limits right after it. */
export interface Usage extends TokenStats {
  /** how long the turn took, and output tokens per second of generation */
  ms?: number;
  tps?: number;
  limits?: { window: number; used: number }[];
}

export interface TokenStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Account {
  /** "default" = the user's own ~/.pi/agent login */
  id: string;
  space: SpaceId;
  label: string;
  providers: string[];
  /** "provider/id"; empty = pick automatically */
  model: string;
  /** default 생각 깊이 for work on this account; empty = high (kept for models picked before efforts per model) */
  effort?: string;
  /** 생각 깊이 per model ("provider/id" → level): each model keeps its own */
  efforts?: Record<string, string>;
  /** Models that failed for this account (unsupported, no access). */
  badModels: string[];
  stats: TokenStats;
  lastUsedAt?: number;
  /** a direct connection (any compatible address and key) instead of a login */
  connection?: Connection;
}

/** API kinds the engine can talk to a custom provider with */
export type ConnectionApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface Connection {
  /** the provider id in the account's models.json ("direct-ollama"); models are "<provider>/<id>" */
  provider: string;
  preset: string;
  baseUrl: string;
  api: ConnectionApi;
  /** names of extra headers; their values (and the key) live in the keychain */
  headers: string[];
  hasKey: boolean;
  models: ConnectionModel[];
}

export interface ConnectionModel {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  /** 도구 사용 가능: off runs it with no tools (talk only) */
  tools: boolean;
  /** 추론 */
  reasoning: boolean;
  image: boolean;
  /** reasoning_effort values the server takes ("low, high, max"); empty = the usual ones */
  efforts?: string[];
}

/** One relay leg = one fresh engine session. */
export interface Leg {
  startedAt: number;
  endedAt?: number;
  handoff?: Handoff;
}

export interface Handoff {
  did: string[];
  next: string;
  evidence: { kind: string; ref: string }[];
  /** what was found that the next session would otherwise look up again */
  found?: string[];
  /** when the whole task counts as done */
  doneWhen?: string;
}

export type ToolKind = "read" | "search" | "edit" | "write" | "bash" | "browser" | "desktop" | "test" | "other";

export interface ToolCall {
  name: string;
  kind: ToolKind;
  /** Short target: file name, command, URL. */
  target: string;
  /** Full argument text for the expanded view. */
  detail?: string;
  /** For edits: line counts. */
  add?: number;
  del?: number;
  ok?: boolean;
  endedAt?: number;
  /** Cut off when the run ended (paused, failed, stopped): neither passed nor failed. */
  stopped?: boolean;
  /** For bash: id of the Shell holding live output. */
  shellId?: string;
  /** An edit/write to a notes file (now.md, context/, memory): shown as "기록", not as code. */
  note?: boolean;
  /** For notes: what was written (capped). */
  text?: string;
  /** For computer: the step (computerStep()) and the app the session works in. */
  act?: string;
  app?: string;
  /** a picture the agent looked at (reading an image file), its full path: shown as a thumbnail */
  image?: string;
}

/** One line of a task's transcript. */
export type Entry =
  /** `by`: another agent sent it, not the user: "main", or the id of the job that did (job_tell) */
  | { id: string; at: number; kind: "user"; text: string; by?: string }
  | { id: string; at: number; kind: "text"; text: string }
  | { id: string; at: number; kind: "tool"; tool: ToolCall }
  | { id: string; at: number; kind: "block"; block: Block }
  | { id: string; at: number; kind: "handoff"; leg: number; handoff: Handoff }
  | { id: string; at: number; kind: "turn"; ms: number; usage?: Usage }
  | { id: string; at: number; kind: "error"; text: string }
  | { id: string; at: number; kind: "note"; text: string }
  /** subagents this task started (consecutive spawns share one entry) */
  | { id: string; at: number; kind: "spawn"; childIds: string[] };

export interface Shell {
  id: string;
  command: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
  /** Cut off when the run ended, not finished on its own. */
  stopped?: boolean;
  /** Last ~3 KB of output (live while it runs). */
  tail: string;
  /** Left running on purpose: dev server, watcher, `&`, tail -f… */
  background?: boolean;
}

export interface PlanStep {
  text: string;
  state: "done" | "now" | "todo" | "skip";
}

export interface Task {
  id: string;
  space: SpaceId;
  topic: string;
  title: string;
  /** the git branch main named for this work (feat/…, fix/…); task/<id> when none */
  branch?: string;
  /** What was asked, as the captain wrote it down. */
  ask: string;
  cwd: string;
  status: Status;
  priority: Priority;
  weight: Weight;
  accountId: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** when Ondra merged its branch (mergeTask); older tasks lack it */
  mergedAt?: number;
  /** when its changes were thrown away (discardTask); older tasks lack it */
  discardedAt?: number;
  /** One line: what it is doing right now. */
  now: string;
  /** what the job itself last said it is doing (its "now" block); tool calls don't replace it */
  intent?: string;
  plan: PlanStep[];
  legs: Leg[];
  entries: Entry[];
  shells: Shell[];
  /** Latest screenshot path, if any. */
  shot?: string;
  /** Browser in use (live stream available). */
  browser?: boolean;
  /** Messages sent while it was not running; delivered on start. */
  inbox: string[];
  /** said while it was working: goes in, in order, once the current work is done (Codex queue).
   * `by`: another agent sent it (see Entry); `sent`: what the model gets when it differs from `text` */
  queue?: { id: string; text: string; at: number; by?: string; sent?: string }[];
  /** sent to its running engine (a subagent's result, the user's words) and not taken by the model
   * yet: an engine that dies (a restart) loses them, so the next session is given them.
   * `from`: the subagent whose result it is; `shown`: the words in the thread when they differ */
  pending?: { text: string; from?: string; shown?: string }[];
  /** on a subagent: its fork took its result */
  taken?: number;
  summary?: string;
  error?: string;
  /** Imported from another tool's session. */
  origin?: { source: SourceId; path: string };
  /** the GitHub issue this job was started from */
  issue?: { n: number; url: string; title: string };
  /** Answered on the spot by the router; no agent ran yet. */
  answer?: boolean;
  /** runs on another Mac (Settings › 연결): that Mac's id. Shown here, worked there. */
  host?: string;
  /** Work in its own git worktree (undefined = the app setting). */
  isolate?: boolean;
  /** The task's own worktree, when its folder is a git repo. */
  worktree?: Worktree;
  /** Finished or needs you, and not opened since. */
  unread?: boolean;
  /** Set on a subagent: the fork that started it. */
  parentId?: string;
  /** Steps that must finish first; their results go into this job's first prompt. */
  after?: string[];
  /** The finished job this one carries on: a new job (fresh context) on that job's branch, given its result. */
  follows?: string;
  /** what its last done said, until it is finished or sent on (a restart then finishes it instead of prompting again) */
  saidDone?: string;
  /** the user turned it in a new direction: the job that took over from it */
  handedOn?: string;
  /** the user ended it themselves (marked it done): nothing carries it on by itself */
  endedBy?: "user";
  /** when the user stopped it; cleared when it is resumed */
  parkedAt?: number;
  /** when it last left paused (resumed by hand or with the fork that paused it) */
  resumedAt?: number;
  /** a subagent its fork's pause stopped (the fork's id): it resumes when the fork does */
  pausedBy?: string;
  /** Other spaces the user let this job use (their memory, folder and past jobs). Spaces are separate otherwise. */
  reach?: SpaceId[];
  /** A review subagent: its findings go back to the fork to fix. */
  review?: boolean;
  /** 교차 검토: which of the two review lenses this is, and the id the pair shares (one combined result) */
  /** 교차 검토 (design, code) or 계획 검토 (scope, fit) */
  lens?: "design" | "code" | "scope" | "fit";
  pair?: string;
  /** what a review lens reported about the memory it was given (applied when the pair is done) */
  memoryCheck?: MemoryCheck[];
  /** Finished, but some of it was never proven (or no proof at all). */
  unverified?: string[];
  /** The project (folder) it belongs to, if any. */
  project?: string;
  /** memory lines given when it started, reused on every later session (stable prefix) */
  memorySnapshot?: string[];
  /** "provider/id"; empty = the account's model. */
  model?: string;
  /** Reasoning effort: low | medium | high | xhigh | max. */
  thinking?: string;
  /** What it may do without asking: ask | edits | full. */
  permission?: Permission;
  /** kept at the top of the list */
  pinned?: boolean;
  /** put away: out of the list, still searchable */
  archived?: boolean;
  /** A subagent's answer for its fork. */
  result?: string;
}

export interface Worktree {
  /** Top of the original repo. */
  repo: string;
  /** The worktree folder (the task's cwd is inside it). */
  path: string;
  branch: string;
  /** Commit it started from. */
  base: string;
  /** Folder relative to the repo top the task was asked in. */
  sub: string;
  state: "open" | "merged" | "discarded";
  /** Branch it was merged into. */
  into?: string;
  /** the folder stayed: another job was still working in it (one that had handed this branch on and
   *  was picked up again); it goes once that job is done */
  left?: boolean;
}

/** Visual answer blocks the agents send instead of paragraphs. */
export type Block = BlockBody & {
  /** the one-line takeaway the agent writes under its picture */
  say?: string;
};
type BlockBody =
  | { type: "progress"; label: string; value: number; total: number }
  | { type: "timeline"; label?: string; items: { label: string; at?: string; state: "done" | "now" | "todo" }[] }
  | { type: "compare"; label: string; before: number; after: number; unit?: string; better: "up" | "down" }
  | { type: "checklist"; label?: string; items: { label: string; done: boolean }[] }
  | { type: "beforeAfter"; label: string; before: string; after: string; beforeImage?: string; afterImage?: string }
  | { type: "shot"; path: string; caption: string }
  | { type: "files"; files: { path: string; add: number; del: number }[] }
  | { type: "metric"; label: string; value: string; delta?: string; trend?: number[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "link"; kind: "pr" | "doc" | "video" | "file" | "url"; title: string; ref: string }
  /** an HTML page (report, chart, mock) shown right in the chat */
  | { type: "page"; path: string; label?: string; height?: number }
  | { type: "text"; text: string }
  | { type: "diagram"; label?: string; nodes: DiagramNode[]; edges?: { from: string; to: string; label?: string }[] }
  /** flowchart: start/end, steps, decisions with yes/no */
  | { type: "flow"; label?: string; dir?: "TB" | "LR"; nodes: import("../ui/Charts").FlowNode[]; edges?: { from: string; to: string; label?: string; em?: boolean }[] }
  /** dependency / call graph between modules */
  | { type: "deps"; label?: string; dir?: "TB" | "LR"; nodes: import("../ui/Charts").DepNode[]; edges?: { from: string; to: string; label?: string; kind?: "call" | "import" | "data"; em?: boolean }[] }
  /** UML class diagram */
  | { type: "classes"; label?: string; dir?: "TB" | "LR"; classes: import("../ui/Charts").UmlClass[]; relations?: import("../ui/Charts").UmlRel[] }
  /** ER diagram */
  | { type: "er"; label?: string; dir?: "TB" | "LR"; tables: import("../ui/Charts").ErTable[]; relations?: { from: string; to: string; card?: "1-1" | "1-n" | "n-1" | "n-n"; label?: string; em?: boolean }[] }
  /** architecture topology */
  | { type: "arch"; label?: string; dir?: "TB" | "LR"; zones?: { id: string; label: string }[]; nodes: import("../ui/Charts").ArchNode[]; edges?: { from: string; to: string; label?: string; async?: boolean; em?: boolean }[] }
  /** state machine: status lifecycle, reducer, connection states */
  | { type: "states"; label?: string; dir?: "TB" | "LR"; initial?: string; states: import("../ui/Charts").StateNode[]; transitions?: import("../ui/Charts").StateEdge[] }
  /** the hunks of a change that matter */
  | { type: "diff"; label?: string; path: string; ref?: string; note?: string; hunks: import("../ui/Work").Hunk[] }
  /** test run: suites pass/fail, failures with where they broke */
  | { type: "tests"; label?: string; suites: { name: string; pass: number; fail?: number; skip?: number; ms?: number }[]; failures?: { name: string; ref?: string; msg?: string }[] }
  /** approaches weighed, the chosen one marked (ADR) */
  | { type: "options"; label?: string; criteria: string[]; options: { name: string; scores: string[]; chosen?: boolean; note?: string }[]; why?: string }
  /** a request as a waterfall of spans */
  | { type: "trace"; label?: string; unit?: string; spans: { id: string; label: string; start: number; dur: number; parent?: string | null; service?: string; error?: boolean }[] }
  /** branches, commits, merges */
  | { type: "git"; label?: string; commits: { id: string; branch: string; msg: string; parents?: string[]; tag?: string; state?: "new" }[] }
  | { type: "evidence"; items: Evidence[]; unverified?: string[] }
  | { type: "scope"; label?: string; in?: VisItem[]; out?: VisItem[] }
  | { type: "bars"; label?: string; unit?: string; total?: number; items: { label: string; value: number; note?: string; highlight?: boolean }[] }
  | { type: "tree"; label?: string; unit?: string; items: { path: string; note?: string; value?: number; state?: VisItem["state"] }[] }
  | { type: "groups"; label?: string; groups: { label: string; note?: string; items: VisItem[] }[]; links?: { from: string; to: string; label?: string }[] }
  | { type: "sequence"; label?: string; actors: string[]; steps: { from: string; to: string; label: string; note?: string; em?: boolean }[] }
  | { type: "steps"; label?: string; items: VisItem[] }
  /** a chart or figure from the viz families (src/ui/viz) */
  | VizBlock;
export type VizBlock = { type: import("../ui/viz/kinds").VizKind; label?: string; say?: string; [k: string]: unknown };

export interface VisItem {
  label: string;
  note?: string;
  /** "off": there, but not used (dimmed; say why in note) */
  state?: "new" | "changed" | "gone" | "done" | "now" | "todo" | "off";
  ref?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  note?: string;
  /** file:line it points at */
  ref?: string;
  /** "new" = what this job adds or changes */
  state?: "new" | "changed" | "gone";
  /** who decided it: the user asked for it, or the agent chose */
  by?: "user" | "agent";
}

export interface Evidence {
  kind: "test" | "build" | "run" | "shot" | "file" | "link" | string;
  ref: string;
  ok?: boolean;
  note?: string;
  /** what the app found in the session: ran / exists / read (checked), self (the job's word), or why it doesn't hold */
  check?: "ran" | "exists" | "read" | "self" | "no-run" | "failed" | "stale" | "missing" | "unread";
  why?: string;
  /** for a run: the result line from its real output ("Tests 12 passed"), not the job's word */
  out?: string;
}

export interface Decision {
  id: string;
  taskId: string;
  at: number;
  question: string;
  options: { id: string; label: string; primary?: boolean; note?: string }[];
  context: Block[];
  /** From an engine dialog (extension UI request). */
  ui?: { requestId: string; method: "select" | "confirm" | "input" };
  /** "stalled": the task stopped without saying it was done. */
  kind: "ask" | "stalled";
}

export type Route =
  | { kind: "answer"; text: string; blocks: Block[]; taskId?: string }
  | { kind: "append"; taskId: string; message: string }
  | { kind: "stop"; taskId: string }
  | { kind: "ask"; decisionId: string; question?: string }
  | { kind: "new"; taskId: string }
  | { kind: "remember"; memoryId: string };

export interface CaptainMessage {
  id: string;
  at: number;
  space: SpaceId;
  /** set when it belongs to a project's own chat */
  project?: string;
  from: "me" | "captain";
  /** main speaking on its own after this job ended */
  after?: string;
  /** a request main handed down to this project's chat (shown as from main) */
  via?: "main";
  /** on a handed-down request: the project already reported back to main */
  reported?: boolean;
  /** in main's chat: this reply is a project reporting back (project id) */
  up?: string;
  /** written by Ondra itself (a request handed down), not by this chat's engine */
  relay?: boolean;
  text?: string;
  /** Main's short reply line (above the forks it started). */
  reply?: string;
  routes?: Route[];
  pending?: boolean;
  error?: string;
  /** what this answer cost, kept with it */
  usage?: Usage;
  /** while pending: the step main is on ("작업 찾는 중 · 리디자인"), as a noteText() line */
  step?: string;
  /** the steps main took for this reply (job lookups), as noteText() lines */
  steps?: string[];
}

export type MemoryKind = "rule" | "preference" | "fact" | "decision" | "procedure" | "lesson";

/** One small piece: a single rule, fact or decision. */
export interface Memory {
  id: string;
  text: string;
  kind?: MemoryKind;
  /** in every prompt (a small, stable, cached part) instead of recalled when it fits */
  pinned?: boolean;
  /** 1–5, how much it matters when recalling */
  importance?: number;
  /** pieces about the same things */
  links?: string[];
  /** the job it was learned in */
  taskId?: string;
  /** the finished jobs it was learned from (the quiet pass checked a quote from them); older pieces have only taskId */
  sources?: string[];
  updatedAt?: number;
  lastUsed?: number;
  /** no longer true: kept as history, never sent again */
  invalidAt?: number;
  /** the piece that replaced it */
  supersededBy?: string;
  /** why it was retired, when not replaced ("오래 안 써서") */
  why?: string;
  /** related words written by the tidy pass (synonyms, Korean/English, the idea): recall finds it by meaning */
  keys?: string[];
  /** what it is about (tools, services, projects): pieces sharing one meet at a topic hub */
  about?: string[];
  /** the file it was brought in from (another tool's notes), if any */
  from?: string;
  /** global = everywhere; space = one space; project = tasks whose folder is under `project` */
  scope: "global" | "space" | "project";
  /** the space it belongs to: every space and project piece has one (spaces never share pieces) */
  space?: SpaceId;
  project?: string;
  source: "ondra" | SourceId;
  createdAt: number;
  /** Times it was used in a prompt. */
  uses: number;
  /** stable name (the file name): saving the same key again updates this piece */
  key?: string;
  /** file globs (relative to the project): shown to a job when it touches a matching file */
  paths?: string[];
  /** who said it: the user's own words are never changed by the quiet pass */
  by?: "user" | "agent";
  /** times the same thing came up again (each one makes it count more) */
  seen?: number;
  /** code files it is about: when they are gone, the piece is retired */
  cites?: string[];
  /** grown into this skill (a procedure used again and again) */
  skill?: string;
  /** last checked against the code and found to hold (교차 검토) */
  verifiedAt?: number;
}

/** One memory piece as a review lens checked it against the code. */
export interface MemoryCheck {
  id: string;
  status: "confirmed" | "contradicted" | "unchecked";
  /** where it was checked: path:line and a quote copied from there, a test or a log line */
  evidence?: string;
  /** contradicted: what holds now, one sentence */
  now?: string;
}

/** 일 기록: what one finished job did, kept as written (searched, never sent whole). */
/** What main reported when a job finished, kept apart from the chat so it can be found again later. */
export interface ResultEntry {
  /** older entries: the main message it came from; newer ones: res-<task>-<finishedAt> */
  id: string;
  taskId: string;
  space: SpaceId;
  project?: string;
  title: string;
  reply?: string;
  answers: { text: string; blocks: Block[] }[];
  at: number;
  /** the chat message where main said something about it (a newer entry; else the job's row shows it) */
  msg?: string;
  /** kept on top of the list */
  pinned?: boolean;
}

export interface JournalEntry {
  id: string;
  taskId: string;
  at: number;
  space: SpaceId;
  project?: string;
  title: string;
  ask: string;
  outcome: "done" | "failed" | "stopped";
  text: string;
  /** pieces the quiet pass learned from it */
  learned?: string[];
}

/**
 * 확인 필요: what the quiet pass learned contradicts one of the user's own pieces.
 * Nothing changes until the user picks: keep theirs, or use the new one.
 */
export interface MemoryConflict {
  id: string;
  at: number;
  space: SpaceId;
  /** the user's own piece */
  mine: string;
  /** a piece already kept that contradicts it (held out until the user picks) */
  theirs?: string;
  /** or a new piece the pass would have saved (not saved) */
  text?: string;
  kind?: MemoryKind;
  scope?: "space" | "project";
  project?: string;
  sources?: string[];
  /** what the user picked; kept a while so the same thing isn't asked again */
  done?: "mine" | "new";
}

/** 지금: what was last going on in one project (resume aid, kept short). */
export interface ProjectNow {
  text: string;
  at: number;
  taskId: string;
  title: string;
}

export interface Skill {
  name: string;
  path: string;
  description: string;
  source: SourceId | "ondra";
  enabled: boolean;
  /** In the + menu and as a /command. Off = jobs still get it and use it when it fits. */
  menu?: boolean;
  /** Grown from one space's memory or imported into one space: only that space's jobs get it. None = every space. */
  space?: SpaceId;
}

export interface Settings {
  slots: { light: number; heavy: number };
  /** "provider/id" for the captain; empty = the account's model */
  captainModel: string;
  theme: "system" | "dark" | "light";
  /** how big the app is drawn (1 = 100%) */
  zoom?: number;
  /** UI language; "system" follows the Mac */
  language?: "system" | "ko" | "en";
  /** Instructions imported from other tools (CLAUDE.md, AGENTS.md …) + the user's own. */
  instructions: string;
  /** Captain may save memories on its own when it notices repeats. */
  learn: boolean;
  /** Give each task in a git repo its own worktree. */
  isolate: boolean;
  /** Send apps a job starts back behind the user's window when they come forward. */
  focusGuard: boolean;
  /** Model / effort for new forks ("" = automatic). */
  forkModel: string;
  forkThinking: string;
  /** Permission for new jobs. */
  permission: Permission;
  /** where links open: the app's own browser (missing = inside) or the system's default one */
  links?: "inside" | "outside";
  /** other Macs may use this one (Settings › 연결): the ones the user allowed get in */
  remote?: boolean;
  /** other Macs this one works on, and the projects of theirs added here */
  hosts?: { id: string; name: string; pair?: string }[];
  hostProjects?: { host: string; id: string; space: SpaceId; name?: string; folder?: string }[];
  /** a job's open PR gets new reviews, failed checks or a conflict: the job carries on */
  watchPullRequests?: boolean;
  /** jobs may change things on GitHub (comments, merges, releases); off = read only */
  githubWrite?: boolean;
  /** tools a job gets on top of the default ones (Settings › 도구), by name; empty = the defaults only */
  extraTools?: string[];
  /** anonymous usage numbers go to Ondra's maintainers (lib/telemetry.ts, docs/TELEMETRY.md); missing = on */
  telemetry?: boolean;
  /** Settings › 단축키: shortcut id → "cmd+shift+KeyD" or "none" (unbound); a missing id keeps its default */
  keybindings?: Record<string, string>;
}

export interface AppState {
  version: 3;
  onboarded: boolean;
  space: SpaceId;
  spaces: Space[];
  accounts: Account[];
  tasks: Task[];
  decisions: Decision[];
  captain: CaptainMessage[];
  memory: Memory[];
  skills: Skill[];
  settings: Settings;
  /** projects: a folder in a space with its own chat */
  projects?: Project[];
  /** folders whose project the user deleted: never made into a project again on their own */
  goneProjects?: string[];
  /** canvas: where the user moved nodes to */
  canvas?: Record<string, { x: number; y: number }>;
  /** next things to ask, written by the model from the real work, per chat */
  suggest?: Record<string, { at: number; items: { text: string; why: string }[] }>;
  /** the quiet memory pass: when it last ran, what it did, jobs already learned from */
  /** note files of other tools already brought into memory: path → hash of what was read */
  absorbed?: Record<string, string>;
  /** per space: the account new work uses ("auto" or missing = route automatically) */
  accountPick?: Record<string, string>;
  memoryTidy?: { at: number; merged: number; retired: number; learned: number; keyed: number; tasks: string[]; cursor?: number; skills?: number; /** conflicts with the user's own pieces it asked about */ held?: number };
  /** 확인 필요: learned pieces that contradict the user's own, waiting for the user */
  memoryConflicts?: MemoryConflict[];
  /** 일 기록, newest last (capped) */
  journal?: JournalEntry[];
  /** 지금, by project folder */
  memoryNow?: Record<string, ProjectNow>;
  /** btw questions asked so far (newest last) */
  btws?: BtwEntry[];
  /** what was typed into any input and sent, commands too (newest last), per space; ↑ brings it back */
  sent?: Record<string, string[]>;
  /** side chat: a separate conversation per space, kept as text */
  side?: SideMessage[];
  /** pull requests jobs opened, watched for reviews, failed checks and conflicts (by PR url) */
  prWatch?: Record<string, PrWatch>;
  /** finished jobs' results (as the jobs reported them; older ones as main did), newest last (capped) */
  results?: ResultEntry[];
}

export interface PrWatch {
  url: string;
  /** the job that carries it now (a follow-on job takes it over) */
  task: string;
  /** only what came after this counts */
  since: number;
  /** comment and review ids already handed to a job */
  seen: string[];
  /** "check@head" already reported failing */
  failed: string[];
  conflict: boolean;
  /** when it woke a job (the last day's count is capped) */
  wakes: number[];
  /** last time anything happened on it */
  last: number;
  done?: boolean;
}

export interface BtwEntry {
  id: string;
  at: number;
  /** "main:<chat>" or "task:<id>": where it was asked */
  scope: string;
  question: string;
  /** pictures and files attached to the question */
  files?: string[];
  answer: string;
  pending: boolean;
  error?: string;
}

export interface Project {
  id: string;
  space: SpaceId;
  name: string;
  folder: string;
  /** on another Mac (Settings › 연결): its id there and the name it goes by */
  host?: string;
  hostName?: string;
}

export interface SideMessage {
  id: string;
  space: SpaceId;
  at: number;
  from: "me" | "side";
  text: string;
  pending?: boolean;
  error?: string;
}
