// Updates from GitHub Releases. A while after start, and every few hours, the
// app asks whether a newer release is out; if so a notice stays until the user
// installs it (download, verify, restart) or closes it.
import { checkForUpdate, installUpdate } from "../lib/native";
import { toast } from "../state/ui";

const EVERY = 6 * 3600_000;
let shown = "";

export async function checkUpdate(manual = false) {
  const next = await checkForUpdate().catch(() => null);
  if (!next) {
    if (manual) toast("최신 버전이에요");
    return;
  }
  if (next.version === shown && !manual) return;
  shown = next.version;
  toast(`새 버전 ${next.version}이 나왔어요`, "info", { label: "업데이트", run: () => void install() }, { stay: true });
}

async function install() {
  toast("업데이트 받는 중이에요. 끝나면 다시 시작해요", "info", undefined, { stay: true });
  try {
    await installUpdate();
  } catch (e) {
    toast(`업데이트하지 못했어요: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
}

export function startUpdates() {
  setTimeout(() => void checkUpdate(), 20_000);
  setInterval(() => void checkUpdate(), EVERY);
}
