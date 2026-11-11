import { describe, expect, it } from "vitest";
import { EVENTS_DOC, faultOf, frames, installId, modelOf, pick, PERMISSIONS, SHAPES, shape, track, uuid7, vet } from "./telemetry";
// @ts-ignore node types are not in this project: the test runs under node
import { readFileSync } from "node:fs";

const job = { kind: "job", provider: "anthropic", model: "claude-opus", effort: "high", permission: "edits", weight: "light" } as const;

describe("telemetry", () => {
  it("keeps one random id per install and says when it was made", () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    const a = installId(store);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.first).toBe(true);
    expect(installId(store)).toEqual({ id: a.id, first: false });
  });
  it("makes a session id PostHog takes (UUIDv7, time first)", () => {
    const id = uuid7(Date.UTC(2026, 10, 11));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 11));
  });
  it("shapes an event for this copy of the app", () => {
    const e = shape("view_opened", { view: "board" }, "abc", new Date("2026-11-11T00:00:00Z"));
    expect(e).toEqual({ event: "view_opened", properties: { view: "board", distinct_id: "abc", $process_person_profile: true }, timestamp: "2026-11-11T00:00:00.000Z" });
  });
  it("lets through only what a shape names", () => {
    expect(vet("job_started", { ...job, isolated: true, from_issue: false })).toBeNull();
    expect(vet("view_opened", { view: "board" })).toBeNull();
    expect(vet("telemetry_off", {})).toBeNull();
    // words have no shape to travel in
    expect(vet("job_started", { ...job, isolated: true, from_issue: false, title: "fix login" })).toMatch(/unknown property title/);
    expect(vet("job_started", { ...job, model: "my-private-model", isolated: true, from_issue: false })).toMatch(/model is not in its set/);
    expect(vet("view_opened", { view: "/Users/me/secret" })).toMatch(/view is not in its set/);
    expect(vet("job_started", { ...job, isolated: true })).toMatch(/missing from_issue/);
    expect(vet("app_active", { minutes: Number.NaN })).toMatch(/minutes is not a number/);
    expect(vet("made_up", {})).toMatch(/unknown event/);
    expect(vet("constructor", {})).toMatch(/unknown event/);
  });
  it("files a model under its provider and family", () => {
    expect(modelOf("anthropic/claude-opus-5-5")).toEqual({ provider: "anthropic", model: "claude-opus" });
    expect(modelOf("openai-codex/gpt-5.6-terra")).toEqual({ provider: "openai-codex", model: "gpt-5" });
    expect(modelOf("openrouter/meta/llama-4")).toEqual({ provider: "openrouter", model: "llama" });
    expect(modelOf("my-box/company-secret-finetune")).toEqual({ provider: "other", model: "other" });
    expect(modelOf("")).toEqual({ provider: "none", model: "none" });
    expect(modelOf(undefined)).toEqual({ provider: "none", model: "none" });
  });
  it("files a failure under why", () => {
    expect(faultOf("prompt is too long: 250000 tokens")).toBe("context_limit");
    expect(faultOf("429 rate limit exceeded")).toBe("usage_limit");
    expect(faultOf("401 Unauthorized")).toBe("auth");
    expect(faultOf("fetch failed")).toBe("network");
    expect(faultOf("엔진 종료 (코드 1)")).toBe("engine_exit");
    expect(faultOf("something else")).toBe("unknown");
    expect(faultOf(undefined)).toBe("unknown");
  });
  it("keeps a value in its set", () => {
    expect(pick(PERMISSIONS, "full", "edits")).toBe("full");
    expect(pick(PERMISSIONS, "root", "edits")).toBe("edits");
    expect(pick(PERMISSIONS, undefined, "edits")).toBe("edits");
  });
  it("cuts a stack down to file names", () => {
    const f = frames("Error: x\n    at send (tauri://localhost/assets/index-abc.js?v=1:10:5)\n    at /Users/me/app/src/a.ts:3:1\nrun@tauri://localhost/assets/b.js:7:2");
    expect(f.map((x) => `${x.function} ${x.filename}:${x.lineno}`)).toEqual(["send index-abc.js:10", "? a.ts:3", "run b.js:7"]);
    expect(JSON.stringify(f)).not.toContain("Users");
  });
  it("sends nothing outside the installed app", () => {
    let called = 0;
    const was = globalThis.fetch;
    globalThis.fetch = (() => (called++, Promise.resolve(new Response()))) as typeof fetch;
    for (let i = 0; i < 30; i++) track("view_opened", { view: "board" });
    globalThis.fetch = was;
    expect(called).toBe(0);
  });
  it("documents every event it can send", () => {
    const doc = readFileSync(EVENTS_DOC, "utf8");
    for (const name of Object.keys(SHAPES)) expect(doc, name).toContain(`\`${name}\``);
  });
});
