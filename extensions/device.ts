// `device`: iOS simulators and Android emulators as one tool (agent-device underneath).
// One small schema instead of 60 MCP tools, so it costs little context and the model
// doesn't have to remember flags:
//   start  → a fresh device made for this job (never someone else's), app opened, first snapshot
//   do     → one agent-device command on that device ("press @e12 --settle", "fill @e3 hi")
//   look   → screenshot the model can see (also saved as proof in the job's artifacts)
//   stop   → close, shut down and delete what this job made
// Fast: an iOS device is a clone of a template that has booted once (seconds, not the half
// minute a new simulator's first boot takes); an Android one boots a clean snapshot read-only
// (no copy, no cold boot, nothing kept); several steps go in one call (one model turn, not
// one per tap); a look comes back small (fewer image tokens, a quicker next turn).
// Devices the job didn't make are refused unless they belong to the job's space
// (ONDRA_DEVICES_ALLOWED, set by the app), so the user's own simulators and the
// other space's are never touched. An Android emulator made for a job is a fresh
// copy of an AVD (no app data, no logins), deleted again when the job is done.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

type Platform = "ios" | "android";
/** clone: the AVD made for this job (deleted with it) */
/** baked: host apps already in the template or snapshot it came from (an install of one is skipped) */
type Mine = { platform: Platform; udid?: string; serial?: string; name: string; made: boolean; clone?: string; baked?: string[] };

const WORKER = process.env.APP_WORKER_ID || `job${process.pid}`;
const SESSION = `ondra-${WORKER}`.slice(0, 60);
const ARTIFACTS = process.env.APP_ARTIFACTS_DIR || join(process.env.TMPDIR || "/tmp", SESSION);
const ALLOWED = (process.env.ONDRA_DEVICES_ALLOWED || "").split(",").map((s) => s.trim()).filter(Boolean);
/** set by the app: only this space's devices exist for the job */
const SCOPED = process.env.ONDRA_DEVICES_ALLOWED !== undefined;
// devices no job may ever boot or drive (e.g. a team's shared emulators), as a
// regular expression on the name; set ONDRA_PROTECTED_DEVICES in .env
const PROTECTED = (() => {
  try {
    return process.env.ONDRA_PROTECTED_DEVICES ? new RegExp(process.env.ONDRA_PROTECTED_DEVICES, "i") : null;
  } catch {
    return null;
  }
})();
const isProtected = (name: string) => !!PROTECTED?.test(name);
const SDK = join(process.env.HOME || "", "Library/Android/sdk");
const ADB = existsSync(join(SDK, "platform-tools/adb")) ? join(SDK, "platform-tools/adb") : "adb";
const EMULATOR = join(SDK, "emulator/emulator");
const AVD_HOME = process.env.ANDROID_AVD_HOME || join(process.env.HOME || "", ".android/avd");
const MAX_OUT = 14_000;

function run(cmd: string, args: string[], opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 120_000, maxBuffer: 32 * 1024 * 1024, signal: opts.signal, env: process.env }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n${stderr}` : ""}`.trim();
      done({ ok: !err, out: out || (err ? String(err.message) : "") });
    });
  });
}

