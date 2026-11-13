// Checks every main decision must pass, whatever the case expects.
/** What every decision must get right, whatever the case expects. */
export function lint(step, c, real = false) {
  const out = [];
  const routes = step.routes ?? [];
  const ids = new Set([...(c.tasks ?? []).map((t) => t.id), ...Array.from({ length: 20 }, (_, i) => `job-${i + 1}`)]);
  const spaces = ["work", "home"];
  if (step.error) return out;
  // a job's end that needs nothing from the user may add nothing (its row in the chat says it)
  const event = (c.messages ?? []).some((m) => typeof m === "object" && m?.text === step.text);
  if (!routes.length && !event) out.push("lint: no routes");
  if (/할까요\?|원하시면|해 드릴까요/.test(step.reply ?? "")) out.push(`lint: offers work as a question: "${step.reply}"`);
  for (const r of routes) {
    if (!r || !["answer", "ask", "append", "stop", "new", "remember"].includes(r.kind)) out.push(`lint: unknown route ${JSON.stringify(r)?.slice(0, 80)}`);
    else if (!real && (r.kind === "append" || r.kind === "stop") && !ids.has(r.taskId)) out.push(`lint: ${r.kind} to unknown job ${r.taskId}`);
    else if (r.kind === "append" && !String(r.message ?? "").trim()) out.push("lint: append without a message");
    else if (r.kind === "answer" && !String(r.text ?? "").trim()) out.push("lint: empty answer");
    else if (r.kind === "ask" && !(Array.isArray(r.options) && r.options.length >= 2 && r.options.length <= 4)) out.push("lint: ask needs 2–4 options");
    else if (r.kind === "new") {
      if (!String(r.task ?? "").trim()) out.push("lint: new without a task");
      if (String(r.title ?? "").length > 24) out.push(`lint: title too long: ${r.title}`);
      if (r.branch && !/^(feat|fix|docs|refactor|test|chore|build|ci|perf)\/[a-z0-9][a-z0-9-]*$/.test(r.branch)) out.push(`lint: branch ${r.branch}`);
      if (r.project && typeof r.project === "object" && r.project.folder && !String(r.project.folder).startsWith("/") && !String(r.project.folder).startsWith("~")) out.push(`lint: project folder not absolute: ${r.project.folder}`);
      if (r.cwd && !String(r.cwd).startsWith("/") && !String(r.cwd).startsWith("~")) out.push(`lint: cwd not absolute: ${r.cwd}`);
      for (const s of Array.isArray(r.reach) ? r.reach : []) if (!spaces.includes(s) || s === c.space) out.push(`lint: reach ${s}`);
      const t = String(r.task ?? "");
      if (/--base\s+main\b|\b(PR|pull request)[^.\n]{0,40}\b(to|into|against|base)\s+`?main\b|main\s*(으로|로)\s*PR/i.test(t) && !/(not|never|no)\s+(to\s+)?`?main|main\s*(으로는|은)\s*(열지|안)/i.test(t) && (c.memory ?? []).some((m) => /dev로/.test(m))) out.push("lint: PR to main against memory");
    }
  }
  return out;
}

