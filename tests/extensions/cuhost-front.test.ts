// The computer-use helper drives an app where it is: it never brings the target app or
// its window in front of the user. Calls that put something in front are allowed only in
// the functions that hand the front (or the top window) back to the user's own app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = join(__dirname, "../../src-tauri/helpers/cuhost.swift");

/** Calls that activate an app or lift a window over others. */
const FRONT = [
  /(?<!NSLayoutConstraint)\.activate\s*\(/, /activateWithOptions/, /activateIgnoringOtherApps/, /\bNSApp\.activate/,
  /PerformAction\s*\([^)]*(kAXRaiseAction|"AXRaise")/, /(kAXFrontmostAttribute|"AXFrontmost")/, /(kAXMainAttribute|"AXMain")\b/,
  /SetFrontProcess/, /\bactivates\s*=\s*true/, /makeKeyAndOrderFront/, /\/usr\/bin\/open|"open"/, /NSAppleScript|osascript/,
];
/** They act on the user's own front app, never on the target. */
const GIVES_BACK = new Set(["giveFrontBack", "keepUserWindowOnTop"]);

/** Each line that puts something in front, outside the functions allowed to. */
export function frontCalls(source: string): string[] {
  const out: string[] = [];
  let fn = "";
  source.split("\n").forEach((line, i) => {
    const decl = line.match(/^(?:@\w+\s+)*(?:(?:private|fileprivate|static|public)\s+)*func\s+(\w+)/);
    if (decl) fn = decl[1];
    else if (/^\S/.test(line) && !/^\}/.test(line)) fn = "";
    const code = line.replace(/\/\/.*$/, "");
    if (FRONT.some((re) => re.test(code)) && !GIVES_BACK.has(fn)) out.push(`cuhost.swift:${i + 1} (${fn || "top level"}): ${line.trim()}`);
  });
  return out;
}

describe("computer-use helper keeps the target behind the user's windows", () => {
  it("brings nothing to the front except the user's own app, given back", () => {
    const found = frontCalls(readFileSync(SOURCE, "utf8"));
    expect(found, "the target app is driven in the background: drop the activation or raise and act through AX actions or pid-addressed events; only giveFrontBack/keepUserWindowOnTop may bring the user's own app back").toEqual([]);
  });

  it("catches an activation or a raise anywhere else", () => {
    const bad = [
      "func openTarget(pid: pid_t) {",
      "    NSRunningApplication(processIdentifier: pid)?.activate(options: [])",
      "    _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)",
      "    cfg.activates = true",
      "}",
      "func giveFrontBack(to pid: pid_t) {",
      "    _ = prev.activate(options: [])",
      "}",
    ].join("\n");
    expect(frontCalls(bad)).toEqual([
      "cuhost.swift:2 (openTarget): NSRunningApplication(processIdentifier: pid)?.activate(options: [])",
      "cuhost.swift:3 (openTarget): _ = AXUIElementPerformAction(win, kAXRaiseAction as CFString)",
      "cuhost.swift:4 (openTarget): cfg.activates = true",
    ]);
  });

  it("the off-screen display's keeper never pulls a job's copy onto the user's screen", () => {
    // the keeper pulls the front app's windows off the off-screen display each second; the job's
    // helper pushes its copy's windows back on: a copy at the front flickered between the two
    const src = readFileSync(SOURCE, "utf8");
    const body = src.slice(src.indexOf("func pullBackWindows("), src.indexOf("extension CGRect { var area"));
    expect(body).toMatch(/^func pullBackWindows\(of pid: pid_t\) \{\n\s+guard !isJobCopy\(pid\) else \{ return \}/);
  });

  it("the apps a job runs are muted while they are the job's", () => {
    const src = readFileSync(SOURCE, "utf8");
    const keeper = src.slice(src.indexOf("func startWindowKeeper()"), src.indexOf("enum JobSound"));
    expect(keeper).toContain("JobSound.keepQuiet(Set(pids).union(real))");
    const sound = src.slice(src.indexOf("enum JobSound"), src.indexOf("static func audioClients()"));
    // a private tap that sends the process's audio nowhere, and goes when the app is no longer the job's
    expect(sound).toContain("d.muteBehavior = .muted");
    expect(sound).toContain("d.isPrivate = true");
    // a tap mutes only while a device holds it
    expect(sound).toContain("kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: d.uuid.uuidString]]");
    expect(sound).toMatch(/where !clients\.contains\(object\) \{\n\s+AudioHardwareDestroyAggregateDevice\(held\.device\)\n\s+AudioHardwareDestroyProcessTap\(held\.tap\)/);
    expect(readFileSync(join(__dirname, "../../src-tauri/Info.plist"), "utf8")).toContain("NSAudioCaptureUsageDescription");
  });
});
