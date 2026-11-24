// The Discord agent's own hands, for main (the agent is main: Settings › 에이전트):
//   discord → everything a bot can do: channels, messages with buttons, menus, embeds, polls and
//             files, edits, reactions, reading, deleting, slash commands, and any other bot API call.
// Through the app's local door (ONDRA_BRIDGE + token). Main only: a job never gets it.
import { Type } from "typebox";

const URL_ = process.env.ONDRA_BRIDGE;
const TOKEN = process.env.ONDRA_BRIDGE_TOKEN;
const WORKER = process.env.APP_WORKER_ID;
const MAIN = process.env.ONDRA_MAIN === "1";

async function call(args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const r = await fetch(URL_!, {
    method: "POST",
    headers: { "content-type": "application/json", "x-token": TOKEN! },
    body: JSON.stringify({ op: "discord", worker: WORKER, args }),
    signal,
  });
  return r.json();
}
const out = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], details: v });

export default function (pi: any) {
  // the Discord agent's own chat only (captain:<space>~@agent), not the user's main
  if (!URL_ || !TOKEN || !WORKER || !MAIN || !WORKER.endsWith("~@agent")) return;
  pi.registerTool({
    name: "discord",
    label: "Discord",
    description:
      "Your own hands on Discord, as the user's agent there (Settings › 에이전트), with everything a bot can do. servers → the servers you are in; channels {server} → its channels and categories; create {server, name, kind?: text|category, category?, topic?, private?: default true = only the user and you see it}; delete {channel | channels: [...]} removes whole channels; send {channel, text?, components?, embeds?, poll?, files?: local paths, reply_to?: a message id, ping?: true lets mentions notify} → posts (buttons and select menus are Discord message components: action rows {type:1} holding buttons {type:2, style 1-4, label, custom_id} or link buttons {style:5, url}, or a select {type:3, custom_id, options}); edit {channel, message, text?, components?, embeds?} your message (components: [] takes buttons away); react / unreact {channel, message, emoji: a unicode emoji or name:id}; read {channel, limit?: 1-50, before?} → recent messages, oldest first (id, at, from, fromId, you: true on your own, text); delete_messages {channel, message | messages: [...up to 100]}; respond {interaction, text?, components?, embeds?, follow_up?} answers a slash command (its 'thinking…' becomes your answer) or follows up a click; become (only while you are 메타몽) {name, picture?: the web address (https) of their picture, minutes?: how long it holds (default 30, at most 240)} turns you into someone: what you say till then goes out under their name and picture (only those messages; your own and what you said before stay as they were) and you pop back on your own when the time is up; back {} pops back now; api {method, path, body?, files?} → any other call on https://discord.com/api/v10 (pins, threads, roles, members, permissions, scheduled events, webhooks, slash command registration under /applications/<your id>/commands…), as a bot's code would. A click on one of your buttons, a pick in your menus or a slash command comes to you as words from whoever did it, with the custom_id or command you set. Files with keys or sign-ins never go up. Deleting, kicking, banning and changing roles or permissions can't be undone: do them only when the user told you to (list what you'd touch first when they said it loosely), and of messages delete only your own unless the user named someone else's.",
    promptSnippet: "Your hands on the user's Discord server, everything a bot can do: channels, messages with buttons, menus, embeds, polls and files, replies, edits, reactions, reading, deleting, slash commands, and any other bot API call",
    parameters: Type.Object({
      action: Type.String({ description: "servers | channels | create | delete | send | edit | react | unreact | read | delete_messages | respond | become | back | api" }),
      picture: Type.Optional(Type.String()),
      minutes: Type.Optional(Type.Number()),
      server: Type.Optional(Type.String()),
      channel: Type.Optional(Type.String()),
      channels: Type.Optional(Type.Array(Type.String())),
      name: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      topic: Type.Optional(Type.String()),
      private: Type.Optional(Type.Boolean()),
      text: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      messages: Type.Optional(Type.Array(Type.String())),
      limit: Type.Optional(Type.Number()),
      before: Type.Optional(Type.String()),
      emoji: Type.Optional(Type.String()),
      reply_to: Type.Optional(Type.String()),
      ping: Type.Optional(Type.Boolean()),
      components: Type.Optional(Type.Array(Type.Any())),
      embeds: Type.Optional(Type.Array(Type.Any())),
      poll: Type.Optional(Type.Any()),
      flags: Type.Optional(Type.Number()),
      files: Type.Optional(Type.Array(Type.String())),
      interaction: Type.Optional(Type.String()),
      follow_up: Type.Optional(Type.Boolean()),
      method: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      body: Type.Optional(Type.Any()),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call(p ?? {}, signal);
      if (r?.error) return out(`discord failed: ${r.error}`);
      return out(r);
    },
  });
}