/** "press @e3 --settle" / 'fill @e7 "a b"' → argv (quotes respected) */
function argv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, has = false;
  for (const ch of line.trim()) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") (q = ch), (has = true);
    else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      (cur = ""), (has = false);
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const cut = (s: string) => (s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (${s.length - MAX_OUT} chars cut — use find/get/is for a part of the screen)` : s);
const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: t }], details });

/** the newest iPhone a runtime supports, plain before Pro (the list's order differs between Xcode versions) */
export function pickPhone(names: string[]): string | undefined {
  const num = (n: string) => Number(/^iPhone (\d+)( Pro)?$/.exec(n)?.[1] ?? -1);
  const plain = names.filter((n) => num(n) >= 0).sort((a, b) => num(b) - num(a) || a.length - b.length);
  return plain[0] ?? names[0];
}

/** the tool's own devices: iOS templates and Android snapshot bases, never a job's to drive */
export const internal = (name: string) => /^ondra-(template|base|spare)-/.test(name);

// A spare: after a job gets its iOS device, the next one is cloned and booted with its runner
// started (the slow part of a new device), and waits for the next job, which takes it by
// renaming it. Untaken, it deletes itself after a while; its runner is kept warm meanwhile.
const SPARE_MINUTES = 15;
const spareStem = (tpl: string) => tpl.replace(/^ondra-template-/, "ondra-spare-");
export const spareName = (tpl: string, n: number) => `${spareStem(tpl)}-${n}`;
export const spareOf = (tpl: string, names: string[]) => names.filter((n) => n.startsWith(`${spareStem(tpl)}-`) && /^\d+$/.test(n.slice(spareStem(tpl).length + 1)));
/** commands that don't drive the screen don't wait for the runner to start */
export const needsRunner = (args: string[]) => !["install", "reinstall", "uninstall", "apps"].includes(args[0]);
const q = (s: string) => `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
/** the spare's life, detached from the job: clone, boot, start the runner, keep it warm, and go unless taken */
export function spareScript(o: { template: string; name: string; minutes: number; delay?: number }): string {
  const name = q(o.name);
  return [
    ...(o.delay ? [`sleep ${Math.round(o.delay)}`] : []),
    `U=$(xcrun simctl clone ${q(o.template)} ${name} | tail -1) || exit 0`,
    `xcrun simctl boot "$U" && xcrun simctl bootstatus "$U" -b >/dev/null 2>&1 || { xcrun simctl delete "$U"; exit 0; }`,
    `agent-device prepare ios-runner --platform ios --udid "$U" --session ${name} --timeout 420000 >/dev/null 2>&1`,
    `agent-device open com.apple.Preferences --platform ios --udid "$U" --session ${name} >/dev/null 2>&1`,
    `end=$(( $(date +%s) + ${o.minutes} * 60 )); n=0`,
    `while [ "$(date +%s)" -lt "$end" ]; do`,
    `  sleep 30; n=$((n + 1))`,
    // taken by a job (renamed): it's the job's now
    `  xcrun simctl list devices | grep -q "${o.name} (" || exit 0`,
    `  [ $((n % 8)) -eq 0 ] && agent-device snapshot --session ${name} >/dev/null 2>&1`,
    `done`,
    `xcrun simctl list devices | grep -q "${o.name} (" || exit 0`,
    `agent-device close --session ${name} >/dev/null 2>&1; xcrun simctl shutdown "$U"; xcrun simctl delete "$U"`,
  ].join("\n");
}
/** the iOS template for a device type and runtime (booted once, then shut down: clones of it boot in seconds) */
export const templateName = (kind: string, runtime: string) =>
  `ondra-template-${kind}-${runtime.split(".").pop() ?? runtime}`.replace(/[^\w.-]+/g, "-").slice(0, 60);
/** the Android copy of an AVD that holds a clean snapshot (no app data, no logins) */
export const baseAvdName = (avd: string) => `ondra-base-${avd}`.replace(/[^\w.-]/g, "-").slice(0, 60);
const SNAPSHOT = "clean";
/** a job's emulator: the clean snapshot, read-only (it boots in seconds, keeps nothing, and several jobs can share the base) */
export const readOnlyBoot = (base: string) => ["-avd", base, "-read-only", "-snapshot", SNAPSHOT, "-no-snapshot-save", "-no-window", "-gpu", "auto-no-window", "-no-audio", "-no-boot-anim"];

const MANAGED = ["boot", "shutdown", "proxy", "daemon", "connect", "devices"];
const DEVICE_FLAGS = ["--session", "--udid", "--serial", "--device", "--platform"];
/** one agent-device command line → its args on the job's device, or why not */
export function stepArgs(line: string): string[] | string {
  const args = argv(line).filter((a, i, all) => !DEVICE_FLAGS.includes(a) && !DEVICE_FLAGS.includes(all[i - 1]));
  if (args[0] === "agent-device") args.shift();
  if (!args.length) return "cmd is empty.";
  // devices lists every device on the Mac, other spaces' too
  if (MANAGED.includes(args[0])) return `'${args[0]}' isn't allowed here; the tool manages the device.`;
  return args;
}

/** Several commands in one call: in order, stopping at the first that fails. Earlier steps as a line each, the last in full. */
export async function runSteps(lines: string[], exec: (args: string[]) => Promise<{ ok: boolean; out: string }>): Promise<{ ok: boolean; text: string }> {
  const log: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const args = stepArgs(line);
    const r = typeof args === "string" ? { ok: false, out: args } : await exec(args);
    const last = i === lines.length - 1;
    if (!r.ok) {
      log.push(`✗ ${line}`, r.out || "failed", ...lines.slice(i + 1).map((l) => `not run: ${l.trim()}`));
      return { ok: false, text: log.join("\n") };
    }
    log.push(last ? `✓ ${line}\n${r.out || "ok"}` : `✓ ${line}${r.out && r.out.length < 120 && !r.out.includes("\n") ? ` · ${r.out}` : ""}`);
  }
  return { ok: true, text: log.join("\n") };
}

