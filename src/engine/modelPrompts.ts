// The job and subagent prompts are one text for every model, with a few sentences swapped and a
// short note added per model, the way oh-my-openagent / Senpi keep a preset per model family
// (code-yeongyu/senpi, packages/coding-agent/src/core/extensions/builtin/prompt-preset: each
// note below carries the habit its preset corrects, in its words where they transfer).
// Ondra's own jobs (Nov 5–15: 82 GPT-6 Astra, 40 Claude Opus 5.5 under one prompt) gave the swaps:
// - GPT-6 errs toward too much: harnesses, helper apps and checker scripts built to verify, the
//   same check run again, subagents writing tests, tests on prose and mockups ($15 a job on
//   average against Opus's $4.9). Its sentences say less, and how to stop.
// - Claude errs on mechanics: evidence refs written as summaries (56 bounced by the finishing
//   gate), English lines between tool calls, bare `sleep N` calls, SKILL.md not read, a plan
//   check or review that applied but never started. Those are spelled out for it, and for the
//   families Senpi prompts the same way (GLM, Kimi, DeepSeek, Grok, Gemini).
// gpt-oss, MiniMax and unknown models keep the shared text: gpt-oss is a small model that needs
// the shared push to check, and Senpi has no preset for MiniMax.

type Layer = { swaps?: [string, string][]; note?: string };

/** [shared sentence, this layer's sentence]: each shared one occurs once in TASK_SYSTEM or SUB_SYSTEM (modelPrompts test). */
const CHECK_LESS: [string, string][] = [
  [
    `Add a focused failing regression test when the test
path is clear and cheap and see it fail for the intended reason; otherwise use
the closest executable reproduction.`,
    `Add a regression test only when the repo keeps tests
for this behaviour and nothing else would catch it coming back, and see it fail
first; a prompt, doc, mockup or visual change gets none. Otherwise the
reproduction, rerun, is the proof.`,
  ],
  [
    `Verify once, at the end, with the cheapest check that proves the user-visible
result:`,
    `Verify once, at the end, with the cheapest check the project already has that
proves the user-visible result (never a harness, runner, helper app or checker
script built to verify, never a rerun to be sure; when unsure how much, less):`,
  ],
  [
    `Not for trivial steps, and never
to audit or review your own change`,
    `Not for trivial steps or writing
tests, and never to audit or review your own change`,
  ],
  [
    `Do the task asked
and stop: no extra polish, refactors or checks nobody asked for.`,
    `Do the task asked
and stop: no extra polish, refactors or checks nobody asked for. Once the
request is met with evidence in hand, finish: no extra verification pass or
polish loop. A defect outside the request is a line in the report, not work here.`,
  ],
];

const MECHANICS: [string, string][] = [
  [
    `Skills hold the workflow for a whole domain: use them without being asked.`,
    `Skills hold the workflow for a whole domain: use them without being asked,
and read the SKILL.md before the first step in its domain, never from memory.`,
  ],
  [
    `Your instructions may be in English; that never changes this.`,
    `Your instructions, the code and the logs may be in English; that never
changes this, from the first line of a long job to the last.`,
  ],
  [
    `Calls that don't depend on each other go out
together as parallel tool calls in one step`,
    `Calls that don't depend on each other go out
together as parallel tool calls, several in one message,`,
  ],
  [
    `Ondra's own data (its
app-support folder: sessions, state.json, other jobs' worktrees) is not your
material;`,
    `Ondra's own data (its
app-support folder: sessions, state.json, other jobs' worktrees) is never read
or searched (another job is reached with job_read);`,
  ],
  [
    `a test/build/run ref is a command you ran here that
  passed after your last code edit;`,
    `a test/build/run ref is the exact command you ran
  here, copied as it was (no summary, no "→ result": results go in "summary"),
  that passed after your last code edit;`,
  ],
];

