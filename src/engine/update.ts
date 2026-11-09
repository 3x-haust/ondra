// Updates from GitHub Releases. A while after start, every 15 minutes, on coming back and
// on opening Settings, the app asks whether a newer release is out. If so it fetches the
// package in the background first; once it is ready one notice offers to restart into it
// (a newer one replaces it, and it closes by itself). Installing always asks once more, so
// it goes straight to the newest release even when another came out after the last check.
// A restart would cut the jobs at work (their commands, servers, checks): while one runs, the
// notice restarts once none does instead. Settings shows the same, with how far the download
// is, and still restarts at once when asked.
import { createSignal } from "solid-js";
import { checkForUpdate, installUpdate, onUpdateProgress, prepareUpdate } from "../lib/native";
import { dropToast, toast } from "../state/ui";
import { flushState, state } from "../state/store";
import { t } from "../i18n";

const EVERY = 15 * 60_000;
/** coming back to the app (or opening Settings) checks again once this long has passed */
const AGAIN = 2 * 60_000;
/** how often a queued restart looks whether the jobs are done */
const IDLE_LOOK = 3_000;
let shown = "";
let notice = 0;
let lastCheck = 0;
let preparing: { version: string; done: Promise<boolean> } | null = null;

export type UpdateState = "idle" | "checking" | "latest" | "installing";
const [status, setStatus] = createSignal<UpdateState>("idle");
const [available, setAvailable] = createSignal<string | null>(null);
const [checkedAt, setCheckedAt] = createSignal(0);
/** download progress of the newer version (null when not downloading) */
const [progress, setProgress] = createSignal<number | null>(null);
/** the newer version is downloaded and verified: installing is just a restart */
const [ready, setReady] = createSignal<string | null>(null);
/** a restart is waiting for the jobs at work to end */
const [queued, setQueued] = createSignal(false);
export { available, checkedAt, progress as updateProgress, queued as restartQueued, ready as updateReady, status as updateStatus };

/** A job is at work (not one waiting for the user): restarting now would cut it. */
export const jobsWorking = () => state.tasks.some((t) => !t.parentId && t.status === "running");

let idle: ReturnType<typeof setInterval> | undefined;
/** Restart into the update once no job is at work: now when none is. */
export function restartWhenIdle() {
  if (!jobsWorking()) return void installNow();
  if (queued()) return;
  setQueued(true);
  let quiet = 0;
  idle = setInterval(() => {
    // twice in a row: a job that ends often hands over to the next one right away
    quiet = jobsWorking() ? 0 : quiet + 1;
    if (quiet >= 2) void installNow();
  }, IDLE_LOOK);
}
const unqueue = () => {
  clearInterval(idle);
  idle = undefined;
  setQueued(false);
};

void onUpdateProgress((p) => setProgress(p.percent));

function prepare(version: string): Promise<boolean> {
  if (ready() === version) return Promise.resolve(true);
  // an older download still going: let it end, then fetch the newer one
  if (preparing && preparing.version !== version) return preparing.done.then(() => prepare(version));
  if (!preparing) {
    const done = prepareUpdate()
      .catch(() => false)
      .then((ok) => {
        preparing = null;
        setProgress(null);
        if (ok) setReady(version);
        return ok;
      });
    preparing = { version, done };
  }
  return preparing.done;
}

export async function checkUpdate(manual = false) {
  if (status() === "checking" || status() === "installing") return;
  lastCheck = Date.now();
  setStatus("checking");
  const next = await checkForUpdate().catch(() => null);
  setCheckedAt(Date.now());
  setAvailable(next?.version ?? null);
  setStatus(next ? "idle" : "latest");
  if (!next) {
    if (manual) toast(t("최신 버전이에요"));
    return;
  }
  // a notice for an older version that is no longer the newest goes away
  if (notice && shown && shown !== next.version) { dropToast(notice); notice = 0; }
  const ok = await prepare(next.version);
  // a restart already waits for the jobs: it installs the newest then
  if (!ok || queued() || (next.version === shown && !manual)) return;
  shown = next.version;
  if (notice) dropToast(notice);
  const action = jobsWorking()
    ? {
        label: t("작업 끝나면 다시 시작"),
        run: () => {
          restartWhenIdle();
          if (queued()) toast(t("작업이 끝나면 다시 시작해요"));
        },
      }
    : { label: t("다시 시작|update"), run: () => void installNow() };
  // the button at the top left says it from now on; a check you asked for also answers here
  if (manual) notice = toast(t("{v} 업데이트 준비됨", { v: next.version }), "info", action, { ms: 8_000 });
}

export async function installNow() {
  if (status() === "installing") return;
  unqueue();
  setStatus("installing");
  if (notice) dropToast(notice);
  try {
    // a newer release may have come out since the last check: install that one
    const next = await checkForUpdate().catch(() => null);
    setCheckedAt(Date.now());
    if (next) setAvailable(next.version);
    if (preparing) await preparing.done;
    // the restart doesn't wait for a save still to come
    await flushState().catch(() => {});
    await installUpdate();
  } catch (e) {
    setStatus("idle");
    setProgress(null);
    toast(t("업데이트하지 못했어요 · {why}", { why: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

/** Check again if the last check is a while ago (opening Settings). */
export function freshen() {
  if (!lastCheck || Date.now() - lastCheck > AGAIN) void checkUpdate();
}

export function startUpdates() {
  setTimeout(() => void checkUpdate(), 20_000);
  setInterval(() => void checkUpdate(), EVERY);
  window.addEventListener("focus", () => {
    if (lastCheck) freshen();
  });
}
