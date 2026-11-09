// How big the whole app is drawn (⌘= / ⌘−, Settings › 화면 크기), kept with the settings.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { inTauri } from "../lib/native";
import { setState, state } from "./store";
import { toast } from "./ui";
import { t } from "../i18n";

export const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const zoom = () => state.settings.zoom ?? 1;

export function applyZoom(z: number) {
  if (inTauri) void getCurrentWebview().setZoom(z).catch(() => {});
  else document.documentElement.style.setProperty("zoom", z === 1 ? "" : String(z));
}

export function setZoom(z: number, say = false) {
  setState("settings", "zoom", z === 1 ? undefined : z);
  if (say) toast(t("화면 크기 {p}%", { p: Math.round(z * 100) }), "info", undefined, { ms: 1200 });
}

/** one step bigger (+1) or smaller (−1) on the ladder */
export function stepZoom(dir: 1 | -1) {
  const now = zoom();
  const i = ZOOMS.findIndex((z) => Math.abs(z - now) < 0.001);
  const at = i < 0 ? ZOOMS.indexOf(1) : i;
  const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, at + dir))];
  if (next !== now) setZoom(next, true);
}
