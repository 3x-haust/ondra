// A wait on GitHub CI, under its step row: each job of the run with the step it is
// on and how long it has gone, against how long it usually takes. The app asks
// GitHub itself (as the job's space), not the model, and only while the row shows.
import { createContext, createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show, untrack, useContext } from "solid-js";
import type { Task } from "../state/types";
import { ciTarget, jobLines, parseRun, runIds, runsOfChecks, settledRuns, typicalMs, type CiRun, type CiTarget, type JobLine } from "../engine/ciRun";
import { ghPrChecks, ghRunList, ghRunView, type Env } from "../lib/native";
import { gitEnv } from "../engine/tasks";
import { expand } from "../engine/rpc";
import { now, short } from "./bits";
import { t as tr } from "../i18n";

/** the job whose thread this is: its folder and its space's GitHub login */
export const JobCtx = createContext<() => Task | undefined>(() => undefined);

const EVERY = 25_000;
const FIELDS = "jobs,status,conclusion,workflowName,createdAt";
/** a lookup that keeps failing (no gh login, a deleted run) stops asking */
const TRIES = 3;

// how long a workflow's jobs usually take: learned once per repo and workflow while the app runs
const usual = new Map<string, Promise<Map<string, number>>>();
function typicalOf(cwd: string, repo: string | undefined, workflow: string, env: Env): Promise<Map<string, number>> {
  const key = `${repo ?? cwd}\n${workflow}`;
  let p = usual.get(key);
  if (!p) {
    p = ghRunList(cwd, workflow, repo, env)
      .then((raw) => Promise.all(runIds(raw).map((id) => ghRunView(cwd, id, repo, "jobs", env).then(parseRun, () => undefined))))
      .then((runs) => typicalMs(runs.filter((r): r is CiRun => !!r)))
      .catch(() => {
        // asked again by the next look: a failure isn't what the workflow usually takes
        usual.delete(key);
        return new Map<string, number>();
      });
    usual.set(key, p);
  }
  return p;
}

type Seen = { repo?: string; run: CiRun };

/** The runs the target is about now; finished ones are kept, not asked again. */
async function look(target: CiTarget, cwd: string, env: Env, kept: Map<string, Seen>): Promise<Seen[]> {
  const ids = target.run ? [{ run: target.run, repo: target.repo }] : runsOfChecks(await ghPrChecks(cwd, target.pr ?? "", target.repo, env));
  return Promise.all(
    ids.map(async ({ run, repo }) => {
      const had = kept.get(run);
      if (had && had.run.status === "completed") return had;
      const r = parseRun(await ghRunView(cwd, run, repo, FIELDS, env));
      if (!r) throw new Error(`no run ${run}`);
      const seen = { repo, run: r };
      kept.set(run, seen);
      return seen;
    }),
  );
}

function timeText(l: JobLine): string {
  if (l.state === "queued") return tr("대기 중");
  if (l.state === "running") {
    // "18분째 / 보통 25분"
    return [l.ms !== undefined && tr("{d}째", { d: short(l.ms) }), l.typical && tr("보통 {d}", { d: short(l.typical) })].filter(Boolean).join(" / ");
  }
  const word = l.state === "done" ? tr("완료") : l.state === "failed" ? tr("실패") : l.state === "cancelled" ? tr("취소됨|ci") : tr("건너뜀");
  return l.ms !== undefined && l.state !== "skipped" ? `${word} · ${short(l.ms)}` : word;
}

export function CiProgress(props: { cmd: string }) {
  const job = useContext(JobCtx);
  const target = createMemo(() => ciTarget(props.cmd));
  const [runs, setRuns] = createSignal<Seen[]>([]);
  const [typical, setTypical] = createSignal(new Map<string, Map<string, number>>());
  // asked only while the row is on screen and the window is in front
  const [onScreen, setOnScreen] = createSignal(false);
  const [awake, setAwake] = createSignal(typeof document === "undefined" || !document.hidden);
  let el: HTMLDivElement | undefined;
  onMount(() => {
    const wake = () => setAwake(!document.hidden);
    document.addEventListener("visibilitychange", wake);
    // the step's row, not this list: an empty list has no size to be seen by
    const row = el?.parentElement;
    const io = row && typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => setOnScreen(es.some((e) => e.isIntersecting))) : undefined;
    if (io && row) io.observe(row);
    else setOnScreen(true);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", wake);
      io?.disconnect();
    });
  });

  const kept = new Map<string, Seen>();
  let last = 0;
  let fails = 0;
  let over = false;
  createEffect(() => {
    const t = job();
    const tg = target();
    // a job on another device asks GitHub there; this one doesn't poll for it
    if (!t || t.host || !tg || !onScreen() || !awake() || over) return;
    const cwd = expand(t.worktree?.path ?? t.cwd ?? "");
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      last = Date.now();
      try {
        const env = await gitEnv(t);
        // shown even when the row went off screen meanwhile: it is what GitHub says now
        const seen = await look(tg, cwd, env, kept);
        fails = 0;
        setRuns(seen);
        for (const s of seen) {
          const w = s.run.workflow;
          if (!w || typical().has(w)) continue;
          void typicalOf(cwd, s.repo, w, env).then((m) => !stop && m.size && setTypical((prev) => new Map(prev).set(w, m)));
        }
        // every run has finished: what it shows won't change any more
        if (settledRuns(seen.map((s) => s.run))) over = true;
      } catch {
        if (++fails >= TRIES) over = true;
      }
      if (!stop && !over) timer = setTimeout(tick, EVERY);
    };
    // back on screen soon after a look: wait out the rest of the interval
    const wait = Math.max(0, last + EVERY - Date.now());
    if (wait) timer = setTimeout(tick, wait);
    else untrack(() => void tick());
    onCleanup(() => {
      stop = true;
      clearTimeout(timer);
    });
  });

  const lines = createMemo(() => jobLines(runs().map((s) => s.run), (w, j) => typical().get(w)?.get(j), now()));
  return (
    <div class="ci-jobs" ref={el}>
      <Index each={lines()}>
        {(l) => (
          <div class={`ci-job ci-${l().state}`}>
            <span class="ci-what">
              <span class="ci-name">{l().name}</span>
              <Show when={l().step}>{(s) => <span class="ci-step"> · {s()}</span>}</Show>
            </span>
            <span class="ci-time">{timeText(l())}</span>
            <Show when={l().frac !== undefined}>
              <span class="ci-bar">
                <i style={{ width: `${Math.round((l().frac ?? 0) * 100)}%` }} />
              </span>
            </Show>
          </div>
        )}
      </Index>
    </div>
  );
}
