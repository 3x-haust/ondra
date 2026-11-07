// Updates from GitHub Releases. A while after start, every hour and on coming back, the
// app asks whether a newer release is out. If so it fetches the package in the background
// first; once it is ready one notice offers to restart into it (a newer one replaces it,
// and it closes by itself). Settings shows the same, with how far the download is.
import { createSignal } from "solid-js";
import { checkForUpdate, installUpdate, onUpdateProgress, prepareUpdate } from "../lib/native";
import { dropToast, toast } from "../state/ui";

const EVERY = 3600_000;
/** coming back to the app checks again once this long has passed */
const AGAIN = 30 * 60_000;
let shown = "";
let notice = 0;
let lastCheck = 0;
let preparing: Promise<boolean> | null = null;

export type UpdateState = "idle" | "checking" | "latest" | "installing";
const [status, setStatus] = createSignal<UpdateState>("idle");
const [available, setAvailable] = createSignal<string | null>(null);
const [checkedAt, setCheckedAt] = createSignal(0);
/** download progress of the newer version (null when not downloading) */
const [progress, setProgress] = createSignal<number | null>(null);
/** the newer version is downloaded and verified: installing is just a restart */
const [ready, setReady] = createSignal<string | null>(null);
export { available, checkedAt, progress as updateProgress, ready as updateReady, status as updateStatus };

void onUpdateProgress((p) => setProgress(p.percent));

function prepare(version: string) {
  if (ready() === version) return Promise.resolve(true);
  preparing ??= prepareUpdate()
    .catch(() => false)
    .then((ok) => {
      preparing = null;
      setProgress(null);
      if (ok) setReady(version);
      return ok;
    });
  return preparing;
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
    if (manual) toast("최신 버전이에요");
    return;
  }
  const ok = await prepare(next.version);
  if (!ok || (next.version === shown && !manual)) return;
  shown = next.version;
  if (notice) dropToast(notice);
  notice = toast(`새 버전 ${next.version} 준비됐어요`, "info", { label: "다시 시작", run: () => void installNow() }, { ms: 12_000 });
}

export async function installNow() {
  if (status() === "installing") return;
  setStatus("installing");
  if (notice) dropToast(notice);
  try {
    if (preparing) await preparing;
    await installUpdate();
  } catch (e) {
    setStatus("idle");
    setProgress(null);
    toast(`업데이트하지 못했어요: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
}

export function startUpdates() {
  setTimeout(() => void checkUpdate(), 20_000);
  setInterval(() => void checkUpdate(), EVERY);
  window.addEventListener("focus", () => {
    if (lastCheck && Date.now() - lastCheck > AGAIN) void checkUpdate();
  });
}
