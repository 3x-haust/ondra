import { describe, expect, it } from "vitest";
import { setState, state } from "../state/store";
import { accountFull, autoRouted, chooseAccount, hitLimit, isUsageLimit, markLimited, movesAt, spaceAccount, spareAccount } from "./tasks";

describe("accounts stay in their space", () => {
  it("never picks another space's account", () => {
    setState("accounts", [
      { id: "default", name: "개인", space: "home", providers: ["anthropic"] } as never,
      { id: "w1", name: "회사", space: "work", providers: ["openai"] } as never,
    ]);
    setState("accountPick", {});
    expect(chooseAccount("work", "")).toBe("w1");
    expect(spaceAccount("home")?.id).toBe("default");
    // a job saved with the other space's account moves to this space's
    expect(spaceAccount("work", "", "default")?.id).toBe("w1");
    setState("accounts", (l) => l.filter((a) => a.space !== "work"));
    expect(chooseAccount("work", "")).toBe("");
    expect(spaceAccount("work")).toBeUndefined();
    expect(spaceAccount("work", "", "default")).toBeUndefined();
    expect(state.accounts.length).toBe(1);
  });
});

describe("자동 routing around limits", () => {
  const acc = (id: string, providers: string[], lastUsedAt = 0) => ({ id, label: id, space: "home", providers, model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, lastUsedAt }) as never;

  it("knows the provider's limit refusals, not a full context", () => {
    expect(isUsageLimit(`429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}`)).toBe(true);
    expect(isUsageLimit("You've hit your usage limit. Upgrade to Pro")).toBe(true);
    expect(isUsageLimit("400 invalid_request_error: prompt is too long")).toBe(false);
    expect(isUsageLimit("ECONNRESET")).toBe(false);
  });

  it("new work leaves an account that hit its limit, even the warm one", () => {
    setState("accounts", [acc("a", ["anthropic"], Date.now()), acc("b", ["anthropic"], Date.now() - 1000)]);
    setState("accountPick", {});
    expect(chooseAccount("home", "")).toBe("a");
    markLimited("a");
    expect(accountFull("a")).toBe(true);
    expect(chooseAccount("home", "")).toBe("b");
  });

  it("a full job moves to an account of the same service first, and nowhere when all are full", () => {
    setState("accounts", [acc("c1", ["anthropic"]), acc("g1", ["openai-codex"]), acc("c2", ["anthropic"])]);
    setState("accountPick", {});
    expect(spareAccount("home", "c1")).toBe("c2");
    markLimited("c2");
    expect(spareAccount("home", "c1")).toBe("g1");
    markLimited("g1");
    expect(spareAccount("home", "c1")).toBeUndefined();
  });

  it("a 503 is a limit only on an account nearly out (else it is an outage, waited out)", () => {
    expect(hitLimit("503 Service Unavailable", "nobody")).toBe(false);
    expect(hitLimit("429 Too Many Requests", "nobody")).toBe(true);
  });

  it("a fresh session moves off a full account, and stays on one with room", () => {
    setState("accounts", [acc("m1", ["anthropic"]), acc("m2", ["anthropic"])]);
    setState("accountPick", {});
    expect(movesAt({ space: "home", accountId: "m1" })).toBeUndefined();
    markLimited("m1");
    expect(movesAt({ space: "home", accountId: "m1" })).toBe("m2");
    expect(movesAt({ space: "home", accountId: "m1", accountPinned: true })).toBeUndefined();
  });

  it("only work on 자동 that wasn't put on an account by hand is moved", () => {
    setState("accountPick", {});
    expect(autoRouted({ space: "home" })).toBe(true);
    expect(autoRouted({ space: "home", accountPinned: true })).toBe(false);
    setState("accountPick", { home: "c1" });
    expect(autoRouted({ space: "home" })).toBe(false);
  });
});
