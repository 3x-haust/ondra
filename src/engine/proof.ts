// Proof before "done" (a claim needs a receipt, and a quality gate checks it):
// the job's evidence is checked against what actually happened in its session,
// not taken on its word.
//   test / build / run → the same command ran here, passed, and no code changed after it
//   file / shot        → the file is really there (a screenshot is not empty, and not
//                        taken before the last code change)
//   link               → the page was really opened here (web_fetch, the browser, curl),
//                        or it is a PR / issue this job made or acted on with gh
import { fsRead } from "../lib/native";
import type { Entry, Evidence, Task } from "../state/types";
import { commandKind } from "./commandKind";
import { engine, expand } from "./rpc";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const toolAt = (e: Entry) => (e.kind === "tool" ? e.tool : undefined);
const trim = (p: string) => p.replace(/\/+$/, "");

/**
 * A file that is the job's code: inside its folder or worktree, not in the
 * artifacts folder (reports, pages, scripts that build them), and not notes or
 * data (.md, .txt, .jsonl, .csv, a .json that isn't config).
 */
export function isCodeFile(path: string, t?: Pick<Task, "cwd" | "worktree">): boolean {
  const p = path.trim();
  if (!p) return false;
  if (/\.(md|txt|jsonl|ndjson|csv|tsv|log)$/i.test(p)) return false;
  const name = p.split("/").pop() ?? "";
  if (/\.json$/i.test(name) && !/^(package|tsconfig[\w.-]*|[\w.-]*config[\w.-]*|app|eas|manifest|deno|turbo|composer|project)\.json$/i.test(name)) return false;
  if (!p.startsWith("/") && !p.startsWith("~")) return true;
  const full = expand(p);
  const data = engine.info?.dataDir ? trim(engine.info.dataDir) : "";
  if (/\$APP_ARTIFACTS_DIR|\/artifacts\//.test(p) && (!data || full.startsWith(`${data}/artifacts/`) || /\$APP_ARTIFACTS_DIR/.test(p))) return false;
  const homes = [t?.worktree?.state === "open" ? t.worktree.path : "", t?.cwd ? expand(t.cwd) : ""].filter(Boolean).map(trim);
  if (homes.length && !homes.some((h) => full === h || full.startsWith(`${h}/`))) return false;
  return true;
}

/** index of the last code edit in the transcript (-1 if none) */
function lastCodeEdit(t: Task): number {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (x && (x.kind === "edit" || x.kind === "write") && x.ok !== false && !x.note && isCodeFile((x.detail ?? "").split("\n")[0], t)) return i;
  }
  return -1;
}

/**
 * The parts of a command that say what it ran, written the same however the job wrote it down:
 * no `cd …`, no output plumbing (`2>&1 | tail -6`), quotes dropped, and a path by its last part
 * (the job may name `$APP_SCRATCH_DIR/repro/run.sh` in its evidence and have run
 * `/var/folders/…/repro/run.sh`, or the other way round).
 */
