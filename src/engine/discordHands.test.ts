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

  it("search finds what someone said however far back, waiting while Discord still indexes the server", async () => {
    vi.useFakeTimers();
    vi.spyOn(discord, "botUserId").mockReturnValue("b1");
    const hit = { id: "m7", channel_id: "c1", timestamp: "t7", content: "ㅋㅋ 몰라 나 잠", author: { id: "783", username: "jw", global_name: "정원" } };
    const api = vi.spyOn(native, "discordApi")
      .mockResolvedValueOnce({ message: "Index not yet available. Try again later", code: 110000, retry_after: 2 } as never)
      .mockResolvedValueOnce({ total_results: 30, messages: [[hit]] } as never);
    const found = discordHands("captain:home~@agent", { action: "search", server: "g1", from: "783" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(await found).toEqual({ total: 30, messages: [{ id: "m7", channel: "c1", at: "t7", from: "정원", fromId: "783", text: "ㅋㅋ 몰라 나 잠" }], more: expect.any(String) });
    expect(api).toHaveBeenLastCalledWith("GET", "/guilds/g1/messages/search?author_id=783");
    expect(await discordHands("captain:home~@agent", { action: "search", server: "g1" })).toHaveProperty("error");
    vi.useRealTimers();
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

  it("everything else a bot can do: buttons and files, edits, reactions, a slash command's answer, any API call", async () => {
    const api = vi.spyOn(native, "discordApi").mockImplementation(async () => ({ id: "m9" }));
    const react = vi.spyOn(native, "discordReact").mockResolvedValue();
    const reply = vi.spyOn(native, "discordInteractionReply").mockResolvedValue({ id: "r1" });
    const rows = [{ type: 1, components: [{ type: 2, style: 1, label: "배포", custom_id: "deploy" }] }];
    expect(await discordHands("captain:home~@agent", { action: "send", channel: "c1", text: "할까?", components: rows, files: ["/tmp/a.png"] })).toEqual({ sent: ["m9"], attached: ["a.png"] });
    expect(api).toHaveBeenLastCalledWith("POST", "/channels/c1/messages", { content: "할까?", components: rows, allowed_mentions: { parse: [] } }, ["/tmp/a.png"]);
    // a picture on this Mac written into the words goes up with them, its words out
    vi.spyOn(native, "fsRead").mockResolvedValue({ text: "", size: 2048 } as any);
    await discordHands("captain:home~@agent", { action: "send", channel: "c1", text: "판 올렸어\n![](/tmp/metachess/board.png)", components: rows });
    expect(api).toHaveBeenLastCalledWith("POST", "/channels/c1/messages", { content: "판 올렸어", components: rows, allowed_mentions: { parse: [] } }, ["/tmp/metachess/board.png"]);
    await discordHands("captain:home~@agent", { action: "edit", channel: "c1", message: "m9", components: [] });
    expect(api).toHaveBeenLastCalledWith("PATCH", "/channels/c1/messages/m9", { components: [], allowed_mentions: { parse: [] } });
    await discordHands("captain:home~@agent", { action: "react", channel: "c1", message: "m9", emoji: "👍" });
    expect(react).toHaveBeenCalledWith("c1", "m9", "👍");
    await discordHands("captain:home~@agent", { action: "respond", interaction: "i1", text: "됨" });
    expect(reply).toHaveBeenCalledWith("i1", { content: "됨", allowed_mentions: { parse: [] } }, false);
    await discordHands("captain:home~@agent", { action: "api", method: "put", path: "/channels/c1/pins/m9" });
    expect(api).toHaveBeenLastCalledWith("PUT", "/channels/c1/pins/m9", undefined, undefined);
    expect(await discordHands("captain:home~@agent", { action: "api", path: "https://evil.example" })).toHaveProperty("error");
    api.mockResolvedValueOnce({ id: "w1", token: "SECRET", channel_id: "c1" });
    expect(await discordHands("captain:home~@agent", { action: "api", method: "POST", path: "/channels/c1/webhooks", body: { name: "x" } })).toEqual({ result: { id: "w1", channel_id: "c1" } });
  });
});
