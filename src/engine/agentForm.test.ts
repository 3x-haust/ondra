import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; path: string; body: any }[] = [];
let hooks: { id: string; name: string; token?: string }[] = [];
let mayHook = true;
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<typeof import("../lib/native")>()),
  discordApi: async (method: string, path: string, body: any) => {
    calls.push({ method, path, body });
    if (path.endsWith("/webhooks") && !mayHook) throw new Error("403 Missing Permissions");
    if (method === "GET") return hooks;
    if (path.endsWith("/webhooks")) return { id: "w1", name: body.name, token: "tok" };
    return { id: `m${calls.length}` };
  },
}));

describe("turning into someone (Metamong)", () => {
  beforeEach(async () => {
    calls.length = 0;
    hooks = [];
    mayHook = true;
    vi.resetModules();
    vi.useFakeTimers();
    const { reconcile } = await import("solid-js/store");
    const { freshState, setState } = await import("../state/store");
    setState(reconcile(freshState()));
    setState("settings", "agent", { on: true, name: "메타몽" });
  });
  afterEach(() => vi.useRealTimers());

  it("only what it says while turned goes out under their name and picture; its own account is never touched", async () => {
    const { become, formNote, sayAsForm } = await import("./agentForm");
    const { state } = await import("../state/store");
    expect(await sayAsForm("c1", "나 메타몽")).toBeUndefined();
    become({ who: "피카츄", picture: "https://x/p.png", minutes: 10 });
    expect(formNote(state.settings.agent)).toContain("피카츄(으)로 변신해 있어 (10분쯤 남음)");
    expect(await sayAsForm("c1", "피카피카")).toEqual(["m3"]);
    expect(await sayAsForm("c1", "피카츄!")).toEqual(["m4"]);
    expect(calls.map((c) => `${c.method} ${c.path.replace("/tok?", "/…?")}`)).toEqual(["GET /channels/c1/webhooks", "POST /channels/c1/webhooks", "POST /webhooks/w1/…?wait=true", "POST /webhooks/w1/…?wait=true"]);
    expect(calls[2].body).toEqual({ content: "피카피카", username: "피카츄", avatar_url: "https://x/p.png", allowed_mentions: { parse: [] } });
    expect(calls.some((c) => c.path.includes("/members/@me") || c.path === "/users/@me")).toBe(false);
  });

  it("uses the webhook it already made there", async () => {
    const { become, sayAsForm } = await import("./agentForm");
    hooks = [{ id: "other", name: "누구 거" }, { id: "w9", name: "Ondra 변신", token: "t9" }];
    become({ who: "피카츄" });
    await sayAsForm("c1", "피카");
    expect(calls.map((c) => c.method + " " + c.path.split("/").slice(0, 3).join("/"))).toEqual(["GET /channels/c1", "POST /webhooks/w9"]);
    expect(calls[1].body.avatar_url).toBeUndefined();
  });

  it("where the channel won't let it, it says its words as itself (half a turn)", async () => {
    const { become, sayAsForm } = await import("./agentForm");
    mayHook = false;
    become({ who: "피카츄" });
    expect(await sayAsForm("c1", "피카")).toBeUndefined();
  });

  it("a picture is a web address, a name Discord takes", async () => {
    const { become } = await import("./agentForm");
    expect(become({ who: "피카츄", picture: "~/p.png" })).toHaveProperty("error");
    expect(become({ who: "discord bot" })).toHaveProperty("error");
  });

  it("pops back on its own when the time is up", async () => {
    const { become, formNote, sayAsForm } = await import("./agentForm");
    const { state } = await import("../state/store");
    become({ who: "피카츄", minutes: 1 });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(state.settings.agent?.form).toBeUndefined();
    expect(formNote(state.settings.agent)).toBe("");
    expect(await sayAsForm("c1", "나 메타몽")).toBeUndefined();
  });
});
