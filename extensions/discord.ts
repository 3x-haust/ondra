// The Discord agent's own hands, for main (the agent is main: Settings › 에이전트):
//   discord → the servers it is in, their channels, make (private by default) or remove a channel,
//             say something in one.
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
  if (!URL_ || !TOKEN || !WORKER || !MAIN) return;
  pi.registerTool({
    name: "discord",
    label: "Discord",
    description:
      "Your own hands on Discord, as the user's agent there (Settings › 에이전트): servers → the servers you are in; channels {server} → its channels and categories (and the current work channel); create {server, name, kind?: text|category, category?, topic?, private?: default true = only the user and you see it}; delete {channel | channels: [...]}; send {channel, text}. Deleting a channel can't be undone: delete only what the user named or agreed to (list them first when they said it loosely, like \"필요없는 채널\").",
    promptSnippet: "Your hands on the user's Discord server: list, make or remove channels, post in one",
    parameters: Type.Object({
      action: Type.String({ description: "servers | channels | create | delete | send" }),
      server: Type.Optional(Type.String()),
      channel: Type.Optional(Type.String()),
      channels: Type.Optional(Type.Array(Type.String())),
      name: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      topic: Type.Optional(Type.String()),
      private: Type.Optional(Type.Boolean()),
      text: Type.Optional(Type.String()),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call(p ?? {}, signal);
      if (r?.error) return out(`discord failed: ${r.error}`);
      return out(r);
    },
  });
}
