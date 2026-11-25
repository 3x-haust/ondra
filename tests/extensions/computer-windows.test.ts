import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerHostHelper } from "../../extensions/lib/computer-host";
import computer from "../../extensions/computer";

function windowsTool() {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    let tool: any;
    computer({ on(event: string, fn: () => void) { if (event === "session_start") fn(); }, registerTool(t: any) { tool = t; } });
    return tool;
  } finally { Object.defineProperty(process, "platform", platform); }
}

describe("Windows computer tool", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("attaches without launch fallback, resolves the observed list ref and prepares before scrolling", async () => {
    vi.stubEnv("ONDRA_COMPUTER_HOST", "1"); vi.stubEnv("ONDRA_COMPUTER_HOST_BIN", process.execPath);
    vi.stubEnv("APP_WORKER_ID", "unit"); vi.stubEnv("APP_ARTIFACTS_DIR", mkdtempSync(join(tmpdir(), "ondra-uia-")));
    const tree = { id: "win", role: "AXWindow", children: [{ id: "area-3", role: "AXScrollArea", value: "Item 1" }] };
    vi.spyOn(ComputerHostHelper.prototype, "start").mockImplementation(() => undefined);
    const request = vi.spyOn(ComputerHostHelper.prototype, "request").mockImplementation(async op => {
      if (op === "launch") return { pid: 91, mode: "attached:uia" };
      if (op === "prepare") return { required: false };
      return { tree };
    });
    const t = windowsTool();
    const start = {action:"start", app:"Viewer.exe"};
    await expect(t.execute("1", start)).rejects.toThrow("APPROVAL_UNAVAILABLE");
    const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ui = {hasUI:true, ui:{confirm}};
    await expect(t.execute("1", start, undefined, undefined, ui)).rejects.toThrow("APPROVAL_DENIED");
    expect(request.mock.calls.map(c => c[0])).toEqual(["launch", "release", "launch", "release"]);
    request.mockClear();
    expect((await t.execute("1", start, undefined, undefined, ui)).content[0].text).toContain('Attached to running Viewer.exe, pid 91.\nscreen h1:');
    expect(confirm.mock.calls[1][1]).toContain("Viewer.exe (PID 91)");
    await t.execute("2", {action:"act", input:{kind:"scroll", ref:2, direction:"up"}});
    await t.execute("3", {action:"stop"});
    expect(request.mock.calls.map(c => c[0])).toEqual(["launch", "observe", "prepare", "act", "release"]);
    expect(request.mock.calls[2][1]).toEqual({pid:91, action:{kind:"scroll", ref:"area-3", direction:"up", amount:1}});
    expect(request.mock.calls[3][1]).toEqual(request.mock.calls[2][1]);
  });
  it("advertises only the bounded local Windows surface", () => {
    const t = windowsTool();
    expect(t.parameters.properties.action.enum).toEqual(["start", "observe", "act", "stop"]);
    expect(t.description).toContain("UI Automation");
  });
  it.each([{ action: "look" }, { action: "targets", app: "x.exe" }, { action: "run", app: "x.exe", flow: "x" },
    { action: "act", input: { kind: "fill-secret", secret: "A", ref: 1 } },
    { action: "act", steps: [{ kind: "scroll", ref: 1, direction: "up" }, { kind: "press", key: "return" }] },
    { action: "act", input: { kind: "scroll", direction: "up", x: 1, y: 1 } },
    { action: "start", app: "C:\\bin\\app.exe" }])("refuses unsupported calls before attaching: %j", async input => {
    await expect(windowsTool().execute("1", input)).rejects.toThrow("WINDOWS_UNSUPPORTED");
  });
});
