import { lang, t } from "../i18n";

/**
 * A shell command in plain words, for the canvas and the "now" line: what it does
 * ("GitHub 빌드 확인") and on what, never the command itself. No model involved.
 */
export interface Said {
  /** short, for a list of steps: "PR 올리기" */
  label: string;
  /** going on now: "PR 올리는 중" */
  now: string;
  /** the same in Korean, as a task stores it (shown through nowText()) */
  nowKo: string;
  /** the file, site or thing it works on */
  target?: string;
}

const host = (s: string) => s.match(/https?:\/\/(?:www\.)?([^/'"\s)]+)/)?.[1];
const file = (s: string) => {
  const m = [...s.matchAll(/(?:^|\s)['"]?((?:~|\.{0,2})?\/?[\w.\-@가-힣/ ]*?[\w\-가-힣]+\.[A-Za-z0-9]{1,6})['"]?(?=\s|$|;|\|)/g)].map((x) => x[1]).filter((x) => !/^\d+(\.\d+)*$/.test(x));
  const f = m[m.length - 1];
  return f ? f.split("/").filter(Boolean).pop() : undefined;
};
/** label and now are Korean keys, shown in the current language; {x} is filled from vars */
const fill = (s: string, vars?: Record<string, string>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m) : s);
const S = (label: string, now: string, target?: string, vars?: Record<string, string>): Said => ({ label: t(label, vars), now: t(now, vars), nowKo: fill(now, vars), target });

/** The shapes a stored "now" line takes when a name is filled in (the rest are plain t() keys). */
const NOW_FORMS = ["{f} 읽는 중", "{f}에 적는 중", "{f} 수정 중", "{f} 작성 중", "서브에이전트 {n}개 기다리는 중", "Aside로 {h} 보는 중", "{h} 요청 중", "{p} 실행 중"];
const escape = (s: string) => s.replace(/[.*+?^$()[\]\\|]/g, "\\$&");
const FORM_RES = NOW_FORMS.map((f) => ({ f, keys: [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), re: new RegExp(`^${escape(f).replace(/\{\w+\}/g, "(.+?)")}$`) }));

/**
 * A task's "now" line in the app's language. Tasks store it in Korean ("테스트 실행 중",
 * "router.ts 읽는 중"); fixed lines are t() keys, lines with a file or command name in them
 * are matched to their form. What the model wrote itself stays as written.
 */
export function nowText(now: string | undefined): string {
  if (!now || lang() === "ko") return now ?? "";
  // a bar would read as t()'s context mark: model text keeps it
  const plain = now.includes("|") ? now : t(now);
  if (plain !== now) return plain;
  for (const { f, keys, re } of FORM_RES) {
    const m = now.match(re);
    if (!m) continue;
    const vars: Record<string, string | number> = {};
    keys.forEach((k, i) => (vars[k] = k === "n" && /^\d+$/.test(m[i + 1]) ? Number(m[i + 1]) : m[i + 1]));
    return t(f, vars);
  }
  return now;
}

/**
 * The quiet lines Ondra writes into a task's thread (kind "note"), as `t()` keys with
 * their names in {x}. Tasks store them in Korean with the names filled in; `noteText()`
 * matches them back. `was` lists older wordings still found in saved tasks.
 */
const NOTE_FORMS: { key: string; was?: string[] }[] = [
  { key: "메모리 저장 · {text}", was: ["기억함 · {text}"] },
  { key: "이전 작업의 리뷰가 그대로 유효해요", was: ["앞의 일에서 받은 리뷰가 그대로 유효해요"] },
  { key: "작업 전용 브랜치 {b}에서 시작해요" },
  { key: "{into}에 병합했어요", was: ["{into}에 합쳤어요"] },
  { key: "워크트리 정리 · 변경은 PR에 있어요", was: ["작업 폴더를 정리했어요. 변경은 PR에 있어요"] },
  { key: "{into} 병합됨 · 워크트리 정리", was: ["{into}이 합쳐져서 작업 폴더를 정리했어요"] },
  { key: "{into}에 이미 반영됨 · 워크트리 정리", was: ["{into}에 이미 들어가서 작업 폴더를 정리했어요"] },
  { key: "재시도 {a}/{m}" },
  { key: "연결이 끊겼어요 · 다시 연결되면 이어서 해요", was: ["연결이 끊겼어요. 다시 연결되면 이어서 해요"] },
  { key: "모델 변경 → {m}" },
  { key: "모델 → {m}" },
  { key: "끝내기 전에 확인 · {what}" },
  { key: '"{title}" 작업의 결과와 브랜치를 이어받아 시작해요', was: ['"{title}" 일의 결과와 브랜치를 이어받아 새로 시작해요'] },
  { key: '"{title}" 작업의 결과를 이어받아 시작해요', was: ['"{title}" 일의 결과를 이어받아 새로 시작해요'] },
  { key: '브랜치 {b}는 "{title}" 작업으로 넘어갔어요', was: ['브랜치 {b}는 "{title}" 일로 넘어갔어요'] },
  { key: '"{title}" 작업으로 넘어가요', was: ['"{title}" 일로 넘어가요'] },
];
/** what "끝내기 전에 확인 · …" lists (stored Korean → its key) */
const PROOF_PARTS: Record<string, string> = {
  "리뷰": "리뷰|proof",
  "리뷰 지적": "리뷰 지적|proof",
  "증거": "증거|proof",
  "증거 안 맞음": "증거 안 맞음|proof",
  "남은 작업 있음": "남은 작업 있음|proof",
  "아직 할 일이 남음": "남은 작업 있음|proof",
};
const formRe = (f: string) => ({ keys: [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), re: new RegExp(`^${escape(f).replace(/\{\w+\}/g, "([\\s\\S]+?)")}$`) });
const NOTE_RES = NOTE_FORMS.flatMap(({ key, was = [] }) => [key, ...was].map((f) => ({ key, ...formRe(f) })));

/**
 * A note in a task's thread in the app's language. Notes are stored in Korean
 * ("변경을 버렸어요", "main에 병합했어요"); older wordings read as today's in
 * Korean too. A line that isn't one of Ondra's stays as written.
 */
export function noteText(text: string): string {
  for (const { key, keys, re } of NOTE_RES) {
    const m = text.match(re);
    if (!m) continue;
    const vars: Record<string, string> = {};
    keys.forEach((k, i) => (vars[k] = m[i + 1]));
    if (vars.what) vars.what = vars.what.split(" · ").map((p) => (PROOF_PARTS[p] ? t(PROOF_PARTS[p]) : p)).join(" · ");
    return t(key, vars);
  }
  // a bar would read as t()'s context mark
  return text.includes("|") ? text : t(text);
}

/**
 * A title that fits in `max` characters, cut where a word ends with "…" (never
 * mid-word unless one word is longer than half of it).
 */
export function cutTitle(s: string, max = 40): string {
  const x = s.replace(/\s+/g, " ").trim();
  const chars = [...x];
  if (chars.length <= max) return x;
  const head = chars.slice(0, max - 1).join("");
  const at = chars[max - 1] === " " ? head.length : head.lastIndexOf(" ");
  const cut = at >= head.length / 2 ? head.slice(0, at) : head;
  return `${cut.replace(/[\s,.;:·…\-–—(/]+$/, "")}…`;
}

/** The part of a command that matters: no `cd …`, env settings, `date`, echo. */
function core(cmd: string): string {
  const parts = cmd.split(/\s*(?:&&|;|\n)\s*/).map((p) => p.trim()).filter(Boolean);
  const skip = /^(cd|export|set|source|\.|echo|printf|date|true|:|mkdir|unset|local|R=|[A-Z_][A-Z0-9_]*=\S*$)/;
  return parts.find((p) => !skip.test(p)) ?? parts[0] ?? cmd;
}

/**
 * The command that does the work in a chain, for a row's name: setup, cleanup and
 * wait loops (cd, pkill, sleep, for … do … done, pgrep) are skipped, so
 * `pkill -f x; … (nohup npm run dev &); until … sleep` reads "npm run dev".
 */
export function mainCommand(cmd: string): string {
  const parts = cmd
    .split(/\s*(?:&&|\|\||;|\n|\|)\s*/)
    .map((p) => p.trim().replace(/^[({]\s*/, "").replace(/^(?:do|then|else|nohup|exec|command|time|sudo)\s+/, "").replace(/\s*&?\s*[)}]?\s*&?$/, "").trim())
    .filter(Boolean);
  const skip = /^(cd|export|set|source|\.|echo|printf|date|true|false|:|mkdir|unset|local|pkill|killall|kill|sleep|wait|for|while|until|if|fi|done|break|continue|pgrep|lsof|test|\[|[A-Z_][A-Z0-9_]*=\S*$)(\s|$)/;
  return parts.find((p) => !skip.test(p)) ?? parts[0] ?? cmd;
}

export function describeCommand(cmd: string): Said {
  const c = cmd.trim();
  const waits = /\b(until|while)\b[\s\S]*\bsleep\b|\bfor\b[\s\S]*\bseq\b[\s\S]*\bsleep\b/.test(c);
  if (/\baside\s+repl\b/.test(c)) {
    const h = host(c);
    return h ? S("Aside로 {h} 보기", "Aside로 {h} 보는 중", h, { h }) : S("Aside 브라우저", "Aside 브라우저 쓰는 중");
  }
  if (/\bpr-media\.sh\b/.test(c)) return S("PR에 사진 넣기", "PR에 사진 넣는 중");
  if (/\bgh\b/.test(c)) {
    if (/\bactions\b|\bgh\s+run\b/.test(c)) return waits ? S("GitHub 빌드 기다리기", "GitHub 빌드 기다리는 중") : S("GitHub 빌드 확인", "GitHub 빌드 확인 중");
    if (/\bgh\s+pr\s+create\b/.test(c)) return S("PR 올리기", "PR 올리는 중");
    if (/\bgh\s+pr\s+merge\b/.test(c)) return S("PR 병합", "PR 병합 중");
    if (/\bgh\s+pr\s+(edit|comment|review)\b/.test(c)) return S("PR 고치기", "PR 고치는 중");
    if (/\bgh\s+pr\b|\/pulls\b/.test(c)) return S("PR 확인", "PR 확인 중");
    if (/\bgh\s+issue\b|\/issues\b/.test(c)) return S("이슈 확인", "이슈 확인 중");
    if (/\bgh\s+release\b|\/releases\b/.test(c)) return S("릴리스 확인", "릴리스 확인 중");
    return S("GitHub 조회", "GitHub 조회 중");
  }
  if (waits) return S("기다리기", "기다리는 중");
  const k = core(c);
  const git = k.match(/^git\s+(?:-C\s+\S+\s+)?(\w[\w-]*)/)?.[1];
  if (git) {
    const G: Record<string, [string, string]> = {
      push: ["올리기", "올리는 중"],
      commit: ["커밋", "커밋하는 중"],
      add: ["커밋 준비", "커밋 준비 중"],
      diff: ["바뀐 곳 보기", "바뀐 곳 보는 중"],
      status: ["바뀐 곳 보기", "바뀐 곳 보는 중"],
      log: ["기록 보기", "기록 보는 중"],
      show: ["기록 보기", "기록 보는 중"],
      clone: ["저장소 받기", "저장소 받는 중"],
      fetch: ["최신 받기", "최신 받는 중"],
      pull: ["최신 받기", "최신 받는 중"],
      merge: ["병합", "병합 중"],
      rebase: ["리베이스", "리베이스 중"],
      checkout: ["브랜치 준비", "브랜치 준비 중"],
      switch: ["브랜치 준비", "브랜치 준비 중"],
      worktree: ["워크트리 준비", "워크트리 준비 중"],
    };
    const [l, n] = G[git] ?? ["git", "git 실행 중"];
    return S(l, n);
  }
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(build|bundle)\b|\bcargo\s+build\b|\bxcodebuild\b|\bgradlew\b|\b(vite|next|tauri)\s+build\b|\bexpo\s+(export|prebuild)\b|\beas\s+build\b/.test(k))
    return S("빌드", "빌드 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bpod\s+install\b/.test(k)) return S("설치", "설치하는 중");
  if (/\b(typecheck|lint|eslint|biome|prettier|clippy)\b|\btsc\b|\bcargo\s+check\b/.test(k)) return S("검사|lint", "검사하는 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\btauri\s+dev\b/.test(k)) return S("앱 띄우기", "앱 띄우는 중");
  if (/^(curl|wget|http)\b/.test(k)) {
    const h = host(k);
    return h ? S("{h} 요청", "{h} 요청 중", h, { h }) : S("웹 요청", "웹 요청 중");
  }
  if (/^(python3?|node|deno|bun|ruby|swift|osascript)\s+(-\s*<<|-[ce]\b|<<)/.test(k) || /^(python3?|node)\s+-\s*$/.test(k)) return S("스크립트로 처리", "스크립트로 처리하는 중");
  const script = k.match(/^(?:python3?|node|deno|bun|ruby|bash|sh|zsh|swift)\s+(?:-\S+\s+)*['"]?([^\s'"]+)/)?.[1];
  if (script) return S("{p} 실행", "{p} 실행 중", undefined, { p: script.split("/").pop()! });
  if (/^(pdftoppm|pdftotext|pdfinfo|qpdf|pdfimages)\b/.test(k)) return S("PDF 확인", "PDF 확인 중", file(k));
  if (/^(ffmpeg|ffprobe)\b/.test(k)) return S("영상 처리", "영상 처리 중", file(k));
  if (/^(sips|magick|convert|cwebp|pngquant)\b/.test(k)) return S("이미지 처리", "이미지 처리 중", file(k));
  if (/^(psql|mysql|sqlite3|supabase|prisma)\b/.test(k)) return S("데이터베이스 조회", "데이터베이스 조회 중");
  if (/^docker\b/.test(k)) return S("도커", "도커 쓰는 중");
  if (/^(xcrun|simctl|adb|emulator)\b/.test(k)) return S("기기 다루기", "기기 다루는 중");
  if (/^(cp|mv|rm|ln|rsync|tar|zip|unzip|ditto)\b/.test(k)) return S("파일 정리", "파일 정리 중", file(k));
  if (/^(cat|sed|head|tail|less|wc|nl|awk|jq|grep|rg|find|ls|tree|stat|file|du|diff)\b/.test(k)) return S("살펴보기", "살펴보는 중", file(k));
  if (/^open\b/.test(k)) return S("열기", "여는 중", host(k) ?? file(k));
  if (/^(sleep|wait)\b/.test(k)) return S("기다리기", "기다리는 중");
  const prog = k.match(/^['"]?([^\s'"]+)/)?.[1]?.split("/").pop();
  return prog ? S("{p} 실행", "{p} 실행 중", undefined, { p: prog }) : S("명령 실행", "명령 실행 중");
}
