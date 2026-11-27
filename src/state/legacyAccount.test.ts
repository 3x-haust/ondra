import { describe, expect, it } from "vitest";
import { accountBase, freshState, withoutEmptyLegacy } from "./store";
import type { AppState } from "./types";

const legacy = (providers: string[]) => ({ ...accountBase(), id: "default", space: "home", label: "기본", providers });
const other = { ...accountBase(), id: "acc1", space: "home", label: "개인 1", providers: ["anthropic"] };
const older = (providers: string[]): AppState => {
  const s = freshState();
  return {
    ...s,
    accounts: [legacy(providers), other],
    accountPick: { home: "default", work: "auto" },
    settings: {
      ...s.settings,
      reviewers: [{ account: "default", model: "openai-codex/gpt-6.2-astra" }, { account: "acc1", model: "" }],
      reviewersBySpace: { home: [{ account: "default", model: "" }] },
      agent: { on: true, name: "bot", space: "home", account: "default", places: [{ channel: "1", label: "#일반", space: "home", account: "default" }] } as AppState["settings"]["agent"],
    },
  };
};

describe("no built-in account", () => {
  it("a fresh install has no account until a sign-in", () => {
    expect(freshState().accounts).toEqual([]);
  });

  it("an older 기본 with no login goes, with what pointed at it", () => {
    const s = withoutEmptyLegacy(older([]));
    expect(s.accounts.map((a) => a.id)).toEqual(["acc1"]);
    expect(s.accountPick).toEqual({ work: "auto" });
    expect(s.settings.reviewers).toEqual([{ account: "acc1", model: "" }]);
    expect(s.settings.reviewersBySpace).toEqual({ home: [] });
    expect(s.settings.agent?.account).toBeUndefined();
    expect(s.settings.agent?.places?.[0].account).toBeUndefined();
  });

  it("an older 기본 that is signed in stays, named like any other account", () => {
    const s = withoutEmptyLegacy(older(["openai-codex"]));
    expect(s.accounts.map((a) => a.id)).toEqual(["default", "acc1"]);
    expect(s.accounts[0].label).toBe("");
    expect(s.accountPick?.home).toBe("default");
    expect(s.settings.reviewers?.[0].account).toBe("default");
  });

  it("a state without one is left as it is", () => {
    const s = { ...freshState(), accounts: [other] };
    expect(withoutEmptyLegacy(s)).toBe(s);
  });
});