export function commandCore(cmd: string): string[] {
  return norm(cmd.replace(/^\$\s+/, ""))
    .replace(/["']/g, "")
    .replace(/\s*\d?>&\d|\s*\d?>\s*\/dev\/null/g, "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && !/^(cd|tail|head|grep|rg|cat|tee|wc|sed|awk|sort|less|true|echo)\b/.test(seg))
    .map((seg) =>
      seg
        .split(/\s+/)
        .map((w) => (w.includes("/") ? (w.replace(/\/+$/, "").split("/").pop() ?? w) : /^\$\{?\w+\}?$/.test(w) ? "$" : w))
        .join(" "),
    );
}

function ranCommand(t: Task, ref: string): { at: number; ok: boolean; shellId?: string; running?: boolean } | null {
  const want = norm(ref.replace(/^\$\s*/, ""));
  if (want.length < 2) return null;
  const core = commandCore(ref);
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (!x || (x.kind !== "bash" && x.kind !== "test")) continue;
    const raw = x.detail ?? x.target ?? "";
    const cmd = norm(raw);
    // started in the background: it counts once it ended, by its exit code
    const sh = x.shellId ? t.shells.find((s) => s.id === x.shellId) : undefined;
    const hit = { at: i, ok: x.ok !== false && sh?.ok !== false && !(sh?.runInBackground && sh.stopped), shellId: x.shellId, running: !!sh?.runInBackground && !sh.endedAt };
    if (cmd.includes(want) || (cmd.length > 4 && want.includes(cmd))) return hit;
    // the same command written another way (another folder variable, its output piped elsewhere)
    const ran = commandCore(raw);
    if (core.length && core.join(" ").length >= 4 && core.every((c) => ran.includes(c))) return hit;
  }
  return null;
}

const bareUrl = (u: string) => u.trim().replace(/^https?:\/\/(www\.)?/i, "").replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

/** a source counts only if this session opened it */
function openedUrl(t: Task, ref: string): boolean {
  const want = bareUrl(ref);
  if (want.length < 4) return false;
  return t.entries.some((e) => {
    const x = toolAt(e);
    if (!x || x.ok === false) return false;
    const seen = `${x.target ?? ""}\n${x.detail ?? ""}`.toLowerCase().replace(/https?:\/\/(www\.)?/g, "");
    return seen.includes(want);
  });
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A GitHub page this job made or looked at with gh: a PR or issue it created,
 * merged, viewed or commented on; a release it created or viewed; a CI run it viewed.
 */
export function ghTouched(t: Pick<Task, "entries">, ref: string): boolean {
  const cmds = t.entries.flatMap((e) => {
    const x = toolAt(e);
    return x && x.ok !== false && x.kind === "bash" ? [`${x.target ?? ""}\n${x.detail ?? ""}`] : [];
  });
  const pr = ref.match(/github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)/i);
  if (pr) {
    const num = new RegExp(`(\\s|#|/)${pr[1]}(\\b|$)`);
    return cmds.some((cmd) => /\bgh\s+(pr|issue)\s+create\b/.test(cmd) || (/\bgh\s+(pr|issue|api)\b/.test(cmd) && num.test(cmd)));
  }
  const tag = ref.match(/github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^/?#\s]+)/i);
  if (tag) {
    const re = new RegExp(`\\bgh\\s+release\\s+(create|view|edit|upload)\\s+['"]?${esc(decodeURIComponent(tag[1]))}(['"\\s]|$)`);
    return cmds.some((cmd) => re.test(cmd));
  }
  const run = ref.match(/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)/i);
  if (run) {
    const re = new RegExp(`\\bgh\\s+(run\\s+(view|watch|rerun)\\s+${run[1]}\\b|api\\s+\\S*/runs/${run[1]}\\b)`);
    return cmds.some((cmd) => re.test(cmd));
  }
  return false;
}

/** a screenshot of a page out on the web (a store console, a GitHub page), not of what this code renders */
function externalShot(t: Task, e: Evidence): boolean {
  const external = (s: string) => [...s.matchAll(/https?:\/\/([^/\s'"]+)/g)].some((m) => !/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(m[1]));
  if (external(`${e.ref} ${e.note ?? ""}`)) return true;
  const name = e.ref.split("/").pop() ?? "";
  if (name.length < 3) return false;
  let at = -1;
  for (let i = t.entries.length - 1; i >= 0 && at < 0; i--) {
    const y = toolAt(t.entries[i]);
    if (y && `${y.target ?? ""}\n${y.detail ?? ""}`.includes(name)) at = i;
  }
  if (at < 0) return false;
  // the page open when it was taken: what the last few calls before it pointed at
  const near = t.entries.slice(Math.max(0, at - 6), at + 1).map((x) => { const y = toolAt(x); return y ? `${y.target ?? ""}\n${y.detail ?? ""}` : ""; }).join("\n");
  return external(near) && !/https?:\/\/(localhost|127\.|0\.0\.0\.0)/.test(near);
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const RESULT = /\b\d+\s+(passed|passing|failed|failing|tests?|specs?|errors?|warnings?)\b|\b(Tests?|Test Files|Suites?)\b.*\d|\b(built|compiled|bundled|finished|done)\b.*\b(in|s\b|ms\b)|\bexit(ed)?( with)?( code)? \d+|^(ok|PASS|FAIL)\b|[✓✔✗✘]\s*\d/i;

/** words that mark a line as one that may carry a credential: such a line is never shown as proof */
export const SECRET_WORDS = /(token|secret|password|cookie|api[_-]?key)/i;

/** The line of a command's real output that says how it went ("Tests 12 passed (12)"). */
export function resultLine(tail: string): string | undefined {
  const lines = tail.replace(ANSI, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const hit = [...lines].reverse().find((l) => RESULT.test(l) && !SECRET_WORDS.test(l));
  const line = hit ?? lines[lines.length - 1];
  return SECRET_WORDS.test(line) ? undefined : line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

// "I checked it in the browser" and the like: a claim that needs a screen behind it
const SAW = /(브라우저|화면|직접|실제로|눌러|클릭).{0,24}(확인했|확인함|봤어|봤고|봤습|눌러\s?봤|열어\s?봤)|(checked|verified|tested|confirmed|clicked through)[^.\n]{0,30}\b(in the browser|on screen|by hand|manually|in the app)/i;
const NOT = /(않|안\s|안했|못|없|아니|not|never|didn't|without)/i;

/** sentences of the answer that say the job looked at the screen itself */
export function sawClaims(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => SAW.test(x) && !NOT.test(x));
}

/**
 * The answer says it looked at the screen, but nothing in the session backs it:
 * no fresh screenshot and no browser or desktop step after the last code change,
 * or its own unverified list says it didn't.
 */
export function unbackedClaim(t: Task, text: string, checked: Evidence[], unverified: string[]): { claim: string; why: string } | null {
  const claim = sawClaims(text)[0];
  if (!claim) return null;
  const denied = unverified.find((u) => /(브라우저|화면|직접|screen|browser|by hand)/i.test(u) && NOT.test(u));
  if (denied) return { claim, why: `unverified에는 "${denied}"라고 적었어요` };
  const shot = checked.some((e) => e.kind === "shot" && !e.why);
  // "opened the two URLs and checked": a page read here backs it, unless it says it looked at a screen
  if (!/(브라우저|화면|눌러|클릭|screen|browser|click)/i.test(claim) && checked.some((e) => e.check === "read")) return null;
  const edited = lastCodeEdit(t);
  const looked = t.entries.some((e, i) => i > edited && e.kind === "tool" && (e.tool.kind === "browser" || e.tool.kind === "desktop") && e.tool.ok !== false);
  return shot || looked ? null : { claim, why: "화면을 본 기록(브라우저 조작이나 스크린샷)이 없어요" };
}

/** Each item gets `check`; anything not backed by the session gets ok:false and a reason. */
export async function checkEvidence(t: Task, items: Evidence[]): Promise<Evidence[]> {
  const edited = lastCodeEdit(t);
  return Promise.all(
    items.map(async (e): Promise<Evidence> => {
      if (e.kind === "test" || e.kind === "build" || e.kind === "run" || e.kind === "repro") {
        const r = ranCommand(t, e.ref);
        if (!r) return { ...e, ok: false, check: "no-run", why: "돌린 기록이 없어요" };
        if (r.running) return { ...e, ok: false, check: "no-run", why: "백그라운드에서 아직 끝나지 않았어요" };
        if (!r.ok) return { ...e, ok: false, check: "failed", why: "마지막 실행이 실패했어요" };
        // a status look (a CI run, a store review, a URL) says nothing about the code: it doesn't go stale
        if (edited > r.at && commandKind(e.ref) !== "poll") return { ...e, ok: false, check: "stale", why: "돌린 뒤에 코드가 바뀌었어요" };
        const sh = r.shellId ? t.shells.find((x) => x.id === r.shellId) : undefined;
        const out = sh?.tail ? resultLine(sh.tail) : undefined;
        return { ...e, ok: true, check: "ran", ...(out ? { out } : {}) };
      }
      if (e.kind === "file" || e.kind === "shot" || /^[/~]/.test(e.ref)) {
        const path = expand(e.ref.replace(/:\d+(:\d+)?$/, ""));
        const f = await fsRead(path).catch(() => null);
        const err = (f as { error?: string } | null)?.error;
        if (!f || err) return { ...e, ok: false, check: "missing", why: "파일이 없어요" };
        if (e.kind === "shot" && f.size < 4096) return { ...e, ok: false, check: "missing", why: "빈 스크린샷 같아요" };
        // a result shot from before the last code change shows the old code
        const changedAt = edited >= 0 ? (t.entries[edited]?.at ?? 0) : 0;
        if (e.kind === "shot" && f.modified && f.modified < changedAt && !/before|전/i.test(`${e.ref} ${e.note ?? ""}`) && !externalShot(t, e))
          return { ...e, ok: false, check: "stale", why: "코드를 바꾸기 전에 찍은 사진이에요" };
        return { ...e, check: "exists" };
      }
      if (e.kind === "link" && /^https?:\/\//i.test(e.ref)) {
        return openedUrl(t, e.ref) || ghTouched(t, e.ref) ? { ...e, ok: true, check: "read" } : { ...e, ok: false, check: "unread", why: "열어 본 기록이 없어요" };
      }
      return { ...e, check: "self" };
    }),
  );
}

/** A review (either lens of a 교차 검토) that reported P1/P2 problems and nothing was fixed after it finished. */
export function reviewUnresolved(t: Task, kids: Task[]): boolean {
  const reviews = kids.filter((k) => k.review && k.status === "done").sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const last = reviews[reviews.length - 1];
  if (!last) return false;
  // 교차 검토: either lens of the pair can report one
  const group = last.pair ? reviews.filter((k) => k.pair === last.pair) : [last];
  if (!group.some((k) => reviewFound(`${k.summary ?? ""}\n${k.result ?? ""}`))) return false;
  const editAt = lastCodeEdit(t);
  return editAt < 0 || (t.entries[editAt]?.at ?? 0) < (last.finishedAt ?? 0);
}

/**
 * A review's text reports a P1 or P2: some mention of either that isn't "none"
 * ("P1 없음, P2 2건" reports one; "P1·P2 없음" and "no P1, no P2" don't).
 */
export function reviewFound(text: string): boolean {
  for (const m of text.matchAll(/\bP([12])(?!\d)/g)) {
    const at = m.index ?? 0;
    const after = text.slice(at + 2, at + 2 + 16).split(/[,\n;.]/)[0];
    const before = text.slice(Math.max(0, at - 4), at);
    if (/(없|0\s*(개|건)|none|\bno\b|nothing)/i.test(after) || /\bno\s+$/i.test(before)) continue;
    return true;
  }
  return false;
}

/** A "done" whose last sentence promises work for later ("…배포할게요") is not done. */
export function promisesLater(summary: string): boolean {
  const last = summary.trim().split(/(?<=[.!?。])\s+/).pop() ?? "";
  return /(할게요|할께요|하겠(습니다|어요)|할\s*예정|예정이에요|예정입니다|드릴게요|볼게요|올릴게요|낼게요)\s*[.!。]?$/.test(last.trim());
}

/**
 * A change worth a review: it touches security, money or data that can be lost.
 * Size alone isn't risk, and "session" (Ondra's agent sessions) isn't auth.
 */
export function riskyChange(paths: Iterable<string>): boolean {
  return [...paths].some((p) => /auth|login|token|secret|password|payment|billing|checkout|migrat|schema|\.sql$|security|permission|crypto|delete|remove/i.test(p));
}

// ───────────── labelled claims (확인함 / 추론 / 추측)
// A cause or a number said with its footing: measured here, inferred from reading, or a
// guess. "(확인함)" needs something in the session that looked; a cause left as a guess
// can't be called fixed, so it goes to unverified (and a fix with it doesn't merge alone).

const LABEL = /[(（]\s*(확인함|측정함|추론|추측|verified|measured|inferred|guess)\s*[)）]/i;
const CHECKED = /[(（]\s*(확인함|측정함|verified|measured)\s*[)）]/i;
const GUESSED = /[(（]\s*(추측|guess)\s*[)）]/i;

/** the **원인** part of a report (up to the next bold label or a blank line), if it has one */
function causeOf(text: string): string | undefined {
  const m = text.replace(/```[\s\S]*?```/g, "").match(/\*\*\s*(원인|cause|root cause)\s*\*\*\s*[:：]?\s*([\s\S]*?)(?=\n\s*\*\*[^*\n]+\*\*|\n\s*\n|$)/i);
  const body = m?.[2]?.trim();
  return body || undefined;
}

/** what the report says about its cause: none, said without a footing, a guess, or labelled */
export function causeFooting(text: string): "none" | "bare" | "guess" | "labelled" {
  const c = causeOf(text);
  if (!c) return "none";
  if (!LABEL.test(c)) return "bare";
  return GUESSED.test(c) && !CHECKED.test(c) ? "guess" : "labelled";
}

/** sentences marked as checked here ("…로그로 확인했어요 (확인함)") */
export function checkedClaims(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .split(/(?<=[.!?。)）])\s+|\n+/)
    .map((x) => x.trim())
    .filter((x) => CHECKED.test(x));
}

/** "(확인함)" with nothing in the session that ran or looked: no command, test, browser or app step that worked */
export function unbackedChecked(t: Pick<Task, "entries">, text: string): string | null {
  const claim = checkedClaims(text)[0];
  if (!claim) return null;
  const looked = t.entries.some((e) => e.kind === "tool" && (e.tool.kind === "bash" || e.tool.kind === "test" || e.tool.kind === "browser" || e.tool.kind === "desktop") && e.tool.ok !== false);
  return looked ? null : claim;
}

// ───────────── what the job couldn't check, and why
// "unverified" is for what this job could not do here: the user's hand, a tool that doesn't
// reach it, something leaving the machine it wasn't allowed, the user saying to skip it, or a
// check failing twice for a reason outside the change. Anything else it could still do
// ("PR 본문에 스크린샷 첨부 안 함") is work left undone: it is sent back to do it or say what blocked it.

export interface Unchecked {
  what: string;
  why?: string;
}

const WEAK_WHY = /^(시간|시간 부족|생략|생략함|나중에|범위 밖|필요 없음|n\/?a|later|time|skipped?|out of scope|not needed)[.!]?$/i;

/** the done block's unverified list: "what", "what — why", or {"what","why"} */
export function readUnverified(raw: unknown): Unchecked[] {
  if (!Array.isArray(raw)) return [];
  const out: Unchecked[] = [];
  for (const u of raw) {
    if (u && typeof u === "object") {
      const o = u as Record<string, unknown>;
      const what = String(o.what ?? o.item ?? o.text ?? "").trim();
      const why = String(o.why ?? o.reason ?? "").trim();
      if (what) out.push({ what, ...(why ? { why } : {}) });
      continue;
    }
    const s = String(u ?? "").trim();
    if (!s) continue;
    const m = s.match(/^(.+?)\s+(?:—|–|-{1,2}|·)\s+(?:이유[:：]\s*|why[:：]\s*|because\s+)?(.+)$/i);
    out.push(m ? { what: m[1].trim(), why: m[2].trim() } : { what: s });
  }
  const seen = new Set<string>();
  return out.filter((u) => !seen.has(u.what) && !!seen.add(u.what));
}

export const uncheckedLine = (u: Unchecked) => (u.why ? `${u.what} — ${u.why}` : u.what);

/** items that give no real reason they couldn't be done here */
export const unreasoned = (list: Unchecked[]) => list.filter((u) => !u.why || WEAK_WHY.test(u.why.trim()));

// ───────────── a bug's reproduction, before and after
// For a bug (a fix/ branch), the same reproduction runs before the first code change and
// passes after the last one: "the failing repro lands before the fix" in the transcript.

/** index of the first code edit in the transcript (-1 if none) */
function firstCodeEdit(t: Task): number {
  return t.entries.findIndex((e) => {
    const x = toolAt(e);
    return !!x && (x.kind === "edit" || x.kind === "write") && x.ok !== false && !x.note && isCodeFile((x.detail ?? "").split("\n")[0], t);
  });
}

/** what the repro evidence lacks: a run before the first code change, a passing run after the last; null when it holds */
export function reproGap(t: Task, ref: string): "before" | "after" | null {
  const want = norm(ref.replace(/^\$\s*/, ""));
  const first = firstCodeEdit(t);
  const last = lastCodeEdit(t);
  if (want.length < 2 || first < 0) return null;
  const runs = t.entries
    .map((e, i) => ({ x: toolAt(e), i }))
    .filter(({ x }) => !!x && (x.kind === "bash" || x.kind === "test" || x.kind === "browser") && (norm(x.detail ?? x.target ?? "").includes(want) || want.includes(norm(x.detail ?? x.target ?? "")) && norm(x.detail ?? x.target ?? "").length > 4));
  if (!runs.some(({ i }) => i < first)) return "before";
  if (!runs.some(({ x, i }) => i > last && x!.ok !== false)) return "after";
  return null;
}

/** a bug-fix job: main named a fix/ branch for it */
export const isBugFix = (t: Pick<Task, "branch" | "worktree">) => /^(fix|hotfix|bugfix)\//i.test(t.worktree?.branch ?? t.branch ?? "");

// ───────────── what a diff shouldn't carry out
// Lines a change adds that a reviewer reads as unfinished: debug output, code left commented
// out, and notes promising to come back (the usual markers, "임시로", "for now, …"). The repo's own comment
// style is left alone; only these are named. Run over Ondra's own repo, the looser first version
// named 96 lines and every one was wrong: "disconnected for now" is a state, `*last = …` in Rust
// is a deref, "browse (the …)" is prose, and a CLI script's console.log is what it prints.

// a comment line: `//`, `#` (not a shebang, attribute or preprocessor line), `/*`, or ` * ` inside one
const COMMENT = /^\s*(\/\/|#(?![!\[]|include|define|if|endif|pragma)|\/\*+|\*(?=\s|$))\s?(.*)$/;
// what reads as a statement, not a sentence that happens to hold a parenthesis
const CODE_LIKE = [
  /^(const|let|var)\s+[\w$[\]{}, ]+\s*=/,
  /^let mut\s+\w+/,
  /^(if|for|while|switch)\s*\(.*\)\s*\{?$/,
  /^return\b.*;$/,
  /^(import|export)\s.*(\sfrom\s|=|\{)/,
  /^await\s+[\w$.]+\(/,
  /^(def|fn|function|class|pub fn)\s+\w+\s*[(<{:]/,
  /^[\w$.]+(\?\.)?\([^()]*\);?$/,
  /^[\w$.[\]]+\s*[+\-*/]?=\s*[^=].*;$/,
  /^\}\)?;?$/,
];
const LATER = /\b(TODO|FIXME|HACK|XXX)\b|나중에 (고치|정리|바꾸)|일단 이렇게|\(임시\)|^(for now|temp(orary)? (fix|hack|workaround)|hack:|임시로|임시방편)/;
const LATER_I = /^(for now|temp(orary)? (fix|hack|workaround)|hack:)/i;
const DEBUG = /\bconsole\.(log|debug)\s*\(|^\s*debugger\s*;?\s*$|\bdbg!\s*\(/;
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s|rs|swift|go|kt|kts|java|py|rb|php|c|cc|cpp|h|hpp|m|mm|cs|scala|dart|vue|svelte)$/i;
// a command-line script prints with console.log: that is its output, not debugging
const SCRIPT = /(^|\/)(scripts?|bin|cli|tools?)\/|\.(mjs|cjs)$/;

/** added lines in a unified diff that are debug output, code commented out or "fix later" notes, as "file:line what" */
export function leftovers(patch: string, only?: (path: string) => boolean, max = 12): string[] {
  const found: string[] = [];
  const lines = patch.split("\n");
  // a file that already prints with console.log (in lines the change kept) prints on purpose
  const prints = new Set<string>();
  let file = "";
  for (const raw of lines) {
    if (raw.startsWith("+++ ")) file = raw.slice(4).replace(/^b\//, "").trim();
    else if (raw.startsWith(" ") && /\bconsole\.log\s*\(/.test(raw)) prints.add(file);
  }
  file = "";
  let line = 0;
  for (const raw of lines) {
    if (raw.startsWith("+++ ")) {
      file = raw.slice(4).replace(/^b\//, "").trim();
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file || raw.startsWith("--- ")) continue;
    if (raw.startsWith("-")) continue;
    const added = raw.startsWith("+");
    const text = raw.slice(1);
    if (added && CODE_EXT.test(file) && (!only || only(file))) {
      const c = text.match(COMMENT);
      const said = (c?.[2] ?? "").trim();
      const printing = /\bconsole\.log\s*\(/.test(text) && !/\bconsole\.debug|debugger|dbg!/.test(text) && (SCRIPT.test(file) || prints.has(file));
      const what = DEBUG.test(text) && !c && !printing
        ? "디버그 출력"
        : c && (LATER.test(said) || LATER_I.test(said))
          ? "나중에 고치겠다는 주석"
          : c && CODE_LIKE.some((re) => re.test(said))
            ? "주석으로 남긴 코드"
            : "";
      if (what) found.push(`${file}:${line} ${what}`);
      if (found.length >= max) break;
    }
    line++;
  }
  return found;
}
