// Discord primitives for the agent's own chat and jobs (extensions/discord.ts → bridge op
// "discord"). The caller chooses the action and its arguments; authorization lives here.
import { discordChannelCreate, discordChannelDelete, discordChannels, discordDelete, discordGuilds, discordHistory, discordReact, discordSend, discordSendFile, discordTyping, discordUnreact } from "../lib/native";
import { state } from "../state/store";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function discordHands(worker: string | undefined, a: Args): Promise<unknown> {
  const allowed = worker?.startsWith("captain:") ? worker.endsWith("~@agent") : !!worker && !!state.tasks.find((t) => t.id === worker)?.agent;
  if (!allowed) return { error: "only the Discord agent's own chat and jobs can use its hands" };
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
      return { sent: await discordSend(channel, text, str(a.reply_to) || undefined) };
    }
    case "history": {
      const channel = str(a.channel);
      if (!channel) return { error: "channel is needed" };
      const limit = a.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) return { error: "limit must be an integer from 1 to 50" };
      return { messages: await discordHistory(channel, str(a.before) || undefined, limit) };
    }
    case "react":
    case "unreact": {
      const channel = str(a.channel);
      const message = str(a.message);
      const emoji = str(a.emoji);
      if (!channel || !message || !emoji) return { error: "channel, message and emoji are needed" };
      await (action === "react" ? discordReact : discordUnreact)(channel, message, emoji);
      return { ok: true };
    }
    case "delete_message": {
      const channel = str(a.channel);
      const message = str(a.message);
      if (!channel || !message) return { error: "channel and message are needed" };
      await discordDelete(channel, message);
      return { ok: true };
    }
    case "send_file": {
      const channel = str(a.channel);
      const path = str(a.path);
      if (!channel || !path) return { error: "channel and path are needed" };
      return { sent: await discordSendFile(channel, path, typeof a.text === "string" ? a.text : undefined) };
    }
    case "typing": {
      const channel = str(a.channel);
      if (!channel) return { error: "channel is needed" };
      await discordTyping(channel);
      return { ok: true };
    }
  }
  return { error: `unknown action ${action}: servers, channels, create, delete, send, history, react, unreact, delete_message, send_file, typing` };
}
