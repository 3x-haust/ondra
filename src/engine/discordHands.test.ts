import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState } from "../state/store";
import { discordHands } from "./discordHands";

describe("the Discord agent's hands", () => {
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("settings", "agent", { on: true, name: "메타몽", ownerId: "1" });
    vi.spyOn(native, "discordGuilds").mockResolvedValue([{ id: "g1", name: "작업방" }] as never);
  });

  it("are its own chat's only: not the user's main, not a job", async () => {
    expect(await discordHands("captain:home~@agent", { action: "servers" })).toEqual({ servers: [{ id: "g1", name: "작업방" }] });
    expect(await discordHands("captain:home", { action: "servers" })).toHaveProperty("error");
    expect(await discordHands("captain:home~ondra", { action: "servers" })).toHaveProperty("error");
    expect(await discordHands("t123", { action: "servers" })).toHaveProperty("error");
  });
});
