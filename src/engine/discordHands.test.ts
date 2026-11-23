import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState } from "../state/store";
import type { Task } from "../state/types";
import { discordHands } from "./discordHands";

const ownChat = "captain:home~@agent";
const job = (id: string, more: Partial<Task> = {}) => ({ id, ...more }) as Task;

describe("the Discord agent's hands", () => {
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("settings", "agent", { on: true, name: "메타몽", ownerId: "1" });
    vi.spyOn(native, "discordGuilds").mockResolvedValue([{ id: "g1", name: "작업방" }]);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([ownChat, "agent-job", "agent-child"])("allows its own chat and actual agent tasks: %s", async (worker) => {
    setState("tasks", [job("agent-job", { agent: { channel: "c1" } }), job("agent-child", { parentId: "agent-job", agent: { channel: "c1" } })]);
    expect(await discordHands(worker, { action: "servers" })).toEqual({ servers: [{ id: "g1", name: "작업방" }] });
    expect(native.discordGuilds).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "captain:home", "captain:home~ondra", "plain-job", "plain-child", "missing", "missing~@agent"])("rejects non-agent workers before calling native: %s", async (worker) => {
    setState("tasks", [job("plain-job"), job("agent-job", { agent: {} }), job("plain-child", { parentId: "agent-job" })]);
    expect(await discordHands(worker, { action: "servers" })).toHaveProperty("error");
    expect(native.discordGuilds).not.toHaveBeenCalled();
  });

  it.each([ownChat, "agent-job", "agent-child"])("rejects %s when the agent is off", async (worker) => {
    setState("tasks", [job("agent-job", { agent: {} }), job("agent-child", { parentId: "agent-job", agent: {} })]);
    setState("settings", "agent", "on", false);
    expect(await discordHands(worker, { action: "servers" })).toHaveProperty("error");
    expect(native.discordGuilds).not.toHaveBeenCalled();
  });

  it("lists the selected server's channels", async () => {
    const channels = [{ id: "c1", name: "work", kind: "text" }];
    const call = vi.spyOn(native, "discordChannels").mockResolvedValue(channels);
    expect(await discordHands(ownChat, { action: "channels", server: "g1" })).toEqual({ channels });
    expect(call).toHaveBeenCalledExactlyOnceWith("g1");
  });

  it.each([undefined, true, false])("keeps channel creation private unless explicitly public: %s", async (private_) => {
    const created = { id: "c2", name: "work", kind: "text" };
    const call = vi.spyOn(native, "discordChannelCreate").mockResolvedValue(created);
    expect(await discordHands(ownChat, { action: "create", server: "g1", name: "work", category: "cat", topic: "topic", private: private_ })).toEqual({ created, private: private_ !== false });
    expect(call).toHaveBeenCalledExactlyOnceWith("g1", "work", { kind: "text", category: "cat", topic: "topic", only: private_ === false ? [] : ["1"] });
  });

  it("deletes only the selected channels and reports individual failures", async () => {
    const call = vi.spyOn(native, "discordChannelDelete").mockResolvedValue().mockRejectedValueOnce(new Error("no permission"));
    expect(await discordHands(ownChat, { action: "delete", channels: ["c1", "c2"] })).toEqual({ deleted: ["c2"], failed: { c1: "no permission" } });
    expect(call.mock.calls).toEqual([["c1"], ["c2"]]);
  });

  it.each([undefined, "chosen-message"])("sends the model's text and reply choice without extra actions: %s", async (reply_to) => {
    const send = vi.spyOn(native, "discordSend").mockResolvedValue(["sent"]);
    const react = vi.spyOn(native, "discordReact").mockResolvedValue();
    const typing = vi.spyOn(native, "discordTyping").mockResolvedValue();
    expect(await discordHands(ownChat, { action: "send", channel: "chosen-channel", text: "고쳤어요\n확인해 주세요", reply_to })).toEqual({ sent: ["sent"] });
    expect(send).toHaveBeenCalledExactlyOnceWith("chosen-channel", "고쳤어요\n확인해 주세요", reply_to);
    expect(react).not.toHaveBeenCalled();
    expect(typing).not.toHaveBeenCalled();
  });

  it.each([{}, { before: "m1", limit: 7 }, { limit: 1 }, { limit: 50 }])("reads history using only the chosen pagination: %j", async (options) => {
    const messages: native.DiscordMessage[] = [{ id: "m0", channel: "c1", author: { id: "u1", name: "user", bot: false }, content: "hello", mentions: [], files: [], at: "2026-01-01T00:00:00Z" }];
    const call = vi.spyOn(native, "discordHistory").mockResolvedValue(messages);
    expect(await discordHands(ownChat, { action: "history", channel: "c1", ...options })).toEqual({ messages });
    expect(call).toHaveBeenCalledExactlyOnceWith("c1", options.before, options.limit);
  });

  it.each(["react", "unreact"])("%s uses the chosen message and emoji", async (action) => {
    const call = vi.spyOn(native, action === "react" ? "discordReact" : "discordUnreact").mockResolvedValue();
    expect(await discordHands(ownChat, { action, channel: "c1", message: "m1", emoji: "custom:123" })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledExactlyOnceWith("c1", "m1", "custom:123");
  });

  it("deletes a selected message, not its channel", async () => {
    const call = vi.spyOn(native, "discordDelete").mockResolvedValue();
    const channel = vi.spyOn(native, "discordChannelDelete").mockResolvedValue();
    expect(await discordHands(ownChat, { action: "delete_message", channel: "c1", message: "m1" })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledExactlyOnceWith("c1", "m1");
    expect(channel).not.toHaveBeenCalled();
  });

  it.each([undefined, "선택한 설명"])("sends a selected image with no generated caption: %s", async (text) => {
    const call = vi.spyOn(native, "discordSendFile").mockResolvedValue(["image"]);
    expect(await discordHands(ownChat, { action: "send_file", channel: "c1", path: "/tmp/chosen.png", text })).toEqual({ sent: ["image"] });
    expect(call).toHaveBeenCalledExactlyOnceWith("c1", "/tmp/chosen.png", text);
  });

  it("types only in the selected channel", async () => {
    const call = vi.spyOn(native, "discordTyping").mockResolvedValue();
    expect(await discordHands(ownChat, { action: "typing", channel: "c1" })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledExactlyOnceWith("c1");
  });

  it.each([
    { action: "history" },
    { action: "react", channel: "c1", message: "m1" },
    { action: "unreact", channel: "c1", emoji: "👍" },
    { action: "delete_message", channel: "c1" },
    { action: "send_file", channel: "c1" },
    { action: "typing" },
    { action: "history", channel: "c1", limit: 1.5 },
    { action: "history", channel: "c1", limit: "7" },
    { action: "history", channel: "c1", limit: 0 },
    { action: "history", channel: "c1", limit: 51 },
  ])("rejects incomplete or invalid primitive arguments: %j", async (args) => {
    const calls = [
      vi.spyOn(native, "discordHistory").mockResolvedValue([]),
      vi.spyOn(native, "discordReact").mockResolvedValue(),
      vi.spyOn(native, "discordUnreact").mockResolvedValue(),
      vi.spyOn(native, "discordDelete").mockResolvedValue(),
      vi.spyOn(native, "discordSendFile").mockResolvedValue([]),
      vi.spyOn(native, "discordTyping").mockResolvedValue(),
    ];
    expect(await discordHands(ownChat, args)).toHaveProperty("error");
    for (const call of calls) expect(call).not.toHaveBeenCalled();
  });

  it("propagates native failures instead of claiming success", async () => {
    vi.spyOn(native, "discordReact").mockRejectedValue(new Error("no permission"));
    await expect(discordHands(ownChat, { action: "react", channel: "c1", message: "m1", emoji: "👍" })).rejects.toThrow("no permission");
  });
});