/** Only one process at a time makes a template or a snapshot base (other jobs wait, then use it). */
/** a lock whose owner is gone (a job stopped, the app quit), or one ten minutes old */
export const staleLock = (l: { pid?: number; ageMs: number }, alive: (pid: number) => boolean) => l.ageMs > 600_000 || (l.pid !== undefined && !alive(l.pid));
const alivePid = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function locked<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const dir = join(tmpdir(), `ondra-device-${key.replace(/[^\w.-]/g, "-")}.lock`);
  for (let i = 0; i < 300; i++) {
    try {
      mkdirSync(dir);
      try {
        writeFileSync(join(dir, "pid"), String(process.pid));
        return await work();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        const pid = Number(readFileSync(join(dir, "pid"), "utf8")) || undefined;
        if (staleLock({ pid, ageMs: Date.now() - statSync(dir).mtimeMs }, alivePid)) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* gone already */
      }
      if (signal?.aborted) throw new Error("cancelled");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return work();
}

// The device this job made, kept on disk so a job resumed after an app restart
// gets it back instead of asking to use "someone else's" device.
const OWNED = join(ARTIFACTS, ".device.json");
/** the runner starting in the background after a start without an app */
let warming: Promise<unknown> | undefined;
let mine: Mine | undefined = (() => {
  try {
    return JSON.parse(readFileSync(OWNED, "utf8")) as Mine;
  } catch {
    return undefined;
  }
})();
const own = (m: Mine | undefined) => {
  mine = m;
  try {
    if (m) mkdirSync(ARTIFACTS, { recursive: true }), writeFileSync(OWNED, JSON.stringify(m));
    else rmSync(OWNED, { force: true });
  } catch {
    /* best effort */
  }
};

const target = (m: Mine) => (m.platform === "ios" ? ["--platform", "ios", "--udid", m.udid!] : ["--platform", "android", "--serial", m.serial!]);

async function iosMake(model: string | undefined, signal?: AbortSignal): Promise<Mine | string> {
  const name = `ondra-${WORKER}`.slice(0, 40);
  // newest iOS runtime and an iPhone it supports (plain or Pro, newest first)
  const rt = await run("xcrun", ["simctl", "list", "runtimes", "-j"], { signal });
  let kind = model, runtime: string | undefined;
  try {
    const all: { identifier: string; platform?: string; name: string; isAvailable: boolean; version: string; supportedDeviceTypes?: { name: string; identifier: string }[] }[] = JSON.parse(rt.out).runtimes ?? [];
    const ios = all.filter((r) => r.isAvailable && (r.platform === "iOS" || r.name.startsWith("iOS"))).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    runtime = ios?.identifier;
    const phones = (ios?.supportedDeviceTypes ?? []).filter((t) => t.name.startsWith("iPhone"));
    if (!kind) kind = pickPhone(phones.map((t) => t.name));
  } catch {
    /* fall through */
  }
  if (!kind) return "No iPhone device type found (xcrun simctl list devicetypes).";
  // a clone of a template that has booted once boots in seconds; a new simulator's first boot takes half a minute
  const fast = runtime ? await iosClone(name, kind, runtime, signal) : undefined;
  if (fast) return fast;
  const made = await run("xcrun", ["simctl", "create", name, kind, ...(runtime ? [runtime] : [])], { signal });
  const udid = made.out.split("\n").pop()?.trim();
  if (!made.ok || !udid || !/^[0-9A-F-]{36}$/i.test(udid)) return `simctl create failed: ${made.out}`;
  await run("xcrun", ["simctl", "boot", udid], { signal });
  const ready = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 240_000, signal });
  if (!ready.ok) return `simulator didn't finish booting: ${ready.out}`;
  return { platform: "ios", udid, name, made: true };
}

