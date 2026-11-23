// Discord primitives through the app's local door (ONDRA_BRIDGE + token).
// The bridge authorizes the agent's own chat and jobs against the app's state.
import { Type } from "typebox";

const URL_ = process.env.ONDRA_BRIDGE;
const TOKEN = process.env.ONDRA_BRIDGE_TOKEN;
const WORKER = process.env.APP_WORKER_ID;

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
  if (!URL_ || !TOKEN || !WORKER) return;
  if (WORKER.startsWith("captain:") && !WORKER.endsWith("~@agent")) return;
  pi.registerTool({
    name: "discord",
    label: "Discord",
    description:
      "Your own hands on Discord, as the user's agent there (Settings › 에이전트): servers → the servers you are in; channels {server} → its channels and categories; create {server, name, kind?: text|category, category?, topic?, private?: default true = only the user and you see it}; delete {channel | channels: [...]} → delete channels; send {channel, text, reply_to?: message ID}; history {channel, before?: message ID, limit?: 1–50, default 20} → messages oldest first; react / unreact {channel, message, emoji} → add/remove your reaction (Unicode or name:id); delete_message {channel, message}; send_file {channel, path, text?} → upload a local PNG/JPEG/GIF/WebP image up to 8 MB with an optional caption; typing {channel} → one typing indication. Choose when and where to act from the user's instructions and memory. Deleting a channel can't be undone: delete only what the user named or agreed to (list them first when they said it loosely, like \"필요없는 채널\").",
    promptSnippet: "Your hands on Discord: channels, messages, history, reactions, images and typing",
    parameters: Type.Object({
      action: Type.String({ description: "servers | channels | create | delete | send | history | react | unreact | delete_message | send_file | typing" }),
      server: Type.Optional(Type.String()),
      channel: Type.Optional(Type.String()),
      channels: Type.Optional(Type.Array(Type.String())),
      name: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      topic: Type.Optional(Type.String()),
      private: Type.Optional(Type.Boolean()),
      text: Type.Optional(Type.String()),
      reply_to: Type.Optional(Type.String({ description: "Message ID to reply to when sending" })),
      before: Type.Optional(Type.String({ description: "Read history before this message ID" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      message: Type.Optional(Type.String({ description: "Message ID for a reaction or deletion" })),
      emoji: Type.Optional(Type.String({ description: "Unicode emoji or custom emoji name:id" })),
      path: Type.Optional(Type.String({ description: "Absolute path to a local image for send_file" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call(p ?? {}, signal);
      if (r?.error) return out(`discord failed: ${r.error}`);
      return out(r);
    },
  });
}
