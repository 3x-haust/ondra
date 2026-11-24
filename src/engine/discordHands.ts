// The Discord agent's own hands on the server, for its chat (extensions/discord.ts → bridge op
// "discord"): the common moves by name (servers, channels, making or removing a channel, saying
// something with buttons, menus, embeds, polls or files, replying, editing, reacting, reading,
// deleting, answering a slash command), and "api" for anything else a bot's code can do.
import { discordApi, discordChannelCreate, discordChannelDelete, discordChannels, discordDelete, discordGuilds, discordHistory, discordInteractionReply, discordReact, discordSend, discordUnreact } from "../lib/native";
import { state } from "../state/store";
import { botUserId } from "./discord";

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
/** a message body from its parts: text, buttons and menus (components), embeds, a poll, a reply */
function bodyOf(a: Args): Record<string, unknown> {
  const b: Record<string, unknown> = { allowed_mentions: a.ping === true ? { parse: ["users", "roles"] } : { parse: [] } };
  if (typeof a.text === "string") b.content = a.text;
  for (const k of ["components", "embeds", "poll", "flags"] as const) if (a[k] !== undefined) b[k] = a[k];
  if (str(a.reply_to)) b.message_reference = { message_id: str(a.reply_to), fail_if_not_exists: false };
  return b;
}
/** what Discord gives back, without credentials (a new webhook's token stays out of the chat) */
export function noTokens(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(noTokens);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "token" && k !== "client_secret").map(([k, x]) => [k, noTokens(x)]));
}
const rich = (a: Args) => ["components", "embeds", "poll", "files", "reply_to", "flags"].some((k) => a[k] !== undefined) || a.ping === true;

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
      if (!channel || (!text && !rich(a))) return { error: "channel and text (or components, embeds, poll, files) are needed" };
      // plain words: split at 2000 characters; with more, one message as Discord takes it
      if (!rich(a)) return { sent: await discordSend(channel, text) };
      const files = list(a.files);
      const m = await discordApi("POST", `/channels/${channel}/messages`, bodyOf(a), files.length ? files : undefined);
      return { sent: [m?.id].filter(Boolean) };
    }
    case "edit": {
      const channel = str(a.channel);
      const message = str(a.message);
      if (!channel || !message) return { error: "channel and message are needed" };
      const m = await discordApi("PATCH", `/channels/${channel}/messages/${message}`, bodyOf(a));
      return { edited: m?.id };
    }
    case "react":
    case "unreact": {
      const channel = str(a.channel);
      const message = str(a.message);
      const emoji = str(a.emoji);
      if (!channel || !message || !emoji) return { error: "channel, message and emoji are needed" };
      await (action === "react" ? discordReact : discordUnreact)(channel, message, emoji);
      return { [action === "react" ? "reacted" : "unreacted"]: emoji };
    }
    case "respond": {
      const id = str(a.interaction);
      if (!id) return { error: "interaction is needed (the id that came with a slash command or a click)" };
      const m = await discordInteractionReply(id, bodyOf(a), a.follow_up === true);
      return { sent: [m?.id].filter(Boolean) };
    }
    case "api": {
      const method = str(a.method).toUpperCase() || "GET";
      const path = str(a.path);
      if (!path.startsWith("/")) return { error: "path is a path under https://discord.com/api/v10, like /channels/<id>/pins" };
      const files = list(a.files);
      return { result: noTokens(await discordApi(method, path, a.body, files.length ? files : undefined)) };
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
  return { error: `unknown action ${action}: servers, channels, create, delete, send, edit, react, unreact, read, delete_messages, respond, api` };
}
