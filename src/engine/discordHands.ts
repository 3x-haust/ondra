// The Discord agent's own hands on the server, for its chat (extensions/discord.ts → bridge op
// "discord"): which servers it is in, their channels, making or removing a channel, saying
// something in one, reading a channel's recent messages and deleting messages. The agent's chat is Ondra's main with its own session, so a request like
// "필요없는 채널 지우고 채널 하나 만들어서 거기서 일해" is its own work with these.
import { discordChannelCreate, discordChannelDelete, discordChannels, discordDelete, discordGuilds, discordHistory, discordSend } from "../lib/native";
import { state } from "../state/store";
import { botUserId } from "./discord";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function discordHands(worker: string | undefined, a: Args): Promise<unknown> {
  // a job doesn't speak on the user's server, and nothing runs while the agent is off;
  // the agent's own chat only ("captain:home~@agent"): the user's main in the app never posts to Discord
  if (!worker?.startsWith("captain:") || !worker.endsWith("~@agent")) return { error: "only the Discord agent's own chat can use its hands" };
  const agent = state.settings.agent;
  if (!agent?.on) return { error: "the Discord agent is off (Settings › 에이전트)" };
  const action = str(a.action);
  switch (action) {
    case "servers":
      return { servers: await discordGuilds() };
    case "channels": {
      const guild = str(a.server);
      if (!guild) return { error: "server is empty: list the servers first" };
      return { channels: await discordChannels(guild) };
    }
    case "create": {
      const guild = str(a.server);
      const name = str(a.name);
      if (!guild || !name) return { error: "server and name are needed" };
      // private by default: seen by the user and the bot only
      const only = a.private === false ? [] : agent.ownerId ? [agent.ownerId] : [];
      const made = await discordChannelCreate(guild, name, { kind: a.kind === "category" ? "category" : "text", category: str(a.category) || undefined, topic: str(a.topic) || undefined, only });
      return { created: made, private: only.length > 0 };
    }
    case "delete": {
      const ids = (Array.isArray(a.channels) ? a.channels : [a.channel]).map(str).filter(Boolean);
      if (!ids.length) return { error: "channel (or channels) is empty" };
      const done: string[] = [];
      const failed: Record<string, string> = {};
      for (const id of ids.slice(0, 30)) {
        try {
          await discordChannelDelete(id);
          done.push(id);
        } catch (e) {
          failed[id] = e instanceof Error ? e.message : String(e);
        }
      }
      return { deleted: done, ...(Object.keys(failed).length ? { failed } : {}) };
    }
    case "send": {
      const channel = str(a.channel);
      const text = str(a.text);
      if (!channel || !text) return { error: "channel and text are needed" };
      return { sent: await discordSend(channel, text) };
    }
    case "read": {
      const channel = str(a.channel);
      if (!channel) return { error: "channel is empty" };
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      const me = botUserId();
      const list = await discordHistory(channel, str(a.before) || undefined, limit);
      return {
        messages: list.map((m) => ({
          id: m.id,
          at: m.at,
          from: m.author.name,
          fromId: m.author.id,
          ...(me && m.author.id === me ? { you: true } : {}),
          ...(m.reply_msg ? { replyTo: m.reply_msg } : {}),
          text: m.content,
          ...(m.files.length ? { files: m.files.length } : {}),
        })),
      };
    }
    case "delete_messages": {
      const channel = str(a.channel);
      const ids = (Array.isArray(a.messages) ? a.messages : [a.message]).map(str).filter(Boolean);
      if (!channel || !ids.length) return { error: "channel and message (or messages) are needed" };
      if (ids.length > 100) return { error: "at most 100 messages at a time" };
      const done: string[] = [];
      const failed: Record<string, string> = {};
      for (const id of ids) {
        try {
          await discordDelete(channel, id);
          done.push(id);
        } catch (e) {
          failed[id] = e instanceof Error ? e.message : String(e);
        }
      }
      return { deleted: done, ...(Object.keys(failed).length ? { failed } : {}) };
    }
  }
  return { error: `unknown action ${action}: servers, channels, create, delete, send, read, delete_messages` };
}