// Host apps (Expo Go): installed once, they go into the template / snapshot, so the next job's
// device has them already. Only host shells: a job's own build is never shared with other jobs.
const HOSTS: Record<Platform, string[]> = { ios: ["host.exp.Exponent"], android: ["host.exp.exponent"] };
export const bakeable = (platform: Platform, id: string) => HOSTS[platform].includes(id);
type Baked = { key: string; path: string; platform: Platform };
export const alreadyBaked = (baked: string[] | undefined, key: string) => !!baked?.includes(key);
export const missingBakes = (apps: Baked[], platform: Platform, have: string[] | undefined) => apps.filter((a) => a.platform === platform && !have?.includes(a.key));
const BAKES = join(process.env.HOME || tmpdir(), "Library/Caches/ondra-device/bakes.json");
type BakeFile = { apps: Baked[]; into: Record<string, string[]> };
const bakes = (): BakeFile => {
  try {
    const f = JSON.parse(readFileSync(BAKES, "utf8")) as BakeFile;
    // an app moved or deleted since isn't wanted any more
    return { apps: (f.apps ?? []).filter((a) => existsSync(a.path)), into: f.into ?? {} };
  } catch {
    return { apps: [], into: {} };
  }
};
const saveBakes = (f: BakeFile) => {
  try {
    mkdirSync(join(BAKES, ".."), { recursive: true });
    writeFileSync(BAKES, JSON.stringify(f));
  } catch {
    /* best effort */
  }
};
/** an app bundle or apk by what it is: "<id>@<version>" (iOS from its Info.plist; Android: the package and the file's size and time) */
async function appKey(platform: Platform, path: string, device?: Mine): Promise<string | undefined> {
  if (platform === "ios") {
    const plist = join(path, "Info.plist");
    const id = (await run("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist])).out.trim();
    const v = (await run("plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", plist])).out.trim();
    return id && !/error/i.test(id) ? `${id}@${v}` : undefined;
  }
  if (!device?.serial) return undefined;
  for (const id of HOSTS.android) {
    const has = await run(ADB, ["-s", device.serial, "shell", "pm", "path", id], { timeout: 10_000 });
    if (has.ok && has.out.includes("package:")) {
      try {
        const st = statSync(path);
        return `${id}@${st.size}-${Math.round(st.mtimeMs)}`;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
/** After an install went in: a host app is remembered, to be baked into the next template / snapshot. */
async function noteInstall(device: Mine, path: string) {
  const key = await appKey(device.platform, path, device);
  if (!key || !bakeable(device.platform, key.split("@")[0])) return;
  const f = bakes();
  if (f.apps.some((a) => a.key === key)) return;
  // a newer version of the same app replaces the older
  f.apps = [...f.apps.filter((a) => a.platform !== device.platform || a.key.split("@")[0] !== key.split("@")[0]), { key, path, platform: device.platform }];
  saveBakes(f);
}

/** iOS devices by name: udid and state */
async function simByName(name: string): Promise<{ udid: string; state: string } | undefined> {
  const l = await run("xcrun", ["simctl", "list", "devices", "-j"]);
  try {
    return Object.values(JSON.parse(l.out).devices as Record<string, { name: string; udid: string; state: string; isAvailable?: boolean }[]>)
      .flat()
      .find((d) => d.name === name && d.isAvailable !== false);
  } catch {
    return undefined;
  }
}

/** This job's device as a clone of the template (made once: created, booted, shut down). Undefined: make one the slow way. */
async function iosClone(name: string, kind: string, runtime: string, signal?: AbortSignal): Promise<Mine | undefined> {
  const tpl = templateName(kind, runtime);
  let t = await simByName(tpl);
  if (!t)
    t = await locked(tpl, async () => {
      const had = await simByName(tpl);
      if (had) return had;
      const made = await run("xcrun", ["simctl", "create", tpl, kind, runtime], { signal });
      const udid = made.out.split("\n").pop()?.trim();
      if (!made.ok || !udid || !/^[0-9A-F-]{36}$/i.test(udid)) return undefined;
      await run("xcrun", ["simctl", "boot", udid], { signal });
      const ok = (await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 240_000, signal })).ok;
      // agent-device's runner goes in once here (and starts once: its first start on a device is the slow one)
      if (ok) {
        await run("agent-device", ["prepare", "ios-runner", "--platform", "ios", "--udid", udid, "--session", `${tpl}-prep`.slice(0, 60), "--timeout", "420000"], { signal, timeout: 450_000 });
        // a new template has nothing baked in yet, whatever an old one of that name had
        const f = bakes();
        delete f.into[tpl];
        saveBakes(f);
        await bakeIos(tpl, udid, signal);
      }
      await run("xcrun", ["simctl", "shutdown", udid], { timeout: 60_000 });
      if (!ok) {
        await run("xcrun", ["simctl", "delete", udid]);
        return undefined;
      }
      return { udid, state: "Shutdown" };
    }, signal).catch(() => undefined);
  if (!t || t.state !== "Shutdown") return undefined;
  // host apps installed since it was made: baked in now, once
  if (missingBakes(bakes().apps, "ios", bakes().into[tpl]).length)
    await locked(tpl, async () => {
      if (!missingBakes(bakes().apps, "ios", bakes().into[tpl]).length) return;
      await run("xcrun", ["simctl", "boot", t!.udid], { signal });
      if ((await run("xcrun", ["simctl", "bootstatus", t!.udid, "-b"], { timeout: 240_000, signal })).ok) await bakeIos(tpl, t!.udid, signal);
      await run("xcrun", ["simctl", "shutdown", t!.udid], { timeout: 60_000 });
    }, signal).catch(() => undefined);
  const baked = bakes().into[tpl];
  // a spare already booted with its runner warm: taken at once
  const taken = await takeSpare(tpl, name, signal);
  // after a cold start the job's own runner starts first: two at once took 84s instead of 35s
  void makeSpare(tpl, t.udid, taken ? 0 : 150);
  if (taken) return { platform: "ios", udid: taken, name, made: true, baked };
  const c = await run("xcrun", ["simctl", "clone", t.udid, name], { signal, timeout: 60_000 });
  const udid = c.out.split("\n").pop()?.trim();
  if (!c.ok || !udid || !/^[0-9A-F-]{36}$/i.test(udid)) return undefined;
  await run("xcrun", ["simctl", "boot", udid], { signal });
  const ready = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 240_000, signal });
  if (!ready.ok) {
    await run("xcrun", ["simctl", "delete", udid]);
    return undefined;
  }
  return { platform: "ios", udid, name, made: true, baked };
}

/** iOS devices of the Mac: name, udid, state */
async function sims(): Promise<{ name: string; udid: string; state: string }[]> {
  try {
    return Object.values(JSON.parse((await run("xcrun", ["simctl", "list", "devices", "-j"])).out).devices as Record<string, { name: string; udid: string; state: string }[]>).flat();
  } catch {
    return [];
  }
}

/** Take a booted spare of this template for the job (renamed to the job's device); spares left shut down (a restart) go. */
async function takeSpare(tpl: string, name: string, signal?: AbortSignal): Promise<string | undefined> {
  return locked(`${tpl}-spare`, async () => {
    const all = await sims();
    const spares = all.filter((d) => spareOf(tpl, [d.name]).length);
    for (const d of spares.filter((x) => x.state !== "Booted")) await run("xcrun", ["simctl", "delete", d.udid]);
    const s = spares.find((x) => x.state === "Booted");
    if (!s) return undefined;
    // its own session lets go of the device (the runner stays warm), then it's the job's
    await run("agent-device", ["close", "--session", s.name], { timeout: 30_000 });
    return (await run("xcrun", ["simctl", "rename", s.udid, name])).ok ? s.udid : undefined;
  }, signal).catch(() => undefined);
}

/** One spare per template, made in the background for the next job (nothing when one is already there or on its way). */
async function makeSpare(tpl: string, template: string, delay: number) {
  if (process.env.ONDRA_DEVICE_SPARE === "0") return;
  if (spareOf(tpl, (await sims()).map((d) => d.name)).length) return;
  const { spawn } = await import("node:child_process");
  spawn("sh", ["-c", spareScript({ template, name: spareName(tpl, Date.now() % 1_000_000), minutes: SPARE_MINUTES, delay })], { detached: true, stdio: "ignore", env: process.env }).unref();
}

/** Install the host apps the template lacks (it is booted), and note them as in it. */
async function bakeIos(tpl: string, udid: string, signal?: AbortSignal) {
  const f = bakes();
  const done = [...(f.into[tpl] ?? [])];
  for (const a of missingBakes(f.apps, "ios", done)) if ((await run("xcrun", ["simctl", "install", udid, a.path], { signal, timeout: 300_000 })).ok) done.push(a.key);
  const now = bakes();
  now.into[tpl] = done;
  saveBakes(now);
}

async function runningAvds(signal?: AbortSignal): Promise<{ lines: string[]; busy: Map<string, string> }> {
  const running = await run(ADB, ["devices"], { signal });
  const lines = running.out.split("\n");
  const busy = new Map<string, string>();
  for (const line of lines) {
    const serial = line.split(/\s+/)[0];
    if (!serial?.startsWith("emulator-")) continue;
    const n = await run(ADB, ["-s", serial, "emu", "avd", "name"], { signal, timeout: 5000 });
    busy.set(n.out.split("\n")[0].trim(), serial);
  }
  return { lines, busy };
}

/** A copy of `base` for this job: same system image and hardware, none of its data. */
export function cloneAvd(base: string, name: string, home = AVD_HOME): string | undefined {
  try {
    const conf = readFileSync(join(home, `${base}.avd`, "config.ini"), "utf8")
      .split("\n")
      .map((l) => (l.startsWith("AvdId=") ? `AvdId=${name}` : l.startsWith("avd.ini.displayname=") ? `avd.ini.displayname=${name}` : l))
      .join("\n");
    const dir = join(home, `${name}.avd`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.ini"), conf);
    const ini = readFileSync(join(home, `${base}.ini`), "utf8")
      .split("\n")
      .map((l) => (l.startsWith("path=") ? `path=${dir}` : l.startsWith("path.rel=") ? `path.rel=avd/${name}.avd` : l))
      .join("\n");
    writeFileSync(join(home, `${name}.ini`), ini);
    return name;
  } catch {
    return undefined;
  }
}

export function dropAvd(name: string, home = AVD_HOME) {
  if (!/^ondra-/.test(name) || /[/\\]|\.\./.test(name)) return;
  rmSync(join(home, `${name}.avd`), { recursive: true, force: true });
  rmSync(join(home, `${name}.ini`), { force: true });
}

/** Boot an AVD headless and wait until Android is up. `args`: how (a read-only snapshot boot instead of a plain or fresh one). */
/** emulator ports in use, from `adb devices` lines (emulator-5554 → 5554) */
export const portsIn = (lines: string[]) => new Set(lines.map((l) => /^emulator-(\d+)\s/.exec(l)?.[1]).filter(Boolean).map(Number));
/** an even console port 5554–5680 none has (skip: how many free ones to pass over, after one turned out taken) */
export function freePort(used: Set<number>, skip = 0): number | undefined {
  for (let p = 5554; p <= 5680; p += 2) if (!used.has(p) && skip-- <= 0) return p;
  return undefined;
}

async function androidBoot(avd: string, fresh: boolean, before: Set<string>, signal?: AbortSignal, args?: string[]): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  // its own port, so it's told apart from one still going away (which would hand it the same serial)
  const used = portsIn([...before].map((s) => `${s} `));
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = freePort(used, attempt);
    if (!port) return undefined;
    const serial = `emulator-${port}`;
    // headless with plain -gpu auto, the emulator draws in software on the CPU (several
    // cores at all times); auto-no-window draws on the Mac's GPU
    const child = spawn(EMULATOR, [...(args ?? ["-avd", avd, "-no-snapshot-save", ...(fresh ? ["-wipe-data", "-no-snapshot-load"] : []), "-no-window", "-gpu", "auto-no-window", "-no-audio", "-no-boot-anim"]), "-port", String(port)], { detached: true, stdio: "ignore" });
    // an emulator that quits at once (a broken system image, a bad snapshot, its port taken) isn't waited on for minutes
    let gone = false;
    child.on("exit", () => (gone = true));
    child.unref();
    for (let i = 0; i < 120 && !gone; i++) {
      if (signal?.aborted) return undefined;
      await new Promise((r) => setTimeout(r, i < 10 ? 500 : 2000));
      const booted = await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 5000 });
      if (booted.out.trim() === "1") return serial;
    }
    if (!gone) return undefined;
  }
  return undefined;
}

