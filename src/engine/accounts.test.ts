import { describe, expect, it } from "vitest";
import { setState, state } from "../state/store";
import { chooseAccount, spaceAccount } from "./tasks";

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
