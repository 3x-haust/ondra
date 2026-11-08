// Two languages. The Korean string is the key: t("저장") is "저장" in Korean and
// the English from en/*.ts otherwise. Each area of the app keeps its own English
// file in en/; they are merged here. Call t() where the text is shown (inside JSX
// or a function), never at module load, so a language switch re-renders it.
import { state } from "../state/store";

export type Lang = "ko" | "en";

const files = import.meta.glob<{ default: Record<string, string> }>("./en/*.ts", { eager: true });
const en: Record<string, string> = Object.assign({}, ...Object.values(files).map((m) => m.default));

function system(): Lang {
  if (typeof window === "undefined") return "ko";
  return (navigator.languages?.[0] ?? navigator.language ?? "ko").toLowerCase().startsWith("ko") ? "ko" : "en";
}

/** the language in use: the setting, or the Mac's own */
export const lang = (): Lang => {
  const l = state.settings?.language ?? "system";
  return l === "system" ? system() : l;
};

/** "{n}개" with { n: 3 } → "3개" */
export function t(ko: string, vars?: Record<string, string | number>): string {
  const s = lang() === "en" ? (en[ko] ?? ko) : ko;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** for tests: Korean keys that have no English yet */
export const missing = (keys: string[]) => keys.filter((k) => !(k in en));
