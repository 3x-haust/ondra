// The job and subagent prompts are one text for every model, with a few sentences swapped per
// model family, the way oh-my-openagent keeps an Astra variant of its sections. From Ondra's own
// jobs (Nov 5–15: 82 GPT-6 Astra, 40 Claude Opus 5.5 under the same prompt):
// - GPT-5/6 err toward too much: harnesses, helper apps and checker scripts built to verify, the
//   same check run again, subagents writing tests, tests on prose and mockups. Mean cost per job
//   $15 against Opus's $4.9. Their sentences say less, and how to stop.
// - Claude errs on mechanics: evidence refs written as summaries ("curl … → 모두 200"; 56 bounced
//   by the finishing gate), English lines between tool calls, bare `sleep N` calls, SKILL.md not
//   read, a plan check or review that applied but never started. Its sentences spell those out.
// Everything else (gpt-oss, Gemini, an unknown or default model) gets the shared text as it is.

export type Family = "gpt" | "claude" | "base";

export function familyOf(model?: string): Family {
  const id = (model ?? "").split("/").pop()!.toLowerCase();
  if (/claude|opus|sonnet|fable|haiku/.test(id)) return "claude";
  // gpt-oss is a small open model: it needs the shared text's push to check, not less of it
  if (/^(gpt-[5-9]|o[3-9]\b|codex)/.test(id) && !id.includes("oss")) return "gpt";
  return "base";
}

/** [shared sentence, this family's sentence]: each shared one occurs once in TASK_SYSTEM or SUB_SYSTEM (prompts test). */
export const VARIANTS: Record<Exclude<Family, "base">, [string, string][]> = {
  gpt: [
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
  ],
  claude: [
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
      `   check it without this conversation, so the plan must stand on its own.`,
      `   check it without this conversation, so the plan must stand on its own.
   When the plan check or the review below applies, it is required.`,
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
      `Waiting: poll inside one bash call with a deadline, never one \`sleep\` per
turn,`,
      `Waiting: poll inside one bash call with a deadline, never one \`sleep\` per
turn and never a call that is only \`sleep N\`,`,
    ],
    [
      `never one
\`sleep\` per turn;`,
      `never one
\`sleep\` per turn or a call that is only \`sleep N\`;`,
    ],
    [
      `a test/build/run ref is a command you ran here that
  passed after your last code edit;`,
      `a test/build/run ref is the exact command you ran
  here, copied as it was (no summary, no "→ result": results go in "summary"),
  that passed after your last code edit;`,
    ],
  ],
};

/** A role prompt (TASK_SYSTEM or SUB_SYSTEM) as the job's model gets it. */
export function forModel(prompt: string, model?: string): string {
  const family = familyOf(model);
  if (family === "base") return prompt;
  return VARIANTS[family].reduce((p, [from, to]) => p.replace(from, () => to), prompt);
}
