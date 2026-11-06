// `device`: iOS simulators and Android emulators as one tool (agent-device underneath).
// One small schema instead of 60 MCP tools, so it costs little context and the model
// doesn't have to remember flags:
//   start  → a fresh device made for this job (never someone else's), app opened, first snapshot
//   do     → one agent-device command on that device ("press @e12 --settle", "fill @e3 hi")
//   look   → screenshot the model can see (also saved as proof in the job's artifacts)
//   stop   → close, shut down and delete what this job made
// Devices the job didn't make are refused unless the user named them in the job
// (ONDRA_DEVICES_ALLOWED), so the user's own simulators are never touched.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

type Platform = "ios" | "android";
type Mine = { platform: Platform; udid?: string; serial?: string; name: string; made: boolean };

const WORKER = process.env.APP_WORKER_ID || `job${process.pid}`;
const SESSION = `ondra-${WORKER}`.slice(0, 60);
const ARTIFACTS = process.env.APP_ARTIFACTS_DIR || join(process.env.TMPDIR || "/tmp", SESSION);
const ALLOWED = (process.env.ONDRA_DEVICES_ALLOWED || "").split(",").map((s) => s.trim()).filter(Boolean);
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

// The device this job made, kept on disk so a job resumed after an app restart
// gets it back instead of asking to use "someone else's" device.
const OWNED = join(ARTIFACTS, ".device.json");
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
    if (!kind) kind = [...phones].reverse().find((t) => /^iPhone \d+( Pro)?$/.test(t.name))?.name ?? phones.at(-1)?.name;
  } catch {
    /* fall through */
  }
  if (!kind) return "No iPhone device type found (xcrun simctl list devicetypes).";
  const made = await run("xcrun", ["simctl", "create", name, kind, ...(runtime ? [runtime] : [])], { signal });
  const udid = made.out.split("\n").pop()?.trim();
  if (!made.ok || !udid || !/^[0-9A-F-]{36}$/i.test(udid)) return `simctl create failed: ${made.out}`;
  await run("xcrun", ["simctl", "boot", udid], { signal });
  const ready = await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 240_000, signal });
  if (!ready.ok) return `simulator didn't finish booting: ${ready.out}`;
  return { platform: "ios", udid, name, made: true };
}

async function androidMake(avd: string | undefined, signal?: AbortSignal): Promise<Mine | string> {
  const list = await run(EMULATOR, ["-list-avds"], { signal });
  const avds = list.out.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("INFO"));
  const running = await run(ADB, ["devices"], { signal });
  const busy = new Set<string>();
  for (const line of running.out.split("\n")) {
    const serial = line.split(/\s+/)[0];
    if (!serial?.startsWith("emulator-")) continue;
    const n = await run(ADB, ["-s", serial, "emu", "avd", "name"], { signal, timeout: 5000 });
    busy.add(n.out.split("\n")[0].trim());
  }
  const pick = avd ?? avds.find((a) => !busy.has(a) && !isProtected(a));
  if (!pick) return `No free Android emulator. AVDs: ${avds.join(", ") || "none"}; running: ${[...busy].join(", ") || "none"}.`;
  if (busy.has(pick)) return `${pick} is already running (someone else's). Pick another or ask the user.`;
  const before = new Set(running.out.split("\n").map((l) => l.split(/\s+/)[0]));
  const { spawn } = await import("node:child_process");
  // headless with plain -gpu auto, the emulator draws in software on the CPU (several
  // cores at all times); auto-no-window draws on the Mac's GPU
  spawn(EMULATOR, ["-avd", pick, "-no-snapshot-save", "-no-window", "-gpu", "auto-no-window", "-no-audio", "-no-boot-anim"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 90; i++) {
    if (signal?.aborted) return "cancelled";
    await new Promise((r) => setTimeout(r, 2000));
    const now = await run(ADB, ["devices"]);
    const serial = now.out.split("\n").map((l) => l.split(/\s+/)).find(([s, st]) => s?.startsWith("emulator-") && st === "device" && !before.has(s))?.[0];
    if (!serial) continue;
    const booted = await run(ADB, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeout: 5000 });
    if (booted.out.trim() === "1") return { platform: "android", serial, name: pick, made: true };
  }
  return "Emulator didn't boot in 3 minutes.";
}

/** A device the user explicitly allowed for this job (by name or id). */
async function allowed(platform: Platform, which: string): Promise<Mine | string> {
  if (!ALLOWED.some((a) => a === which)) return `"${which}" isn't this job's device. Call start again without device: the tool makes or boots a free one for this job.`;
  if (platform === "ios") {
    const l = await run("xcrun", ["simctl", "list", "devices", "-j"]);
    try {
      const all = Object.values(JSON.parse(l.out).devices as Record<string, { name: string; udid: string; state: string }[]>).flat();
      const d = all.find((x) => x.udid === which || x.name === which);
      if (d) return { platform, udid: d.udid, name: d.name, made: false };
    } catch {
      /* ignore */
    }
    return `iOS device "${which}" not found.`;
  }
  return { platform, serial: which, name: which, made: false };
}