/** The snapshot base of `avd`: a copy cold-booted once with its data wiped, saved as the clean snapshot, then shut down. */
async function snapshotBase(avd: string, signal?: AbortSignal): Promise<string | undefined> {
  const base = baseAvdName(avd);
  const has = () => existsSync(join(AVD_HOME, `${base}.avd`, "snapshots", SNAPSHOT));
  const ready = () => has() && !missingBakes(bakes().apps, "android", bakes().into[base]).length;
  if (ready()) return base;
  return locked(base, async () => {
    if (ready()) return base;
    // made once (a copy cold-booted with its data wiped), or booted from its snapshot to bake host apps in
    const fresh = !has();
    if (fresh) {
      dropAvd(base);
      if (!cloneAvd(avd, base)) return undefined;
      const f = bakes();
      delete f.into[base];
      saveBakes(f);
    }
    const { lines } = await runningAvds(signal);
    const how = fresh ? ["-wipe-data", "-no-snapshot-load"] : ["-snapshot", SNAPSHOT];
    const serial = await androidBoot(base, fresh, new Set(lines.map((l) => l.split(/\s+/)[0])), signal, ["-avd", base, ...how, "-no-window", "-gpu", "auto-no-window", "-no-audio", "-no-boot-anim"]);
    if (!serial) return fresh ? (dropAvd(base), undefined) : base;
    // let it settle before the snapshot: a snapshot taken mid-start comes back busy every time
    if (fresh) await new Promise((r) => setTimeout(r, 8000));
    const f = bakes();
    const done = [...(f.into[base] ?? [])];
    for (const a of missingBakes(f.apps, "android", done)) if ((await run(ADB, ["-s", serial, "install", "-r", a.path], { signal, timeout: 300_000 })).ok) done.push(a.key);
    const saved = await run(ADB, ["-s", serial, "emu", "avd", "snapshot", "save", SNAPSHOT], { timeout: 120_000 });
    await run(ADB, ["-s", serial, "emu", "kill"], { timeout: 15_000 });
    for (let i = 0; i < 20 && (await run(ADB, ["-s", serial, "get-state"], { timeout: 3000 })).ok; i++) await new Promise((r) => setTimeout(r, 500));
    if (!saved.ok || !has()) return fresh ? (dropAvd(base), undefined) : base;
    const now = bakes();
    now.into[base] = done;
    saveBakes(now);
    return base;
  }, signal).catch(() => undefined);
}

