// The user's own rules for the Discord agent: a script on their Mac only (<data folder>/agent/rules.js),
// which the agent writes and edits when they ask ("멘션 안 해도 들어", "이 채널에선 조용히 있어").
// Ondra ships only the asking, so each user's agent listens their own way without a setting per wish.
//
// The file defines `listen(message, ctx)`, asked for every message the agent sees:
//   true: take it, as if it was called · false: leave it, even if it was · "watch": look on, and say
//   something, react, or let it pass, as it sees fit · anything else: the usual way.
// It runs in a worker, with nothing of the app in reach. A missing file, a rule that throws, or one
// that doesn't answer within WAIT_MS leaves the usual way.
import { engineInfo, fsRead, type DiscordMessage } from "../lib/native";
import { logError } from "../lib/log";
import type { Heard } from "./agentMemory";

/** What a rule gets besides the message. */
export type ListenCtx = {
  /** the message is the user's own */
  owner: boolean;
  /** what the usual way decided: a DM, a mention, a reply to it, its name, or a question of its waiting there */
  called: boolean;
  /** the agent's name, and its Discord id */
  name: string;
  me: string;
  /** what was said in the channel lately, oldest first, before this message (`me`: the agent's own lines) */
  recent: Heard[];
  /** ms since 1970, like each line's `at` */
  now: number;
};

/** What a rule can say about a message: take it, leave it, or watch it. */
export type Take = boolean | "watch";

const WAIT_MS = 1000;

let dir: Promise<string> | undefined;
/** where the user's rules file is */
export const rulesPath = () => (dir ??= engineInfo().then((i) => `${i.dataDir.replace(/\/$/, "")}/agent/rules.js`));

// after the user's script, so its `listen` is in reach however it was declared
const ASK = `
self.onmessage = (e) => {
  const { id, message, ctx } = e.data;
  const reply = (out, error) => postMessage({ id, out: typeof out === "boolean" || out === "watch" ? out : undefined, error });
  try {
    Promise.resolve(typeof listen === "function" ? listen(message, ctx) : undefined).then((out) => reply(out), (err) => reply(undefined, String((err && err.message) || err)));
  } catch (err) {
    reply(undefined, String((err && err.message) || err));
  }
};`;

type Said = { id: number; out?: Take; error?: string };
let loaded: { text: string; worker: Worker; url: string; broken: boolean } | undefined;
const waiting = new Map<number, (said: Said | undefined) => void>();
let seq = 0;

function load(text: string) {
  forgetRules();
  const url = URL.createObjectURL(new Blob([text, "\n", ASK], { type: "text/javascript" }));
  const worker = new Worker(url);
  const now = { text, worker, url, broken: false };
  worker.onmessage = (e: MessageEvent<Said>) => {
    waiting.get(e.data.id)?.(e.data);
    waiting.delete(e.data.id);
  };
  worker.onerror = (e: ErrorEvent) => {
    now.broken = true;
    logError("agent", `rules: ${e.message}`);
  };
  loaded = now;
}

/** Stop the rules' worker (the agent went off); the file is read again next time. */
export function forgetRules() {
  if (!loaded) return;
  loaded.worker.terminate();
  URL.revokeObjectURL(loaded.url);
  loaded = undefined;
}

/** What the user's rules say about this message: true take it, false leave it, "watch" watch it, undefined the usual way. */
export async function listens(message: DiscordMessage, ctx: ListenCtx): Promise<Take | undefined> {
  const text = await fsRead(await rulesPath()).then((f) => f.text ?? "", () => "");
  if (!text.trim()) {
    forgetRules();
    return undefined;
  }
  if (loaded?.text !== text) load(text);
  const rules = loaded!;
  if (rules.broken) return undefined;
  const id = ++seq;
  const said = await new Promise<Said | undefined>((done) => {
    waiting.set(id, done);
    setTimeout(() => (waiting.delete(id), done(undefined)), WAIT_MS);
    rules.worker.postMessage({ id, message, ctx });
  });
  if (!said) logError("agent", `rules: listen gave no answer within ${WAIT_MS}ms`);
  else if (said.error) logError("agent", `rules: ${said.error}`);
  return said?.out;
}
