// Proof before "done" (after OmO's claim-receipt and gajae-code's quality gate):
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
export function lastCodeEdit(t: Task): number {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (x && (x.kind === "edit" || x.kind === "write") && x.ok !== false && !x.note && isCodeFile((x.detail ?? "").split("\n")[0], t)) return i;
  }
  return -1;
}

function ranCommand(t: Task, ref: string): { at: number; ok: boolean; shellId?: string } | null {
  const want = norm(ref.replace(/^\$\s*/, ""));
  if (want.length < 2) return null;
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const x = toolAt(t.entries[i]);
    if (!x || (x.kind !== "bash" && x.kind !== "test")) continue;
    const cmd = norm(x.detail ?? x.target ?? "");
    if (cmd.includes(want) || (cmd.length > 4 && want.includes(cmd))) return { at: i, ok: x.ok !== false, shellId: x.shellId };
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
      if (e.kind === "test" || e.kind === "build" || e.kind === "run") {
        const r = ranCommand(t, e.ref);
        if (!r) return { ...e, ok: false, check: "no-run", why: "돌린 기록이 없어요" };
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