/** A fresh emulator for this job, copied from an AVD of its space (or `model` when that one is). */
async function androidMake(model: string | undefined, signal?: AbortSignal): Promise<Mine | string> {
  const list = await run(EMULATOR, ["-list-avds"], { signal });
  const avds = list.out.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("INFO") && !s.startsWith("ondra-"));
  // a copy carries no app data, so any AVD's system image will do when the space has none
  const mineToUse = (a: string) => !isProtected(a) && (!SCOPED || ALLOWED.includes(a));
  const base = (model && avds.includes(model) && !isProtected(model) ? model : undefined) ?? avds.find(mineToUse) ?? avds.find((a) => !isProtected(a));
  if (!base) return `No Android emulator to copy. AVDs: ${avds.join(", ") || "none"}.`;
  // fast: the clean snapshot booted read-only (nothing copied, nothing kept); the copy below when that can't be had
  const snap = await snapshotBase(base, signal);
  if (snap) {
    const { lines } = await runningAvds(signal);
    const serial = await androidBoot(snap, false, new Set(lines.map((l) => l.split(/\s+/)[0])), signal, readOnlyBoot(snap));
    if (serial) return { platform: "android", serial, name: snap, made: true, baked: bakes().into[snap] };
    if (signal?.aborted) return "cancelled";
  }
  const name = cloneAvd(base, `ondra-${WORKER}`.replace(/[^\w.-]/g, "-").slice(0, 48));
  if (!name) return `Couldn't copy ${base} for this job.`;
  const { lines } = await runningAvds(signal);
  const serial = await androidBoot(name, true, new Set(lines.map((l) => l.split(/\s+/)[0])), signal);
  if (!serial) {
    dropAvd(name);
    return signal?.aborted ? "cancelled" : "The emulator didn't start (it quit at once or took over 4 minutes; `emulator -avd <name>` says why).";
  }
  return { platform: "android", serial, name, made: true, clone: name };
}