export const LAYERS: Record<string, Layer> = {
  // ── GPT
  "gpt-6": {
    swaps: CHECK_LESS,
    note: `A plan, a hypothesis, a status report or an offer to continue never stands
in for the work. "해줘", "할 수 있어?" and "하고 싶어" ask for the work itself.
Problems outside the task go in the report unexplored unless one blocks it. A
guard, retry, special case or fallback stacked on an undiagnosed cause is a
patch: find the cause. When a skill or AGENTS.md line drives a choice, name
the file and quote the line.`,
  },
  "gpt-5.5": {
    note: `Dig past the first plausible finding: it is often a symptom. Implement,
don't propose. A status question is not a stop: answer it and keep working.
Never shorten the artifact asked for, and never revert or change edits you did
not make unless asked.`,
  },
  "gpt-5": {
    note: `Edit files with the edit and write tools, never through heredocs, sed -i
or inline python. Start working without an upfront plan speech or restating
the goal, keep ordinary lookups to one broad search wave, and build exactly
and only what was asked.`,
  },
  // ── Claude
  claude: {
    swaps: [
      [
        `   check it without this conversation, so the plan must stand on its own.`,
        `   check it without this conversation, so the plan must stand on its own.
   When the plan check or the review below applies, it is required.`,
      ],
    ],
  },
  mechanics: { swaps: MECHANICS },
  "opus-5.5": {
    note: `While work you owe is open, never end the turn with text: not a summary
that announces the next step instead of taking it, an offer to continue, a list
of decisions none of which blocks the rest, or a report because the turn ran
long. A status line goes in the same message as your next tool call. On a
loosely specified task, look through the sources that could bear on it before
changing anything.`,
  },
  "opus-5": {
    note: `Run the check that fits the change once and trust a green result. Don't
delegate what you can finish in a handful of tool calls, and use one subagent
rather than several when one can do it. If the request seems to need another
scope, say so in a sentence and do the task as asked.`,
  },
  "sonnet-5.5": {
    note: `Three endings are defects: pausing to have a plan confirmed when the request
already settles it, asking what you could answer from the code or the
conversation, and stopping after one part of a multipart task. Tests, docs or
supporting files only where asked or kept by the repo; mention the rest at the
end. If no real check can run, name it and why instead of reporting done.`,
  },
  "haiku-5.5": {
    note: `Handing the task back while asked-for work is owed is a defect: keep
working until it is done. Your training data ends well before today: versions,
prices, rules and anything "latest" are looked up, even when you feel sure.`,
  },
  fable: {
    note: `Deliver all of what was asked and only it. Once it is met, stop: another
verification pass, re-polish or a bonus refactor is a defect, not diligence.
Don't ask permission for work the task already settles. Plain, mostly short
sentences: say what a thing is instead of a term you made up while working.`,
  },
  "fable-5.2": {
    note: `Errors, timeouts, locked files, empty results and failing tools are
obstacles to work through; a file marked not to be touched, withheld access or
a guardrail is a blocker to leave alone. Never repeat a failure you have not
diagnosed.`,
  },
  "opus-4": {
    note: `"Every", "all" and "each" (모든, 전부) mean the full set, not the first
item: state the scope you applied. Look a fact up instead of reasoning past it.
Start the subagents of a fan-out in the same turn. A new look follows the
project or the brief, never a default cream/serif/terracotta style.`,
  },
  // ── others Senpi tunes
  glm: {
    note: `A cheap tool call beats a long internal debate. Work in short act → look →
check loops, so an early mistake shows before later steps build on it.`,
  },
  deepseek: {
    note: `What Ondra tells you (these rules, a finishing check, a review) is settled:
never weigh whether it was really asked or is too heavy. Missing information is
fetched (a file read, a tool call, one precise question), never invented. Don't
reopen a settled reading over the same evidence; end reasoning in an action.
When only waiting is left, end the turn instead of sleeping or polling.`,
  },
  "kimi-k2": {
    note: `Skip reassurance ("다시 확인해 볼게요", "to be sure"). A choice the user made
is carried out, not reopened. Save deep reasoning for ambiguity, failures and
steps that can't be undone.`,
  },
  "kimi-k3": {
    note: `An invented assumption is a defect: when unclear intent would change the
result, ask. A pre-existing bug or concern the task doesn't mention goes in the
report, not this change. About one focused test per stated behaviour. After
three different approaches fail, return to the last good state and ask one
precise question.`,
  },
  grok: {
    note: `Done means the deliverable exists and the user can see it working, never a
plan, a partial or a report about it. A multi-step request is one deliverable
done in order, not proposed and waited on. Check what a subagent reports
instead of relaying it. Near-identical repeated blocks are a defect.`,
  },
  gemini: {
    note: `A line before tool calls is plain prose, and the calls follow in the same
response. Retry a transient failure (timeout, rate limit) as it is; on any
other failure change the approach or the arguments, never repeat the same call.
Read and change files with the tools, not shell text processing. Work out what
is asked before coding; zero type errors is not done.`,
  },
};

/** The layers a model gets, in order (most specific id first within a family). */
export function layersOf(model?: string): string[] {
  const id = (model ?? "").split("/").pop()!.toLowerCase().replace(/[\s._:]+/g, "-");
  if (!id || id.includes("oss")) return [];
  if (/gpt-?6/.test(id)) return ["gpt-6"];
  if (/gpt-5-[56](?!\d)/.test(id)) return ["gpt-5.5"];
  if (/gpt-5|codex|^o[3-9](-|$)/.test(id)) return ["gpt-5"];
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(id)) {
    const own =
      /(fable|mythos)-5-2(?!\d)/.test(id) ? ["fable", "fable-5.2"]
      : /(fable|mythos)-5/.test(id) ? ["fable"]
      : /opus-5-5(?!\d)/.test(id) ? ["opus-5.5"]
      : /opus-5(?!\d)/.test(id) ? ["opus-5"]
      : /sonnet-5-5(?!\d)/.test(id) ? ["sonnet-5.5"]
      : /haiku-5-5(?!\d)/.test(id) ? ["haiku-5.5"]
      : /opus-4-[5-8](?!\d)/.test(id) ? ["opus-4"]
      : [];
    return ["mechanics", "claude", ...own];
  }
  if (/kimi-k3|^k3(-1|p1)?(-|$)|k3p1|^swe-2/.test(id)) return ["mechanics", "kimi-k3"];
  if (/kimi-k2|kimi-for-coding/.test(id)) return ["mechanics", "kimi-k2"];
  for (const f of ["glm", "deepseek", "grok", "gemini"]) if (id.includes(f)) return ["mechanics", f];
  return [];
}

/** A role prompt (TASK_SYSTEM or SUB_SYSTEM) as the job's model gets it. */
export function forModel(prompt: string, model?: string): string {
  const layers = layersOf(model).map((k) => LAYERS[k]);
  const swapped = layers.flatMap((l) => l.swaps ?? []).reduce((p, [from, to]) => p.replace(from, () => to), prompt);
  const notes = layers.flatMap((l) => (l.note ? [l.note] : []));
  return notes.length ? `${swapped}\n\n# Habits of this model\n${notes.join("\n")}` : swapped;
}
