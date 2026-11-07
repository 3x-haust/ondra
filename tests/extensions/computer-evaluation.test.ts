import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createComputerEvaluation, exportComputerObservations } from "../../extensions/lib/computer-evaluation";
import { ComputerSession } from "../../extensions/lib/computer-session";

const roots: string[] = [];
const temporary = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "computer-evaluation-")));
  roots.push(path);
  return path;
};
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const ok = (command: string, data: unknown) => ({ version: "2.6", command, ok: true, data });
const snapshot = (id: string) => ok("snapshot", { snapshot_id: id, complete: true, tree: { role: "window", name: "private UI content", ref_id: `@${id}:e1` } });
const segments = (root: string) => {
  const run = join(root, readdirSync(root)[0]);
  return readdirSync(run).sort().map(name => join(run, name));
};

describe("private computer evaluation", () => {
  it("defaults to compact with no capture and validates explicit opt-ins", () => {
    expect(createComputerEvaluation({})).toEqual({ forceFull: false });
    expect(createComputerEvaluation({ ONDRA_COMPUTER_EVALUATION_MODE: "forced-full" })).toEqual({ forceFull: true });
    expect(createComputerEvaluation({ ONDRA_COMPUTER_EVALUATION_MODE: "compact" })).toEqual({ forceFull: false });
    for (const value of ["full", "", "true"]) {
      expect(() => createComputerEvaluation({ ONDRA_COMPUTER_EVALUATION_MODE: value })).toThrow("Invalid computer evaluation configuration");
    }
  });

  it("captures only snapshots including automatic reads, splits resets, and exports an ordered private array", async () => {
    const root = temporary();
    const evaluation = createComputerEvaluation({ ONDRA_COMPUTER_CAPTURE_DIR: root });
    expect(readdirSync(root)).toEqual([]);
    const raw = [snapshot("s1"), snapshot("s2"), snapshot("s3")];
    const responses = [ok("session", { session_id: "fixture", secret: "session-secret" }), ok("launch", { secret: "launch-secret" }),
      raw[0], ok("click", { secret: "action-secret", disposition: { delivery: "delivered_unverified", retry: "unsafe" } }), raw[1], raw[2]];
    const session = new ComputerSession(async () => responses.shift(), evaluation);
    const start = await session.start("TextEdit");
    await session.act({ kind: "click", epoch: start.observation!.epoch, ref: "e1" });
    session.resetObservations();
    await session.observe();
    const directories = segments(root);
    expect(directories).toHaveLength(2);
    const exported = exportComputerObservations(directories[0], temporary());
    expect(exported.observations).toBe(2);
    expect(JSON.parse(readFileSync(exported.path, "utf8"))).toEqual(raw.slice(0, 2));
    expect(readFileSync(exported.path, "utf8")).not.toContain("secret");
    expect(statSync(exported.path).mode & 0o777).toBe(0o600);
    for (const directory of directories) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      for (const file of readdirSync(directory)) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(exportComputerObservations(directories[1], temporary()).path, "utf8"))).toEqual([raw[2]]);
  });

  it("retains snapshot error evidence but excludes endpoint wrapper metadata", () => {
    const root = temporary();
    const capture = createComputerEvaluation({ ONDRA_COMPUTER_CAPTURE_DIR: root }).capture!;
    const error = { version: "2.6", command: "snapshot", ok: false, error: { code: "DENIED", message: "permission denied", disposition: { delivery: "not_delivered", retry: "safe" } } };
    capture.record({ ...snapshot("s1"), bootNonce: "never-record", ssh: "never-record" });
    capture.record(error);
    const result = exportComputerObservations(segments(root)[0], temporary());
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual([snapshot("s1"), error]);
    expect(readFileSync(result.path, "utf8")).not.toContain("never-record");
    expect(() => capture.record({ version: 1, result: snapshot("s1"), bootNonce: "never-record" })).toThrow("Computer observation capture failed");
    expect(() => capture.record(ok("launch", { secret: "never-record" }))).toThrow("Computer observation capture failed");
  });

  it("rejects unsafe or noncanonical capture roots without exposing paths", () => {
    const root = temporary();
    const publicDir = join(root, "public-private-name");
    mkdirSync(publicDir, { mode: 0o755 });
    const alias = join(root, "alias");
    symlinkSync(root, alias);
    for (const path of [publicDir, alias, "relative", join(root, "missing-private-name"), root + "/../" + root.split("/").at(-1)]) {
      expect(() => createComputerEvaluation({ ONDRA_COMPUTER_CAPTURE_DIR: path })).toThrow(/^Invalid computer evaluation configuration$/);
    }
  });

  it.each(["symlink", "hardlink", "permissions", "gap", "invalid", "destination"])("refuses unsafe export (%s) without copying payloads", fault => {
    const root = temporary();
    const capture = createComputerEvaluation({ ONDRA_COMPUTER_CAPTURE_DIR: root }).capture!;
    capture.record(snapshot("s1"));
    const source = segments(root)[0];
    const file = join(source, readdirSync(source)[0]);
    const destination = temporary();
    if (fault === "symlink") { rmSync(file); symlinkSync(join(root, "unread-secret"), file); }
    if (fault === "hardlink") linkSync(file, join(root, "linked"));
    if (fault === "permissions") chmodSync(file, 0o644);
    if (fault === "gap") writeFileSync(join(source, "00000003.json"), JSON.stringify(snapshot("s3")), { mode: 0o600 });
    if (fault === "invalid") writeFileSync(file, "private invalid payload");
    if (fault === "destination") chmodSync(destination, 0o755);
    expect(() => exportComputerObservations(source, destination)).toThrow(/^Computer observation export failed$/);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("does not make refs actionable when private capture fails", async () => {
    const root = temporary();
    const options = createComputerEvaluation({ ONDRA_COMPUTER_CAPTURE_DIR: root });
    const responses = [ok("session", { session_id: "fixture" }), ok("launch", {}), snapshot("s1"), snapshot("s2")];
    const session = new ComputerSession(async () => responses.shift(), options);
    const first = await session.start("TextEdit");
    chmodSync(root, 0o755);
    await expect(session.observe()).rejects.toThrow(/^Computer observation capture failed$/);
    await expect(session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" })).rejects.toThrow("Fresh actionable");
  });
});