/** A device of this job's space (by name or id): used as it is, booted first when it's an AVD that's off. */
async function allowed(platform: Platform, which: string, signal?: AbortSignal): Promise<Mine | string> {
  if (!ALLOWED.includes(which) || isProtected(which) || internal(which))
    return `"${which}" isn't a device of this job's space. Call start again without device: the tool makes a fresh one for this job.`;
  if (platform === "ios") {
    const l = await run("xcrun", ["simctl", "list", "devices", "-j"]);
    try {
      const all = Object.values(JSON.parse(l.out).devices as Record<string, { name: string; udid: string; state: string }[]>).flat();
      const d = all.find((x) => x.udid === which || x.name === which);
      if (d) {
        if (d.state !== "Booted") {
          await run("xcrun", ["simctl", "boot", d.udid], { signal });
          await run("xcrun", ["simctl", "bootstatus", d.udid, "-b"], { timeout: 240_000, signal });
        }
        return { platform, udid: d.udid, name: d.name, made: false };
      }
    } catch {
      /* ignore */
    }
    return `iOS device "${which}" not found.`;
  }
  const { lines, busy } = await runningAvds(signal);
  if (busy.has(which)) return { platform, serial: busy.get(which)!, name: which, made: false };
  const avds = (await run(EMULATOR, ["-list-avds"], { signal })).out.split("\n").map((s) => s.trim());
  if (avds.includes(which)) {
    const serial = await androidBoot(which, false, new Set(lines.map((l) => l.split(/\s+/)[0])), signal);
    // booted for this job: shut down again when it's done (the AVD itself stays)
    return serial ? { platform, serial, name: which, made: true } : "The emulator didn't start (it quit at once or took over 4 minutes; `emulator -avd <name>` says why).";
  }
  return { platform, serial: which, name: which, made: false };
}

