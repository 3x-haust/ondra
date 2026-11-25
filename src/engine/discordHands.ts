// The Discord agent's own hands on the server, for its chat (extensions/discord.ts → bridge op
// "discord"): the common moves by name (servers, channels, making or removing a channel, saying
// something with buttons, menus, embeds, polls or files, replying, editing, reacting, reading,
// deleting, answering a slash command), and "api" for anything else a bot's code can do.
import { discordApi, discordChannelCreate, discordChannelDelete, discordChannels, discordDelete, discordGuilds, discordHistory, discordInteractionReply, discordReact, discordSend, discordUnreact } from "../lib/native";
import { state } from "../state/store";
import { botUserId } from "./discord";
import { back, become } from "./agentForm";
import { allowed, pingsIn, tagged } from "./discordPeople";
import { localLinks, openRow } from "./discordFiles";

/**
 * Links to this Mac's files and folders in its words (a picture "![](/tmp/board.png)" too): files
 * go up with the message, folders become 📂 buttons under it, as in what main says.
 */
async function withLocal(a: Args): Promise<Args> {
  if (typeof a.text !== "string" || !/\]\(\s*<?(file:|\/|~\/)|file:\/\//i.test(a.text)) return a;
  const local = await localLinks(a.text);
  if (!local.files.length && !local.open.length) return { ...a, text: local.text };
  const rows = Array.isArray(a.components) ? a.components : [];
  return {
    ...a,
    text: local.text,
    ...(local.files.length ? { files: [...list(a.files), ...local.files] } : {}),
    ...(local.open.length && rows.length < 5 ? { components: [...rows, ...openRow(local.open)] } : {}),
  };
}

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
/** a message body from its parts: text, buttons and menus (components), embeds, a poll, a reply */
function bodyOf(a: Args): Record<string, unknown> {
  // whoever it tags by id is notified; ping: true lets roles and @everyone notify too
  const b: Record<string, unknown> = { allowed_mentions: a.ping === true ? { parse: ["users", "roles", "everyone"] } : allowed(pingsIn(str(a.text), botUserId())) };
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
      // "@name" of someone known is made their mention
      const { text: named, pings } = tagged(str(a.text), botUserId());
      if (typeof a.text === "string") a = await withLocal({ ...a, text: named });
      const text = str(a.text);
      if (!channel || (!text && !rich(a))) return { error: "channel and text (or components, embeds, poll, files) are needed" };
      // plain words: split at 2000 characters; with more, one message as Discord takes it
      if (!rich(a)) return { sent: await (pings.length ? discordSend(channel, text, undefined, pings) : discordSend(channel, text)) };
      const files = list(a.files);
      const m = await discordApi("POST", `/channels/${channel}/messages`, bodyOf(a), files.length ? files : undefined);
      return { sent: [m?.id].filter(Boolean), ...(files.length ? { attached: files.map((f) => f.split("/").pop()) } : {}) };
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
    case "become": {
      const who = str(a.name);
      if (!who) return { error: "name is who you turn into (their name or the character's)" };
      return become({ who, picture: str(a.picture) || undefined, minutes: typeof a.minutes === "number" ? a.minutes : undefined });
    }
    case "back":
      return back();
    case "api": {
      const method = str(a.method).toUpperCase() || "GET";
      const path = str(a.path);
      if (!path.startsWith("/")) return { error: "path is a path under https://discord.com/api/v10, like /channels/<id>/pins" };
      const files = list(a.files);
      return { result: noTokens(await discordApi(method, path, a.body, files.length ? files : undefined)) };
    }
    case "search": {
      const server = str(a.server);
      if (!server) return { error: "server is the server id to search in (servers lists them)" };
      const q = new URLSearchParams();
      if (str(a.from)) q.set("author_id", str(a.from));
      if (str(a.text)) q.set("content", str(a.text));
      if (str(a.channel)) q.set("channel_id", str(a.channel));
      if (typeof a.offset === "number") q.set("offset", String(Math.max(0, Math.floor(a.offset))));
      if (![...q.keys()].some((k) => k !== "offset")) return { error: "search needs from (a user id), text or channel" };
      const me = botUserId();
      // a server Discord hasn't indexed yet answers "try again in a moment": it waits and asks again
      for (let i = 0; i < 4; i++) {
        const r = (await discordApi("GET", `/guilds/${server}/messages/search?${q}`)) as { messages?: unknown[][]; total_results?: number; code?: number; retry_after?: number };
        if (Array.isArray(r?.messages) && typeof r.total_results === "number") {
          type Hit = { id: string; channel_id: string; timestamp: string; content: string; author: { id: string; username: string; global_name?: string } };
          return {
            total: r.total_results,
            messages: r.messages.map((group) => group[0] as Hit).filter(Boolean).map((m) => ({
              id: m.id, channel: m.channel_id, at: m.timestamp, from: m.author.global_name || m.author.username, fromId: m.author.id,
              ...(me && m.author.id === me ? { you: true } : {}), text: m.content,
            })),
            ...(r.total_results > r.messages.length ? { more: "offset by the number seen so far for older ones (25 a page)" } : {}),
          };
        }
        await new Promise((done) => setTimeout(done, Math.min(5, Math.max(1, Number(r?.retry_after) || 2)) * 1000));
      }
      return { error: "Discord is still building this server's search index: try search again in a minute, or read the channel further back (read with before)" };
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
          ...(me && (m.author.id === me || m.app === me) ? { you: true } : {}),
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
  return { error: `unknown action ${action}: servers, channels, create, delete, send, edit, react, unreact, read, search, delete_messages, respond, become, back, api` };
}
