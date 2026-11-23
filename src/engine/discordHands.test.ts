import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState } from "../state/store";
import * as discord from "./discord";
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

  it("read a channel's recent messages, oldest first, its own marked", async () => {
    vi.spyOn(discord, "botUserId").mockReturnValue("b1");
    const history = vi.spyOn(native, "discordHistory").mockResolvedValue([
      { id: "m1", channel: "c1", author: { id: "1", name: "주인", bot: false }, content: "지워봐", mentions: [], files: [], at: "t1" },
      { id: "m2", channel: "c1", author: { id: "b1", name: "메타몽", bot: true }, content: "-# 진행", mentions: [], reply_msg: "m1", files: [], at: "t2" },
    ]);
    expect(await discordHands("captain:home~@agent", { action: "read", channel: "c1", limit: 5, before: "m9" })).toEqual({
      messages: [
        { id: "m1", at: "t1", from: "주인", fromId: "1", text: "지워봐" },
        { id: "m2", at: "t2", from: "메타몽", fromId: "b1", you: true, replyTo: "m1", text: "-# 진행" },
      ],
    });
    expect(history).toHaveBeenCalledWith("c1", "m9", 5);
    expect(await discordHands("captain:home~@agent", { action: "read" })).toHaveProperty("error");
  });

  it("delete one message or several, saying which failed", async () => {
    const del = vi.spyOn(native, "discordDelete").mockImplementation(async (_c, id) => {
      if (id === "m3") throw "디스코드가 거절했어요 (404 Not Found): Unknown Message";
    });
    expect(await discordHands("captain:home~@agent", { action: "delete_messages", channel: "c1", message: "m1" })).toEqual({ deleted: ["m1"] });
    expect(await discordHands("captain:home~@agent", { action: "delete_messages", channel: "c1", messages: ["m2", "m3"] })).toEqual({
      deleted: ["m2"],
      failed: { m3: "디스코드가 거절했어요 (404 Not Found): Unknown Message" },
    });
    expect(del).toHaveBeenCalledWith("c1", "m2");
    expect(await discordHands("captain:home~@agent", { action: "delete_messages", messages: ["m1"] })).toHaveProperty("error");
    expect(await discordHands("captain:home~@agent", { action: "delete_messages", channel: "c1", messages: Array.from({ length: 101 }, (_, i) => `x${i}`) })).toHaveProperty("error");
    expect(del).toHaveBeenCalledTimes(3);
  });
});
