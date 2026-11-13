// What a case's "expect" can ask of one of main's decisions (evals/main-sim.mjs, evals/gepa).
/** Every check a step's "expect" can hold; each returns a problem or "". */
export function check(step, x) {
  const routes = step.routes ?? [];
  const kinds = routes.map((r) => r?.kind);
  const news = routes.filter((r) => r?.kind === "new");
  const text = (r) => `${r.title ?? ""} ${r.task ?? ""}`;
  const out = [];
  const need = (ok, msg) => ok || out.push(msg);
  if (step.error) return [`error: ${step.error}`];
  if (x.new !== undefined) {
    const [lo, hi] = typeof x.new === "number" ? [x.new, x.new] : [x.new.min ?? 0, x.new.max ?? 99];
    need(news.length >= lo && news.length <= hi, `new jobs: ${news.length}, expected ${lo === hi ? lo : `${lo}–${hi}`}`);
  }
  if (x.append !== undefined) {
    const ap = routes.filter((r) => r?.kind === "append").map((r) => r.taskId);
    if (x.append === false) need(!ap.length, `appended to ${ap.join(", ")}, expected no append`);
    else need(ap.includes(x.append), `expected append to ${x.append}, got ${ap.join(", ") || "none"}`);
  }
  if (x.stop) need(routes.some((r) => r?.kind === "stop" && r.taskId === x.stop), `expected stop of ${x.stop}`);
  if (x.answerOnly) need(kinds.length > 0 && kinds.every((k) => k === "answer"), `expected only an answer, got ${kinds.join(", ")}`);
  if (x.ask !== undefined) {
    const asked = kinds.includes("ask") || news.some((r) => /\bask\b|어느 쪽|골라|which one/i.test(r.task ?? ""));
    need(asked === x.ask, x.ask ? "expected a question to the user" : "asked the user, expected to just go");
  }
  if (x.project !== undefined) {
    const p = news.map((r) => r.project).filter(Boolean);
    const name = (v) => (typeof v === "string" ? v : v?.name ?? "");
    if (x.project === false) need(!p.length, `expected no project, got ${p.map(name).join(", ")}`);
    else if (x.project === true) need(p.length > 0, "expected a project on the new job");
    else need(p.some((v) => name(v).toLowerCase().includes(String(x.project).toLowerCase())), `expected project "${x.project}", got ${p.map(name).join(", ") || "none"}`);
  }
  if (x.cwdIncludes) need(news.some((r) => String(r.cwd ?? "").includes(x.cwdIncludes) || String(r.project?.folder ?? "").includes(x.cwdIncludes)), `expected cwd with "${x.cwdIncludes}", got ${news.map((r) => r.cwd || r.project?.folder || "-").join(", ")}`);
  if (x.reach !== undefined) {
    const got = [...new Set(news.flatMap((r) => (Array.isArray(r.reach) ? r.reach : [])))];
    if (!x.reach.length) need(!got.length, `expected no reach, got ${got.join(", ")}`);
    else need(x.reach.every((s) => got.includes(s)), `expected reach ${x.reach.join(", ")}, got ${got.join(", ") || "none"}`);
  }
  for (const w of x.taskIncludes ?? []) need(news.some((r) => text(r).toLowerCase().includes(w.toLowerCase())), `no new job's task mentions "${w}"`);
  for (const w of x.taskExcludes ?? []) need(!news.some((r) => text(r).toLowerCase().includes(w.toLowerCase())), `a new job's task mentions "${w}"`);
  for (const k of x.has ?? []) need(kinds.includes(k), `expected a "${k}" route, got ${kinds.join(", ") || "none"}`);
  for (const k of x.hasNot ?? []) need(!kinds.includes(k), `expected no "${k}" route`);
  if (x.stopCount !== undefined) need(routes.filter((r) => r?.kind === "stop").length === x.stopCount, `stops: ${routes.filter((r) => r?.kind === "stop").length}, expected ${x.stopCount}`);
  // a finished job is carried on by a new job with "from" (an append to it is turned into one, but main should say so)
  if (x.follows) need(news.some((r) => r.from === x.follows), routes.some((r) => r?.kind === "append" && r.taskId === x.follows) ? `appended to finished ${x.follows}, expected a new job with "from"` : `expected a new job following ${x.follows}`);
  if (x.appendAny) need(routes.some((r) => r?.kind === "append" && x.appendAny.includes(r.taskId)), `expected append to one of ${x.appendAny.join(", ")}`);
  if (x.cwdEmpty) need(news.every((r) => !r.cwd && !r.project), `expected no cwd/project, got ${news.map((r) => r.cwd || JSON.stringify(r.project)).join(", ")}`);
  // one id or several: an append to any of them, or a new job that waits for any of them
  if (x.appendOrAfter) {
    const ids = [x.appendOrAfter].flat();
    need(routes.some((r) => r?.kind === "append" && ids.includes(r.taskId)) || news.some((r) => Array.isArray(r.after) && r.after.some((a) => ids.includes(a))), `expected an append to ${ids.join(" or ")} or a job after it`);
  }
  if (x.afterTask) need(news.some((r) => Array.isArray(r.after) && r.after.includes(x.afterTask)), `expected a job after ${x.afterTask}`);
  if (x.answerIncludes) {
    const t = routes.filter((r) => r?.kind === "answer").map((r) => r.text ?? "").join(" ");
    for (const w of x.answerIncludes) need(t.includes(w), `answer doesn't mention "${w}"`);
  }
  if (x.answerIncludesAny) {
    const t = routes.filter((r) => r?.kind === "answer").map((r) => r.text ?? "").join(" ");
    need(x.answerIncludesAny.some((w) => t.includes(w)), `answer mentions none of ${x.answerIncludesAny.join(", ")}`);
  }
  // a job's end that needs nothing from the user: its row in the chat says it, main adds nothing
  if (x.quiet) need(!routes.length && !String(step.reply ?? "").trim(), `expected nothing added, got ${kinds.join(", ") || `reply "${step.reply}"`}`);
  // at most a short line: no blocks, and the answer text within this many characters
  if (x.maxAnswer) {
    const ans = routes.filter((r) => r?.kind === "answer");
    const len = ans.map((r) => r.text ?? "").join(" ").length;
    need(len <= x.maxAnswer && !ans.some((r) => (r.blocks ?? []).length), `answer is ${len} chars${ans.some((r) => (r.blocks ?? []).length) ? " with blocks" : ""}, expected one short line (≤ ${x.maxAnswer})`);
  }
  if (x.after) need(news.some((r) => Array.isArray(r.after) && r.after.length), "expected a job that waits (after)");
  if (x.noAfter) need(!news.some((r) => Array.isArray(r.after) && r.after.length), "a job waits (after) that should start now");
  return out;
}