export default function (pi: any) {
  pi.registerTool({
    name: "device",
    label: "Device",
    // called through use when a job needs a phone; not declared up front
    exposure: "deferred",
    description: [
      "Drive an iOS simulator or Android emulator. One device per job, made for this job.",
      "action=start {platform, app?, model?}: makes and boots a fresh device (seconds: a clone of a booted-once template on iOS, a clean snapshot on Android), opens app (bundle id / package / URL) and returns the first snapshot with @refs.",
      "action=do {steps}: several agent-device commands in one call, run in order and stopped at the first that fails (earlier ones as a line, the last in full): the way to go through a known path (fill, fill, press, wait) in one turn. {cmd}: one command, without the 'agent-device' word or device flags, e.g. 'press @e12 --settle', 'press text=\"Login\" --settle', 'fill @e3 \"me@x.com\" --settle', 'scroll down --settle', 'back --settle', 'snapshot -i', 'wait text \"Done\"', 'find label Login', 'is visible @e4', 'type hello', 'alert accept', 'keyboard dismiss', 'install /path/App.app', 'open com.x.app --relaunch', 'logs', 'home'. --settle returns the UI diff: continue from it; snapshot -i only when the diff lacks the next target. Refs go stale after changes. Coordinates ('press 120 640') only when no ref exists.",
      "No rebuild for a change in JS/TS: with Metro (React Native, Expo) running, 'metro reload' shows it in seconds; reinstall or rebuild only after a native or dependency change. A path you'll check again after changes: record it once (open <app> --relaunch --save-script=$APP_ARTIFACTS_DIR/flows/<name>.ad, the steps, a wait on the end screen, then 'session save-script') and rerun it with 'replay <file>' in one call.",
      "action=look {name?}: screenshot you can see, saved as proof (path in result).",
      "action=stop: close the app session, shut down and delete the device this job made. Always call it before your final answer unless the user wants the device kept.",
    ].join("\n"),
    promptSnippet: "Drive iOS simulators / Android emulators (start, do, look, stop)",
    promptGuidelines: [
      "Use the device tool (not bash with simctl/adb/agent-device) for anything on a phone simulator or emulator; it makes the job's own device so the user's devices are never touched.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("do"), Type.Literal("look"), Type.Literal("stop")]),
      platform: Type.Optional(Type.Union([Type.Literal("ios"), Type.Literal("android")], { description: "start: default ios" })),
      app: Type.Optional(Type.String({ description: "start: bundle id, package, app name or URL to open" })),
      model: Type.Optional(Type.String({ description: "start: iOS device type ('iPhone 17') or Android AVD name" })),
      device: Type.Optional(Type.String({ description: "start: an existing device of this space (name or id) instead of a new one" })),
      cmd: Type.Optional(Type.String({ description: "do: the agent-device command line" })),
      steps: Type.Optional(Type.Array(Type.String(), { description: "do: several agent-device command lines, run in order in one call" })),
      name: Type.Optional(Type.String({ description: "look: file name for the proof screenshot" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      // the app shuts down devices of jobs that ended; a later turn starts a new one
      if (mine && !existsSync(OWNED)) mine = undefined;
      if (p.action === "start") {
        if (mine) return text(`Already have ${mine.name} (${mine.platform}). Use do / look, or stop first.`);
        const platform: Platform = p.platform === "android" ? "android" : "ios";
        // a device of this space when named, otherwise a fresh one made for this job
        const got = p.device ? await allowed(platform, p.device, signal) : platform === "ios" ? await iosMake(p.model, signal) : await androidMake(p.model, signal);
        if (typeof got === "string") return text(got);
        own(got);
        if (!p.app) {
          // its runner starts while you build or install (its first start on a device is the slow part); the next command waits for it
          if (got.platform === "ios") warming = run("agent-device", ["prepare", "ios-runner", "--platform", "ios", "--udid", got.udid!, "--session", SESSION, "--timeout", "420000"], { timeout: 450_000 });
          const has = got.baked?.length ? ` Already on it: ${got.baked.map((k) => k.split("@")[0]).join(", ")}.` : "";
          return text(`Device ready: ${got.name} (${got.platform} ${got.udid ?? got.serial}).${has} Open an app with do 'open <app> --foreground'.`, { device: got });
        }
        // the first open on a Mac builds agent-device's runner once (minutes); later opens take seconds
        const r = await run("agent-device", ["open", p.app, "--foreground", "--timeout", "420000", "--session", SESSION, ...target(got)], { signal, timeout: 450_000 });
        return text(`Device: ${got.name} (${got.platform})\n${cut(r.out)}`, { device: got, ok: r.ok });
      }
      if (!mine) return text("No device yet. Call device with action=start first.");
      const warm = async () => {
        if (!warming) return;
        await warming.catch(() => undefined);
        warming = undefined;
      };
      if (p.action === "do") {
        const m = mine;
        const exec = async (args: string[]) => {
          // a host app the device's template already has: nothing to install
          if (args[0] === "install" && args[1] && m.baked?.length) {
            const key = await appKey(m.platform, args[1], m);
            if (key && alreadyBaked(m.baked, key)) return { ok: true, out: `${key.split("@")[0]} is already installed on this device (same version).` };
          }
          if (needsRunner(args)) await warm();
          const withTarget = ["open", "apps", "install", "reinstall", "uninstall", "install-from-source", "replay", "test"].includes(args[0]) ? target(m) : [];
          const r = await run("agent-device", [...args, "--session", SESSION, ...withTarget], { signal, timeout: 180_000 });
          if (r.ok && args[0] === "install" && args[1]) await noteInstall(m, args[1]).catch(() => undefined);
          return r;
        };
        // several steps in one call: one model turn instead of one per tap
        const lines: string[] = Array.isArray(p.steps) && p.steps.length ? p.steps.map(String) : [String(p.cmd ?? "")];
        if (lines.length === 1) {
          const args = stepArgs(lines[0]);
          if (typeof args === "string") return text(args);
          const r = await exec(args);
          return text(cut(r.out) || (r.ok ? "ok" : "failed"), { ok: r.ok });
        }
        const r = await runSteps(lines, exec);
        return text(cut(r.text), { ok: r.ok });
      }
      if (p.action === "look") {
        await warm();
        mkdirSync(ARTIFACTS, { recursive: true });
        const file = join(ARTIFACTS, `${String(p.name || `screen-${Date.now()}`).replace(/[^\w.-]+/g, "-").replace(/\.png$/, "")}.png`);
        const r = await run("agent-device", ["screenshot", file, "--session", SESSION], { signal, timeout: 60_000 });
        if (!existsSync(file) || statSync(file).size === 0) {
          // no app session yet: take the whole device screen
          const raw = mine.platform === "ios" ? await run("xcrun", ["simctl", "io", mine.udid!, "screenshot", "--type=png", file]) : await run("sh", ["-c", `"${ADB}" -s ${mine.serial} exec-out screencap -p > "${file}"`]);
          if (!existsSync(file) || statSync(file).size === 0) return text(`screenshot failed: ${r.out}\n${raw.out}`);
        }
        // the proof stays full size; what comes back to the model is small (a phone screen is ~2600px tall)
        const small = join(tmpdir(), `${SESSION}-look.jpg`);
        const shrunk = await run("sips", ["-Z", "1000", "-s", "format", "jpeg", "-s", "formatOptions", "70", file, "--out", small], { timeout: 15_000 });
        const pic = shrunk.ok && existsSync(small) ? { data: readFileSync(small).toString("base64"), mimeType: "image/jpeg" } : { data: readFileSync(file).toString("base64"), mimeType: "image/png" };
        rmSync(small, { force: true });
        return { content: [{ type: "text", text: `Saved ${file} (use it as proof: {"type":"shot","path":"${file}"}).` }, { type: "image", ...pic }], details: { path: file } };
      }
      if (p.action === "stop") {
        const m = mine;
        await run("agent-device", ["close", "--session", SESSION], { timeout: 30_000 });
        if (m.made) {
          if (m.platform === "ios") {
            await run("xcrun", ["simctl", "shutdown", m.udid!]);
            await run("xcrun", ["simctl", "delete", m.udid!]);
          } else {
            await run(ADB, ["-s", m.serial!, "emu", "kill"]);
            if (m.clone) {
              // the emulator lets go of its files a moment after it's told to quit
              for (let i = 0; i < 20 && (await run(ADB, ["-s", m.serial!, "get-state"], { timeout: 3000 })).ok; i++) await new Promise((r) => setTimeout(r, 500));
              dropAvd(m.clone);
            }
          }
        }
        own(undefined);
        return text(m.made ? `Closed and removed ${m.name}.` : `Closed the session; ${m.name} is the user's device, left running.`);
      }
      return text("Unknown action.");
    },
  });
}
