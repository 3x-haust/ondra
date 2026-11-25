// Connected services (Gmail, Slack, Notion …): MCP servers, each workspace its own. A space's
// servers and their sign-ins live in its own folder (the native side gives every engine of the
// space `PI_MCP_DIR`), so the work space's Slack is never the home space's. Its main chat and jobs
// load the engine's MCP extension when the space has any; the model reaches their tools through
// `use` (extensions/use.ts), so none of them is declared up front.
import { mcpCli, mcpSave, mcpSecretDelete, mcpSecretFrom, mcpSecretSet, mcpServers } from "../lib/native";

export type Server = {
  type?: "http" | "sse";
  url?: string;
  command?: string;
  args?: string[];
  oauth?: { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number };
  exposure?: string;
  enabled?: boolean;
  description?: string;
};

/** A service to connect with one click: its server, and whether it needs the user's own OAuth app. */
export type Preset = {
  id: string;
  name: string;
  url: string;
  /** what it gives the model */
  about: string;
  /** Google and Slack take no client they don't know: the user's own app's id and secret */
  ownApp?: { help: string; link: string; scope?: string };
};

const google = (scopes: string[]) => ({
  help: "Google Cloud 콘솔에서 이 서비스의 MCP를 켜고, OAuth 클라이언트(데스크톱 앱)를 만들어 ID와 시크릿을 넣어요. 지금은 Google의 개발자 프리뷰예요.",
  link: "https://developers.google.com/workspace/guides/configure-mcp-servers",
  scope: scopes.map((s) => `https://www.googleapis.com/auth/${s}`).join(" "),
});

export const PRESETS: Preset[] = [
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", about: "페이지·데이터베이스 찾기, 읽기, 쓰기" },
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", about: "이슈·프로젝트 찾기, 만들기, 고치기" },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", about: "에러·이슈 보기" },
  {
    id: "slack",
    name: "Slack",
    url: "https://mcp.slack.com/mcp",
    about: "채널·메시지 찾기, 읽기, 보내기",
    ownApp: { help: "api.slack.com/apps에서 앱을 만들고 MCP를 켠 뒤, 리디렉션 URL에 http://127.0.0.1:8788/callback을 넣고 Client ID와 Secret을 넣어요.", link: "https://docs.slack.dev/ai/slack-mcp-server/" },
  },
  { id: "gmail", name: "Gmail", url: "https://gmailmcp.googleapis.com/mcp/v1", about: "메일 찾기, 읽기, 라벨, 초안", ownApp: google(["gmail.readonly", "gmail.compose", "gmail.modify"]) },
  {
    id: "google-calendar",
    name: "Google Calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    about: "일정 보기, 빈 시간 찾기, 일정 만들기",
    ownApp: google(["calendar.calendarlist.readonly", "calendar.events.freebusy", "calendar.events.readonly", "calendar.events"]),
  },
  { id: "google-drive", name: "Google Drive", url: "https://drivemcp.googleapis.com/mcp/v1", about: "파일 찾기, 읽기, 올리기", ownApp: google(["drive.readonly", "drive.file"]) },
];

/** Slack registers one redirect URL with its app, so its sign-in listens on a fixed port */
const FIXED_PORT: Record<string, number> = { slack: 8788 };

