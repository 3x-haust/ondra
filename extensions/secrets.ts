// Secrets the model can use but not read.
//
// Ondra puts the secrets saved in Settings › 시크릿 into this engine's environment (names in
// ONDRA_SECRET_NAMES, values in the variables themselves; src-tauri/src/secrets.rs). Here:
// - the model is told which names exist and to use them as $NAME in commands;
// - every tool result has each value (and its base64, URL-encoded and hex forms) replaced by
//   [secret:NAME] before the model sees it;
// - values in the job folder's .env files whose key looks secret are hidden the same way, so
//   `cat .env` or reading it shows the keys but not the values;
// - each command that uses a secret, and each result something was hidden from, is logged to
//   <data dir>/secrets-audit.jsonl (names and the job, never values).
// This keeps values out of the model's context and the job's history; a command written to
// leak a value on purpose in some other encoding is not something text matching can stop.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Shorter values are too likely to be ordinary text ("dev", "8080") to hide everywhere. */
const MIN_LEN = 6;
const SECRET_KEY = /(KEY|SECRET|TOKEN|PASSW|PWD|PRIVATE|AUTH|CREDENTIAL|SESSION|COOKIE|DSN|SIGNING|WEBHOOK)/i;

export type Secret = { name: string; value: string };

/** The forms a value is likely to show up in besides itself. */
export function variants(value: string): string[] {
  if (value.length < MIN_LEN) return [];
  const b = Buffer.from(value, "utf8");
  const out = new Set([value, b.toString("base64"), b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(value), b.toString("hex")]);
  return [...out].filter((v) => v.length >= MIN_LEN);
}

/** Replaces every known secret in `text`; the longest first, so a value inside another goes with it. */
export function redact(text: string, secrets: Secret[]): { text: string; hits: string[] } {
  const pairs = secrets.flatMap((s) => variants(s.value).map((v) => ({ v, name: s.name }))).sort((a, b) => b.v.length - a.v.length);
  const hits = new Set<string>();
  let out = text;
  for (const { v, name } of pairs) {
    if (!out.includes(v)) continue;
    out = out.split(v).join(`[secret:${name}]`);
    hits.add(name);
  }
  return { text: out, hits: [...hits] };
}

/** KEY=value pairs of a .env file whose key looks like it holds a secret. */
export function dotenvSecrets(text: string, file: string): Secret[] {
  const out: Secret[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (value.length < MIN_LEN || !SECRET_KEY.test(m[1])) continue;
    out.push({ name: `${file}:${m[1]}`, value });
  }
  return out;
}

