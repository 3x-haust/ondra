// Ondra's own settings as a tool, for doing what the user asks of the app itself ("에이전트 설정해줘",
// "테마 다크로", "동시 작업 3개로"): the `ondra` skill says when and how.
//   ondra_settings → read every setting the user could switch in Settings (value, where, what it
//                    takes), or change some of them. Nothing else of the app; no secret values.
// Through the app's local door (ONDRA_BRIDGE + token), as the job or as main. Without the app it
// isn't registered.
import { Type } from "typebox";

const URL_ = process.env.ONDRA_BRIDGE;
const TOKEN = process.env.ONDRA_BRIDGE_TOKEN;
const WORKER = process.env.APP_WORKER_ID;

async function call(op: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  const r = await fetch(URL_!, {
    method: "POST",
    headers: { "content-type": "application/json", "x-token": TOKEN! },
    body: JSON.stringify({ op, worker: WORKER, args }),
    signal,
  });
  return r.json();
}
const out = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) }], details: v });

export default function (pi: any) {
  if (!URL_ || !TOKEN || !WORKER) return;
  pi.registerTool({
    name: "ondra_settings",
    label: "Ondra settings",
    // reached through use, in main as in a job: not declared up front
    exposure: "deferred",
    description:
      "Read or change Ondra's own settings for the user, the ones they could switch in Settings themselves: theme, language, default permission, parallel jobs, worktrees, auto memory, app checks, auto-merging checked fixes, PR review follow-up, GitHub write, sounds, telemetry, and the Discord agent (agent.on, agent.name, agent.ownerId, agent.space, agent.others, agent.channels, agent.voice, agent.account, agent.token). Read first to see each key's value, where it is in Settings and what it takes. agent.token takes the NAME of a saved secret (Settings › 시크릿); the value moves inside the app and is never shown. Change only what the user asked for.",
    parameters: Type.Object({
      changes: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: 'settings to change, key → value, e.g. {"agent.token":"DISCORD_BOT_TOKEN","agent.on":true}; leave out to read them all' })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const changes = p?.changes && Object.keys(p.changes).length ? p.changes : undefined;
      const r = await call(changes ? "settings_write" : "settings_read", changes ? { changes } : {}, signal);
      if (r?.error) return out(`ondra_settings failed: ${r.error}`);
      return out(changes ? r.results : r.settings);
    },
  });
  pi.registerTool({
    name: "services",
    label: "Services",
    exposure: "deferred",
    description:
      "Connect services (Gmail, Google Calendar/Drive, Slack, Notion, Linear, Sentry, or any MCP server by address or command) to this workspace for the user, as in Settings › 서비스: list (what is connected and its state, and the presets) | connect {preset or name, url? | command?, client_id?, client_secret?: the NAME of a saved secret (Settings › 시크릿), never its value} adds it and opens the sign-in in the user's browser, waiting until they finish | sign_in {name} | on / off {name} | remove {name}. Google and Slack take only the user's own OAuth app: if its id or secret isn't there, say what to make (connect without them tells how) and ask for the client id and for the secret to be saved in Settings › 시크릿. A connected service's tools come through use (mcp__<service>), from main's next message and in new jobs.",
    parameters: Type.Object({
      action: Type.String({ description: "list | connect | sign_in | on | off | remove" }),
      preset: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      command: Type.Optional(Type.String({ description: "a command run on this Mac that speaks MCP over stdio, e.g. npx -y <package>" })),
      client_id: Type.Optional(Type.String()),
      client_secret: Type.Optional(Type.String({ description: "the name of a saved secret" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("services", p ?? {}, signal);
      if (r?.error) return out(`services failed: ${r.error}${r.how ? `\n${r.how} (${r.link})` : ""}`);
      return out(r);
    },
  });
}
