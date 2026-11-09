// The space's jobs as tools, running or past, so an agent can find one by name and talk to it:
//   jobs_search → jobs by words or meaning (title, ask, topic, project, summary, branch, PR)
//   job_read    → one job in depth (ask, plan, latest messages, result, evidence, PR, children)
//   job_tell    → a message to a job (jobs only; main routes an "append" instead)
// They reach the app through its local door (ONDRA_BRIDGE + token), as the job (APP_WORKER_ID)
// or as main (captain:<chat>); each sees only its own space. Without the app they aren't registered.
import { Type } from "typebox";

const URL_ = process.env.ONDRA_BRIDGE;
const TOKEN = process.env.ONDRA_BRIDGE_TOKEN;
const WORKER = process.env.APP_WORKER_ID;
const MAIN = process.env.ONDRA_MAIN === "1";

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
  // main finds jobs whenever the user names one; a job only now and then (through tool_search)
  const exposure = MAIN ? undefined : "deferred";

  pi.registerTool({
    name: "jobs_search",
    label: "Jobs search",
    ...(exposure ? { exposure } : {}),
    description:
      "Find jobs in this space by words or meaning (Korean and English) across title, ask, topic, project, summary, branch and PR: running, waiting, queued, paused, done and failed, any age, any project, subagents with their parent. One line each: id | status | project | title | when | where it worked | last state (asks / did / failed / now). With no query: the live ones first, then the latest.",
    promptSnippet: "Find a job of this space (running or past) by name, topic, branch or PR",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "what the job is about, as the user names it (\"리디자인\", \"비로그인\", a branch, a PR number); empty lists jobs" })),
      status: Type.Optional(Type.String({ description: "running | waiting | queued | paused | done | failed | live (not finished) | finished" })),
      project: Type.Optional(Type.String({ description: "a project name of this space" })),
      limit: Type.Optional(Type.Number({ description: "max results (default 10, at most 30)" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("jobs_search", p, signal);
      if (r?.error) return out(`jobs_search failed: ${r.error}`);
      if (!r?.lines?.length) return out(r?.total ? `No job matches (searched ${r.total}). Try other words, or no query to list them.` : "This space has no other jobs.");
      return out(r.lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "job_read",
    label: "Job read",
    ...(exposure ? { exposure } : {}),
    description:
      "One job in depth by its id (from jobs_search): its ask, plan with steps done, what it is waiting on, where it worked (branch, worktree, PR), subagents, result and summary, evidence and what wasn't verified, and its latest messages where you may read them.",
    promptSnippet: "Read one job of this space in depth",
    parameters: Type.Object({
      id: Type.String({ description: "the job's id" }),
      messages: Type.Optional(Type.Number({ description: "how many of its latest messages (default 6, at most 20)" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("job_read", p, signal);
      return out(r?.error ? `job_read failed: ${r.error}` : String(r?.text ?? ""));
    },
  });

  // main hands work to a job with an "append" route, so routing and the reply stay one thing
  if (MAIN) return;
  pi.registerTool({
    name: "job_tell",
    label: "Job tell",
    exposure: "deferred",
    description:
      "Send a message to another job of this space (its id from jobs_search): your parent, a sibling, or a past job you need something from. A running job gets it at its next turn (now: true steers it in at once), a waiting one as its answer, a paused one resumes with it, a finished one is carried on by a new job. The user sees it in that job's thread as from you. Not for yourself; say what you need in one self-contained message.",
    promptSnippet: "Send a message to another job of this space",
    parameters: Type.Object({
      id: Type.String({ description: "the job's id" }),
      message: Type.String({ description: "what it needs to know or do, self-contained" }),
      now: Type.Optional(Type.Boolean({ description: "a running job gets it at once instead of after its current turn" })),
    }),
    async execute(_id: string, p: any, signal?: AbortSignal) {
      const r = await call("job_tell", p, signal);
      return out(r?.error ? `job_tell failed: ${r.error}` : String(r?.result ?? "sent"));
    },
  });
}