/** The secrets from Ondra: the names it says it set, with their values from this environment. */
export function envSecrets(env: NodeJS.ProcessEnv): Secret[] {
  const names = (env.ONDRA_SECRET_NAMES ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  return names.flatMap((name) => {
    const value = env[name];
    return value && value.length >= MIN_LEN ? [{ name, value }] : [];
  });
}

/** Values Ondra passed only to be hidden (a deeper folder's key of a name already set): "VAR=label" pairs. */
export function maskSecrets(env: NodeJS.ProcessEnv): Secret[] {
  return (env.ONDRA_SECRET_MASKS ?? "").split(",").flatMap((pair) => {
    const [variable, label] = pair.split("=");
    const value = variable ? env[variable.trim()] : undefined;
    return value && label && value.length >= MIN_LEN ? [{ name: label.trim(), value }] : [];
  });
}

/** Which of the names a shell command refers to ($NAME, ${NAME}, ${NAME:-…}). */
export function namesUsed(command: string, names: string[]): string[] {
  return names.filter((n) => new RegExp(`\\$\\{?${n}(?![A-Za-z0-9_])`).test(command));
}

/** What the model is told: the names, how to use them, and that values stay hidden. */
export function promptNote(names: string[]): string {
  return [
    "## Secrets",
    `These secrets are set as environment variables in your shell: ${names.map((n) => `\`${n}\``).join(", ")}.`,
    "Use them by name in commands (`$NAME`, or `process.env.NAME` in code you run); never ask the user for their values and never write a value into a file, a commit or a message.",
    "Any value that shows up in a tool result is replaced by [secret:NAME]: that is expected, not an error, and the real value was still used.",
  ].join("\n");
}

const ENV_FILE = /^\.env(\..+)?$/;
const EXAMPLE = /(example|sample|template|dist|defaults)$/i;
/** Folders not worth looking into for .env files (the same list as src-tauri/src/secrets.rs). */
const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__", "Pods", "DerivedData", "coverage", "bower_components", "jspm_packages", "site-packages"]);
const MAX_DEPTH = 6;
const MAX_DIRS = 4000;

/** Every .env file in `root` and the folders under it, as paths from `root`. */
export function envFilesUnder(root: string): string[] {
  const out: string[] = [];
  const queue: [string, number][] = [["", 0]];
  let seen = 0;
  while (queue.length) {
    const [rel, depth] = queue.pop()!;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && ENV_FILE.test(e.name) && !EXAMPLE.test(e.name)) out.push(path);
      else if (e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name) && depth + 1 < MAX_DEPTH && seen < MAX_DIRS) {
        seen++;
        queue.push([path, depth + 1]);
      }
    }
  }
  return out.sort();
}

export default function (pi: ExtensionAPI) {
  const named = envSecrets(process.env);
  const names = named.map((s) => s.name);
  const own = [...named, ...maskSecrets(process.env)];
  const audit = (process.env.ONDRA_DATA_DIR ?? "").replace(/\/$/, "");
  const job = process.env.ONDRA_TASK_ID ?? process.env.ONDRA_JOB_ID ?? "";

  // .env files anywhere in the job's folder: found again at most every 15 s, read again when one changes
  let cache = { key: "", secrets: [] as Secret[] };
  let walked = { cwd: "", at: 0, files: [] as string[] };
  const folderSecrets = (cwd: string): Secret[] => {
    if (walked.cwd !== cwd || Date.now() - walked.at > 15_000) walked = { cwd, at: Date.now(), files: envFilesUnder(cwd) };
    const files = walked.files;
    const stamps = files.map((f) => {
      try {
        return `${f}@${statSync(join(cwd, f)).mtimeMs}`;
      } catch {
        return f;
      }
    });
    const key = `${cwd}|${stamps.join(",")}`;
    if (key === cache.key) return cache.secrets;
    const secrets = files.flatMap((f) => {
      try {
        return dotenvSecrets(readFileSync(join(cwd, f), "utf8"), f);
      } catch {
        return [];
      }
    });
    cache = { key, secrets };
    return secrets;
  };

  const log = (entry: Record<string, unknown>) => {
    if (!audit) return;
    try {
      if (!existsSync(audit)) mkdirSync(audit, { recursive: true });
      appendFileSync(join(audit, "secrets-audit.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), job, ...entry })}\n`);
    } catch {
      /* the log is a record, not a gate */
    }
  };

  if (names.length)
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${promptNote(names)}` }));

  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || !names.length) return;
    const used = namesUsed(String((event.input as { command?: unknown })?.command ?? ""), names);
    if (used.length) log({ kind: "used", tool: "bash", names: used });
  });

  pi.on("tool_result", (event, ctx) => {
    const secrets = [...own, ...folderSecrets(ctx.cwd)];
    if (!secrets.length || !event.content?.length) return;
    const hits = new Set<string>();
    const content = event.content.map((c) => {
      if (c.type !== "text") return c;
      const r = redact(c.text, secrets);
      r.hits.forEach((h) => hits.add(h));
      return r.hits.length ? { ...c, text: r.text } : c;
    });
    if (!hits.size) return;
    log({ kind: "hidden", tool: event.toolName, names: [...hits] });
    return { content };
  });
}