export default function (pi: any) {
  pi.registerTool({
    name: "device",
    label: "Device",
    // found with tool_search when a job needs a phone; not declared up front
    exposure: "deferred",
    description: [
      "Drive an iOS simulator or Android emulator. One device per job, made for this job.",
      "action=start {platform, app?, model?}: makes and boots a fresh device, opens app (bundle id / package / URL) and returns the first snapshot with @refs.",
      "action=do {cmd}: one agent-device command on it, without the 'agent-device' word or device flags, e.g. 'press @e12 --settle', 'press text=\"Login\" --settle', 'fill @e3 \"me@x.com\" --settle', 'scroll down --settle', 'back --settle', 'snapshot -i', 'wait text \"Done\"', 'find label Login', 'is visible @e4', 'type hello', 'alert accept', 'keyboard dismiss', 'install /path/App.app', 'open com.x.app --relaunch', 'logs', 'home'. --settle returns the UI diff: continue from it; snapshot -i only when the diff lacks the next target. Refs go stale after changes. Coordinates ('press 120 640') only when no ref exists.",
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
      device: Type.Optional(Type.String({ description: "start: an existing device the user allowed (name or id) instead of a new one" })),
      cmd: Type.Optional(Type.String({ description: "do: the agent-device command line" })),
      name: Type.Optional(Type.String({ description: "look: file name for the proof screenshot" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      // the app shuts down devices of jobs that ended; a later turn starts a new one
      if (mine && !existsSync(OWNED)) mine = undefined;
      if (p.action === "start") {
        if (mine) return text(`Already have ${mine.name} (${mine.platform}). Use do / look, or stop first.`);
        const platform: Platform = p.platform === "android" ? "android" : "ios";
        // an Android AVD nobody is running can simply be booted for this job
        // (it's what start without a device would pick); running ones stay off-limits
        const free = p.device && platform === "android" && !ALLOWED.includes(p.device) && !isProtected(p.device);
        const got = free ? await androidMake(p.device, signal) : p.device ? await allowed(platform, p.device) : platform === "ios" ? await iosMake(p.model, signal) : await androidMake(p.model, signal);
        if (typeof got === "string") return text(got);
        own(got);
        if (!p.app) return text(`Device ready: ${got.name} (${got.platform} ${got.udid ?? got.serial}). Open an app with do 'open <app> --foreground'.`, { device: got });
        // the first open on a Mac builds agent-device's runner once (minutes); later opens take seconds
        const r = await run("agent-device", ["open", p.app, "--foreground", "--timeout", "420000", "--session", SESSION, ...target(got)], { signal, timeout: 450_000 });
        return text(`Device: ${got.name} (${got.platform})\n${cut(r.out)}`, { device: got, ok: r.ok });
      }
      if (!mine) return text("No device yet. Call device with action=start first.");
      if (p.action === "do") {
        const args = argv(String(p.cmd ?? "")).filter((a, i, all) => !["--session", "--udid", "--serial", "--device", "--platform"].includes(a) && !["--session", "--udid", "--serial", "--device", "--platform"].includes(all[i - 1]));
        if (args[0] === "agent-device") args.shift();
        if (!args.length) return text("cmd is empty.");
        if (["boot", "shutdown", "proxy", "daemon", "connect"].includes(args[0])) return text(`'${args[0]}' isn't allowed here; the tool manages the device.`);
        const withTarget = ["open", "devices", "apps", "install", "reinstall", "uninstall", "install-from-source"].includes(args[0]) ? target(mine) : [];
        const r = await run("agent-device", [...args, "--session", SESSION, ...withTarget], { signal, timeout: 180_000 });
        return text(cut(r.out) || (r.ok ? "ok" : "failed"), { ok: r.ok });
      }
      if (p.action === "look") {
        mkdirSync(ARTIFACTS, { recursive: true });
        const file = join(ARTIFACTS, `${String(p.name || `screen-${Date.now()}`).replace(/[^\w.-]+/g, "-").replace(/\.png$/, "")}.png`);
        const r = await run("agent-device", ["screenshot", file, "--session", SESSION], { signal, timeout: 60_000 });
        if (!existsSync(file) || statSync(file).size === 0) {
          // no app session yet: take the whole device screen
          const raw = mine.platform === "ios" ? await run("xcrun", ["simctl", "io", mine.udid!, "screenshot", "--type=png", file]) : await run("sh", ["-c", `"${ADB}" -s ${mine.serial} exec-out screencap -p > "${file}"`]);
          if (!existsSync(file) || statSync(file).size === 0) return text(`screenshot failed: ${r.out}\n${raw.out}`);
        }
        const data = readFileSync(file).toString("base64");
        return { content: [{ type: "text", text: `Saved ${file} (use it as proof: {"type":"shot","path":"${file}"}).` }, { type: "image", data, mimeType: "image/png" }], details: { path: file } };
      }
      if (p.action === "stop") {
        const m = mine;
        await run("agent-device", ["close", "--session", SESSION], { timeout: 30_000 });
        if (m.made) {
          if (m.platform === "ios") {
            await run("xcrun", ["simctl", "shutdown", m.udid!]);
            await run("xcrun", ["simctl", "delete", m.udid!]);
          } else await run(ADB, ["-s", m.serial!, "emu", "kill"]);
        }
        own(undefined);
        return text(m.made ? `Closed and removed ${m.name}.` : `Closed the session; ${m.name} is the user's device, left running.`);
      }
      return text("Unknown action.");
    },
  });
}
