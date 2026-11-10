// The app's log (one file a day in the data folder, a week kept): errors, engines ending, jobs
// failing, updates. Read back for a feedback report, so every line is redacted before it is written.
import { inTauri, logAppend } from "./native";

type Level = "info" | "warn" | "error";
const buf: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let lastDay = "";

const pad = (n: number) => String(n).padStart(2, "0");
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Keys, tokens, emails and the home folder's name never reach the file. */
export function redact(s: string): string {
  return s
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "$1-…")
    .replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{12,}/g, "$1…")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 …")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|authorization|cookie)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2…")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, "jwt…")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\/Users\/[^/\s"']+/g, "~");
}

function flush() {
  timer = undefined;
  if (!buf.length) return;
  const lines = buf.splice(0);
  // logging never breaks anything (outside the app, or a test's stand-in for the native side)
  try {
    if (!inTauri) return;
    const now = new Date();
    const day = dayOf(now);
    // the first write of a day also clears out files older than a week
    const keep = day !== lastDay ? dayOf(new Date(now.getTime() - 7 * 86_400_000)) : undefined;
    lastDay = day;
    void logAppend(day, lines, keep).catch(() => {});
  } catch {
    /* nowhere to write */
  }
}

export function log(level: Level, src: string, msg: string) {
  const d = new Date();
  const at = `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  buf.push(`${at} ${level.toUpperCase().padEnd(5)} [${src}] ${redact(msg).replace(/\s*\n\s*/g, " ⏎ ").slice(0, 2000)}`);
  if (buf.length >= 50) flush();
  else timer ??= setTimeout(flush, 2000);
}
export const logInfo = (src: string, msg: string) => log("info", src, msg);
export const logWarn = (src: string, msg: string) => log("warn", src, msg);
export const logError = (src: string, msg: string) => log("error", src, msg);
/** write what waits now (quitting) */
export const flushLog = flush;

const text = (x: unknown) => (x instanceof Error ? `${x.name}: ${x.message}${x.stack ? ` ⏎ ${x.stack.split("\n").slice(1, 4).join(" ⏎ ")}` : ""}` : typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })());

/** Uncaught errors, rejected promises and console errors go to the log as well. */
export function installLog(version: string) {
  logInfo("app", `start ${version}`);
  window.addEventListener("error", (e) => logError("ui", `${e.message} @ ${String(e.filename ?? "").split("/").pop()}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => logError("ui", `unhandled: ${text(e.reason)}`));
  const was = { error: console.error.bind(console), warn: console.warn.bind(console) };
  console.error = (...a: unknown[]) => (logError("console", a.map(text).join(" ")), was.error(...a));
  console.warn = (...a: unknown[]) => (logWarn("console", a.map(text).join(" ")), was.warn(...a));
}