/** a server name the engine takes (letters, digits, - and _) */
export const serverName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** the env var its client secret reaches the engine in (see src-tauri/src/mcp.rs) */
export const secretVar = (name: string) => `ONDRA_MCP_SECRET_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;

export const readServers = (space: string): Promise<Record<string, Server>> => mcpServers(space).catch(() => ({}));

/**
 * The config Ondra writes for a server: its tools deferred (reached through `use`, nothing declared
 * up front), and a client secret kept in the keychain, named here by its env var only.
 */
export function serverConfig(o: { name: string; url?: string; command?: string; args?: string[]; clientId?: string; secret?: boolean; scope?: string; about?: string }): Server {
  const s: Server = o.command ? { command: o.command, ...(o.args?.length ? { args: o.args } : {}) } : { type: "http", url: o.url };
  if (o.clientId) {
    const port = FIXED_PORT[o.name];
    s.oauth = { clientId: o.clientId, ...(o.secret ? { clientSecret: `\${${secretVar(o.name)}}` } : {}), ...(o.scope ? { scope: o.scope } : {}), ...(port ? { callbackPort: port } : {}) };
  }
  s.exposure = "deferred";
  if (o.about) s.description = o.about;
  return s;
}

/** Add (or replace) a server of the space; its client secret goes to the keychain, not the file. */
export async function addServer(space: string, name: string, server: Server, secret?: string): Promise<void> {
  if (secret?.trim()) await mcpSecretSet(space, name, secret.trim());
  const all = await readServers(space);
  await mcpSave(space, { ...all, [name]: server });
}

export async function removeServer(space: string, name: string): Promise<void> {
  // its sign-in goes too, then its entry and its secret
  await mcpCli(space, ["logout", name]).catch(() => undefined);
  const all = await readServers(space);
  delete all[name];
  await mcpSave(space, all);
  await mcpSecretDelete(space, name).catch(() => undefined);
}

export async function setEnabled(space: string, name: string, on: boolean): Promise<void> {
  const all = await readServers(space);
  if (!all[name]) return;
  if (on) delete all[name].enabled;
  else all[name].enabled = false;
  await mcpSave(space, all);
}

export type ServerState = { name: string; state: string; tools: string[]; error?: string };

/** each server's state as the engine finds it now: connected (with its tools), needs-auth, failed … */
export async function serverStates(space: string): Promise<ServerState[]> {
  const r = await mcpCli(space, ["list", "--json"]);
  const json = r.out.slice(r.out.indexOf("{"));
  try {
    return ((JSON.parse(json).servers ?? []) as ServerState[]).map((s) => ({ name: s.name, state: s.state, tools: s.tools ?? [], ...(s.error ? { error: s.error } : {}) }));
  } catch {
    throw new Error(r.out.trim().split("\n").pop() || "연결 상태를 읽지 못했어요");
  }
}

/** Sign in to a server in the browser; resolves when it's done (or failed, with the engine's words). */
export async function signIn(space: string, name: string): Promise<{ ok: boolean; said: string }> {
  const r = await mcpCli(space, ["login", name, "--timeout", "300"]);
  return { ok: r.code === 0, said: r.out.trim().split("\n").pop() ?? "" };
}

export async function signOut(space: string, name: string): Promise<void> {
  await mcpCli(space, ["logout", name]);
}

/** whether the space has a service turned on: then its engines load the MCP extension */
export const anyOn = (servers: Record<string, Server>) => Object.values(servers).some((s) => s && s.enabled !== false);

/** the engine flags for a space's connected services (none when it has none) */
export async function mcpArgs(space: string): Promise<string[]> {
  return anyOn(await readServers(space)) ? ["--extension", "builtin:mcp"] : [];
}

/** what main was started with: a change (a service added, removed, turned off) restarts an idle main */
export async function mcpSig(space: string): Promise<string> {
  const all = await readServers(space);
  return Object.entries(all)
    .filter(([, s]) => s && s.enabled !== false)
    .map(([n]) => n)
    .sort()
    .join(",");
}

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * The `services` tool (extensions/ondra.ts), for main or a job of `space`: what is connected, and
 * connecting, signing in, turning off or removing one for the user. A client secret comes by the
 * NAME of a saved secret (Settings › 시크릿) and moves natively; its value never reaches the model.
 */
export async function servicesHands(space: string, a: Args): Promise<unknown> {
  const action = str(a.action) || "list";
  const name = serverName(str(a.name) || str(a.preset));
  const servers = await readServers(space);
  switch (action) {
    case "list": {
      const states = await serverStates(space).catch(() => [] as ServerState[]);
      return {
        connected: Object.entries(servers).map(([n, s]) => {
          const st = states.find((x) => x.name === n);
          return { name: n, ...(s.enabled === false ? { state: "off" } : st ? { state: st.state, tools: st.tools.length, ...(st.error ? { error: st.error.split("\n")[0] } : {}) } : {}) };
        }),
        presets: PRESETS.map((p) => ({ preset: p.id, name: p.name, what: p.about, ...(p.ownApp ? { needs: "the user's own OAuth app: client_id, and client_secret as the name of a saved secret" } : {}) })),
      };
    }
    case "connect": {
      const preset = PRESETS.find((p) => p.id === (str(a.preset) || name));
      const url = str(a.url) || preset?.url;
      const command = str(a.command);
      if (!name || (!url && !command)) return { error: "name and url (or command), or a preset, are needed" };
      if (url && !/^https?:\/\//.test(url)) return { error: "url must be http(s)" };
      const clientId = str(a.client_id);
      const secretName = str(a.client_secret);
      if (preset?.ownApp && (!clientId || !secretName))
        return { error: `${preset.name} takes only known clients: client_id and client_secret (the name of a saved secret in Settings › 시크릿) of the user's own app are needed`, how: preset.ownApp.help, link: preset.ownApp.link };
      if (secretName) await mcpSecretFrom(space, name, secretName);
      const args = Array.isArray(a.args) ? a.args.map(String) : command ? command.split(/\s+/).slice(1) : undefined;
      const cfg = serverConfig({ name, url: command ? undefined : url, command: command ? command.split(/\s+/)[0] : undefined, args, clientId: clientId || undefined, secret: !!secretName, scope: preset?.ownApp?.scope, about: preset?.about });
      await mcpSave(space, { ...servers, [name]: cfg });
      const r = await signIn(space, name);
      return { connected: name, signed_in: r.ok, said: r.said, note: "its tools reach main from its next message, and new jobs" };
    }
    case "sign_in": {
      if (!servers[name]) return { error: `no service ${name}` };
      const r = await signIn(space, name);
      return { signed_in: r.ok, said: r.said };
    }
    case "off":
    case "on":
      if (!servers[name]) return { error: `no service ${name}` };
      await setEnabled(space, name, action === "on");
      return { [name]: action };
    case "remove":
      if (!servers[name]) return { error: `no service ${name}` };
      await removeServer(space, name);
      return { removed: name };
  }
  return { error: `unknown action ${action}: list, connect, sign_in, on, off, remove` };
}
