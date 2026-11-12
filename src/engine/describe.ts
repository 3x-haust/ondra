import { lang, t } from "../i18n";
import { runsProgram } from "./commandKind";

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
  // a browser step as describeBrowser() stores it: "클릭 중 ‘프로 시작하기’"
  for (const [, ing] of [...Object.values(BROWSER_VERBS), ...Object.values(COMPUTER_VERBS)]) if (now.startsWith(`${ing} `)) return `${t(ing)} ${now.slice(ing.length + 1)}`;
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
  { key: "메모리에 저장 · {text}", was: ["메모리 저장 · {text}", "기억함 · {text}"] },
  { key: "이전 작업의 리뷰가 그대로 유효해요", was: ["앞의 일에서 받은 리뷰가 그대로 유효해요"] },
  { key: "작업 전용 브랜치 {b}에서 시작해요" },
  { key: "변경 버림", was: ["변경을 버렸어요"] },
  { key: "{into}에 병합 · 워크트리 정리", was: ["{into}에 병합했어요", "{into}에 합쳤어요"] },
  { key: "워크트리 정리 · 변경은 PR에 있어요", was: ["작업 폴더를 정리했어요. 변경은 PR에 있어요"] },
  { key: "{into} 병합됨 · 워크트리 정리", was: ["{into}이 합쳐져서 작업 폴더를 정리했어요"] },
  { key: "{into}에 이미 반영됨 · 워크트리 정리", was: ["{into}에 이미 들어가서 작업 폴더를 정리했어요"] },
  { key: "재시도 {a}/{m}" },
  { key: "연결이 끊겼어요 · 다시 연결되면 이어서 해요", was: ["연결이 끊겼어요. 다시 연결되면 이어서 해요"] },
  { key: "모델 변경 → {m}" },
  { key: "모델 → {m}" },
  { key: "확인 필요 · {what}", was: ["끝내기 전에 확인 · {what}"] },
  { key: '"{title}" 작업의 결과와 브랜치를 이어받아 시작해요', was: ['"{title}" 일의 결과와 브랜치를 이어받아 새로 시작해요'] },
  { key: '"{title}" 작업의 결과를 이어받아 시작해요', was: ['"{title}" 일의 결과를 이어받아 새로 시작해요'] },
  { key: '브랜치 {b}는 "{title}" 작업으로 넘어갔어요', was: ['브랜치 {b}는 "{title}" 일로 넘어갔어요'] },
  { key: '"{title}" 작업으로 넘어가요', was: ['"{title}" 일로 넘어가요'] },
  { key: "검색 멈춤 · 1분 넘게 결과 없음" },
  { key: "기다림 멈춤 · 2분 넘게 변화 없음" },
  // main looking jobs up (its reply's steps)
  { key: "작업 찾음 · {q}" },
  { key: "작업 찾는 중 · {q}" },
  { key: "작업 살펴봄 · {name}" },
  { key: "작업 살펴보는 중 · {name}" },
  { key: "웹에서 찾는 중 · {q}" },
  { key: "웹에서 찾음 · {q}" },
  { key: "페이지 읽는 중 · {site}" },
  { key: "페이지 읽음 · {site}" },
  { key: "파일 읽는 중 · {name}" },
  { key: "파일 읽음 · {name}" },
  { key: "파일 찾는 중 · {q}" },
  { key: "파일 찾음 · {q}" },
  { key: "명령 실행 중 · {cmd}" },
  { key: "명령 실행함 · {cmd}" },
];
/** what "확인 필요 · …" lists (stored Korean → its key) */
const PROOF_PARTS: Record<string, string> = {
  "리뷰": "리뷰|proof",
  "리뷰 지적": "리뷰 지적|proof",
  "증거": "증거|proof",
  "증거 안 맞음": "증거 안 맞음|proof",
  "남은 작업 있음": "남은 작업 있음|proof",
  "아직 할 일이 남음": "남은 작업 있음|proof",
};
/** effort ids as their words (t() keys), as the model picker shows them */
const EFFORT_WORDS: Record<string, string> = { low: "낮음", medium: "보통", high: "높음", xhigh: "매우 높음", max: "최대" };

/** "openai-codex/gpt-5.6-terra" → "GPT-5.6 Terra", the name the model picker shows */
export function modelName(m: string): string {
  const id = m.split("/").pop() || m;
  return id
    .split("-")
    .map((p, i) => (i === 0 && /^(gpt|o\d)/i.test(p) ? p.toUpperCase() : /^\d/.test(p) || !p ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1")
    .replace(/^Claude (\w+) (\d+) (\d+)/, "Claude $1 $2.$3");
}

/** a model note's "{m}" as stored ("gpt-5.6-terra · high") → "GPT-5.6 Terra · 높음" */
const modelPart = (m: string) => {
  const [id, effort] = m.split(" · ");
  return [modelName(id.trim()), ...(effort ? [EFFORT_WORDS[effort.trim()] ? t(EFFORT_WORDS[effort.trim()]) : effort] : [])].join(" · ");
};

const formRe = (f: string) => ({ keys: [...f.matchAll(/\{(\w+)\}/g)].map((m) => m[1]), re: new RegExp(`^${escape(f).replace(/\{\w+\}/g, "([\\s\\S]+?)")}$`) });
const NOTE_RES = NOTE_FORMS.flatMap(({ key, was = [] }) => [key, ...was].map((f) => ({ key, ...formRe(f) })));

/**
 * A note in a task's thread in the app's language. Notes are stored in Korean
 * ("변경 버림", "main에 병합 · 워크트리 정리"); older wordings read as today's in
 * Korean too. A line that isn't one of Ondra's stays as written.
 */
export function noteText(text: string): string {
  for (const { key, keys, re } of NOTE_RES) {
    const m = text.match(re);
    if (!m) continue;
    const vars: Record<string, string> = {};
    keys.forEach((k, i) => (vars[k] = m[i + 1]));
    if (vars.m && key.startsWith("모델")) vars.m = modelPart(vars.m);
    if (vars.what) vars.what = vars.what.split(" · ").map((p) => (PROOF_PARTS[p] ? t(PROOF_PARTS[p]) : p)).join(" · ");
    return t(key, vars);
  }
  // a bar would read as t()'s context mark
  return text.includes("|") ? text : t(text);
}

/**
 * A title that fits in `max` characters (80: views truncate it with CSS), cut where a
 * word ends with "…" (never mid-word unless one word is longer than half of it).
 */
export function cutTitle(s: string, max = 80): string {
  const x = s.replace(/\s+/g, " ").trim();
  const chars = [...x];
  if (chars.length <= max) return x;
  const head = chars.slice(0, max - 1).join("");
  const at = chars[max - 1] === " " ? head.length : head.lastIndexOf(" ");
  const cut = at >= head.length / 2 ? head.slice(0, at) : head;
  return `${cut.replace(/[\s,.;:·…\-–—(/]+$/, "")}…`;
}

/**
 * One command without what wraps it: leading `VAR=…` assignments (and `export`/`local`
 * of a `$(…)`), `$(`, backticks, `(`, `{`, `sudo`, `env`, `time`, `timeout N`, `nohup`,
 * and the closing `)`/backtick they leave. `list=$(find . -name '*.html')` → `find . -name '*.html'`;
 * a bare assignment (`FOO=1`) comes back empty.
 */
export function unwrapCommand(part: string): string {
  let s = part.trim();
  for (let before = ""; before !== s; ) {
    before = s;
    s = s
      .replace(/^(?:export|local|declare|readonly)\s+(?=[A-Za-z_]\w*=(?:\$\(|`))/, "")
      .replace(/^[A-Za-z_]\w*=(?=\$\(|`)/, "")
      .replace(/^[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|[^\s'"`$()]*)(?:\s+|$)/, "")
      .replace(/^(?:\$\(|`|\(|\{)\s*/, "")
      .replace(/^(?:sudo|env|time|nohup|exec|command|builtin|do|then|else)\s+/, "")
      .replace(/^timeout\s+(?:-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/, "")
      .replace(/^cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/, "")
      .trim();
  }
  // closers the stripped openers left: only when they don't pair with something inside
  const count = (c: string) => s.split(c).length - 1;
  for (let before = ""; before !== s; ) {
    before = s;
    if (/[)}]\s*$/.test(s) && count("(") + count("{") < count(")") + count("}")) s = s.replace(/\s*[)}]\s*$/, "");
    if (/`\s*$/.test(s) && count("`") % 2) s = s.replace(/\s*`\s*$/, "");
  }
  return s.trim();
}

/** The part of a command that matters: no `cd …`, env settings, `date`, echo. */
function core(cmd: string): string {
  const parts = cmd.split(/\s*(?:&&|;|\n)\s*/).map(unwrapCommand).filter(Boolean);
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
    .map((p) => unwrapCommand(p.trim().replace(/\s*&\s*$/, "")).replace(/\s*&$/, ""))
    .filter(Boolean);
  const skip = /^(cd|export|set|source|\.|echo|printf|date|true|false|:|mkdir|unset|local|pkill|killall|kill|sleep|wait|for|while|until|if|fi|done|break|continue|pgrep|lsof|test|\[|[A-Z_][A-Z0-9_]*=\S*$)(\s|$)/;
  return parts.find((p) => !skip.test(p)) ?? parts[0] ?? cmd;
}

/**
 * A command without the package runner in front of it, so the tool it runs picks the verb:
 * `npx vitest run`, `bunx …`, `pnpm exec|dlx …`, `yarn dlx …`, `npm exec -- …` → `vitest run`.
 * `pnpm vitest` (a bin run straight from pnpm/yarn/bun) loses the runner too.
 */
function unrun(k: string): string {
  const s = k
    .replace(/^(?:npx|bunx|pnpx|(?:pnpm|bun|npm)\s+(?:exec|dlx|x)|yarn\s+(?:dlx|exec))\s+(?:--?[\w-]+(?:=\S+)?\s+)*(?:--\s+)?/, "")
    .trim();
  return s.replace(/^(?:pnpm|yarn|bun)\s+(?:-s\s+|--silent\s+)?(?=(?:vitest|jest|playwright|eslint|prettier|tsc|biome|wait-on|mocha|cypress)\b)/, "");
}

export function describeCommand(cmd: string): Said {
  const c = cmd.trim();
  const waits = /\b(until|while)\b[\s\S]*\bsleep\b|\bfor\b[\s\S]*\bseq\b[\s\S]*\bsleep\b/.test(c);
  if (/\baside\s+repl\b/.test(c)) {
    const h = host(c);
    return h ? S("Aside로 {h} 봄", "Aside로 {h} 보는 중", h, { h }) : S("Aside 브라우저 씀", "Aside 브라우저 쓰는 중");
  }
  if (/\bpr-media\.sh\b/.test(c)) return S("PR에 사진 넣음", "PR에 사진 넣는 중");
  if (runsProgram(c, /\bgh\b/)) {
    if (/\bactions\b|\bgh\s+run\b/.test(c)) return waits ? S("GitHub 빌드 기다림", "GitHub 빌드 기다리는 중") : S("GitHub 빌드 확인함", "GitHub 빌드 확인 중");
    if (/\bgh\s+pr\s+create\b/.test(c)) return S("PR 올림", "PR 올리는 중");
    if (/\bgh\s+pr\s+merge\b/.test(c)) return S("PR 병합함", "PR 병합 중");
    if (/\bgh\s+pr\s+(edit|comment|review)\b/.test(c)) return S("PR 고침", "PR 고치는 중");
    if (/\bgh\s+pr\b|\/pulls\b/.test(c)) return S("PR 확인함", "PR 확인 중");
    if (/\bgh\s+issue\b|\/issues\b/.test(c)) return S("이슈 확인함", "이슈 확인 중");
    if (/\bgh\s+release\b|\/releases\b/.test(c)) return S("릴리스 확인함", "릴리스 확인 중");
    return S("GitHub 조회함", "GitHub 조회 중");
  }
  if (waits) return S("기다림", "기다리는 중");
  const k = unrun(core(c));
  if (/^wait-on\b/.test(k)) {
    const on = host(k) ?? words(k).slice(1).find((w) => !w.startsWith("-"))?.replace(/^(?:tcp|http-get|https?-get|file):/, "");
    return S("기다림", "기다리는 중", on);
  }
  if (/^(vitest|jest|mocha|ava|pytest|playwright\s+test|cypress\s+run)\b|^(pnpm|npm|yarn|bun)\s+(?:-\S+\s+)*(run\s+)?test\b|^(cargo|go|swift|deno)\s+test\b|^xcodebuild\b.*\btest\b|^python3?\s+-m\s+pytest\b/.test(k))
    return S("테스트 돌림", "테스트 실행 중");
  const git = k.match(/^git\s+(?:-C\s+\S+\s+)?(\w[\w-]*)/)?.[1];
  if (git) {
    const G: Record<string, [string, string]> = {
      push: ["올림", "올리는 중"],
      commit: ["커밋함", "커밋하는 중"],
      add: ["커밋 준비함", "커밋 준비 중"],
      diff: ["바뀐 곳 봄", "바뀐 곳 보는 중"],
      status: ["바뀐 곳 봄", "바뀐 곳 보는 중"],
      log: ["기록 봄", "기록 보는 중"],
      show: ["기록 봄", "기록 보는 중"],
      clone: ["저장소 받음", "저장소 받는 중"],
      fetch: ["최신 받음", "최신 받는 중"],
      pull: ["최신 받음", "최신 받는 중"],
      merge: ["병합함", "병합 중"],
      rebase: ["리베이스함", "리베이스 중"],
      checkout: ["브랜치 준비함", "브랜치 준비 중"],
      switch: ["브랜치 준비함", "브랜치 준비 중"],
      worktree: ["워크트리 준비함", "워크트리 준비 중"],
    };
    const [l, n] = G[git] ?? ["git 실행함", "git 실행 중"];
    return S(l, n);
  }
  // reading, printing and searching are that, whatever they read or look for:
  // `rg "next build"` is no build, `cat package.json | grep tsc` no check
  if (/^(find|fd|locate|mdfind)\b/.test(k)) return S("파일 찾음", "파일 찾는 중");
  if (/^(grep|egrep|rg|ag|ack|git\s+grep)\b/.test(k)) return S("검색함", "검색 중", file(k));
  if (/^(cat|sed|head|tail|less|wc|nl|awk|jq|ls|tree|stat|file|du|diff)\b/.test(k)) return S("살펴봄", "살펴보는 중", file(k));
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(build|bundle)\b|\bcargo\s+build\b|\bxcodebuild\b|\bgradlew\b|\b(vite|next|tauri)\s+build\b|\bexpo\s+(export|prebuild)\b|\beas\s+build\b/.test(k))
    return S("빌드함", "빌드 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bpod\s+install\b/.test(k)) return S("설치함", "설치하는 중");
  if (/^prettier\b/.test(k) && !/\s--(check|list-different)\b|\s-[cl]\b/.test(k)) return S("정리함", "정리하는 중");
  if (/\b(typecheck|lint|eslint|biome|prettier|clippy)\b|\btsc\b|\bcargo\s+check\b/.test(k)) return S("검사함", "검사하는 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\btauri\s+dev\b/.test(k)) return S("앱 띄움", "앱 띄우는 중");
  if (/^(curl|wget|http)\b/.test(k)) {
    const h = host(k);
    return h ? S("{h} 요청함", "{h} 요청 중", h, { h }) : S("웹 요청함", "웹 요청 중");
  }
  if (/^(python3?|node|deno|bun|ruby|swift|osascript)\s+(-\s*<<|-[ce]\b|<<)/.test(k) || /^(python3?|node)\s+-\s*$/.test(k)) return S("스크립트로 처리함", "스크립트로 처리하는 중");
  const script = k.match(/^(?:python3?|node|deno|bun|ruby|bash|sh|zsh|swift)\s+(?:-\S+\s+)*['"]?([^\s'"]+)/)?.[1];
  if (script) return S("{p} 실행함", "{p} 실행 중", undefined, { p: script.split("/").pop()! });
  if (/^(pdftoppm|pdftotext|pdfinfo|qpdf|pdfimages)\b/.test(k)) return S("PDF 확인함", "PDF 확인 중", file(k));
  if (/^(ffmpeg|ffprobe)\b/.test(k)) return S("영상 처리함", "영상 처리 중", file(k));
  if (/^(sips|magick|convert|cwebp|pngquant)\b/.test(k)) return S("이미지 처리함", "이미지 처리 중", file(k));
  if (/^(psql|mysql|sqlite3|supabase|prisma)\b/.test(k)) return S("데이터베이스 조회함", "데이터베이스 조회 중");
  if (/^docker\b/.test(k)) return S("도커 씀", "도커 쓰는 중");
  if (/^(xcrun|simctl|adb|emulator)\b/.test(k)) return S("기기 다룸", "기기 다루는 중");
  if (/^(cp|mv|rm|ln|rsync|tar|zip|unzip|ditto)\b/.test(k)) return S("파일 정리함", "파일 정리 중", file(k));
  if (/^open\b/.test(k)) return S("열었음", "여는 중", host(k) ?? file(k));
  if (/^(sleep|wait)\b/.test(k)) return S("기다림", "기다리는 중");
  // a program's name, never shell syntax ("list=$(find")
  const prog = k.match(/^['"]?([^\s'"]+)/)?.[1]?.split("/").pop();
  return prog && /^[\w.@+-]+$/.test(prog) ? S("{p} 실행함", "{p} 실행 중", undefined, { p: prog }) : S("명령 실행함", "명령 실행 중");
}

/**
 * Browser steps by action: [done, going on now] as t() keys. The verb leads and the
 * target follows ("열었음 acme.dev/pricing", "클릭 중 ‘프로 시작하기’"), so a row reads
 * the same in both languages. "브라우저 씀" is only for an action this doesn't know.
 */
const BROWSER_VERBS = {
  open: ["열었음", "여는 중"],
  read: ["페이지 읽음", "페이지 읽는 중"],
  click: ["클릭함", "클릭 중"],
  dblclick: ["더블클릭함", "더블클릭 중"],
  type: ["입력함", "입력 중"],
  press: ["키 누름", "키 누르는 중"],
  hover: ["가리킴", "가리키는 중"],
  focus: ["포커스함", "포커스 중"],
  check: ["체크함", "체크 중"],
  uncheck: ["체크 해제함", "체크 해제 중"],
  select: ["선택함", "선택 중"],
  drag: ["끌어다 놓음", "끌어다 놓는 중"],
  upload: ["파일 올림", "파일 올리는 중"],
  download: ["내려받음", "내려받는 중"],
  scroll: ["스크롤함", "스크롤 중"],
  screenshot: ["화면 캡처함", "화면 캡처 중"],
  pdf: ["PDF로 저장함", "PDF로 저장 중"],
  eval: ["스크립트 실행함", "스크립트 실행 중"],
  wait: ["기다림", "기다리는 중"],
  load: ["페이지 로드 기다림", "페이지 로드 기다리는 중"],
  verify: ["확인함", "확인 중"],
  back: ["뒤로 감", "뒤로 가는 중"],
  forward: ["앞으로 감", "앞으로 가는 중"],
  reload: ["새로고침함", "새로고침 중"],
  tab: ["탭 전환함", "탭 전환 중"],
  close: ["브라우저 닫음", "브라우저 닫는 중"],
  set: ["브라우저 설정함", "브라우저 설정 중"],
  connect: ["브라우저 연결함", "브라우저 연결 중"],
  mouse: ["마우스 조작함", "마우스 조작 중"],
  other: ["브라우저 씀", "브라우저 쓰는 중"],
} as const satisfies Record<string, readonly [string, string]>;
export type BrowserAction = keyof typeof BROWSER_VERBS;
const BROWSER_ALIAS: Record<string, BrowserAction> = {
  open: "open", goto: "open", navigate: "open", read: "read", snapshot: "read", get: "read",
  click: "click", tap: "click", dblclick: "dblclick", type: "type", fill: "type", keyboard: "type",
  press: "press", key: "press", hover: "hover", focus: "focus", check: "check", uncheck: "uncheck",
  select: "select", drag: "drag", upload: "upload", download: "download", scroll: "scroll",
  scrollintoview: "scroll", screenshot: "screenshot", pdf: "pdf", eval: "eval", wait: "wait", is: "verify",
  back: "back", forward: "forward", reload: "reload", tab: "tab", close: "close", set: "set",
  connect: "connect", mouse: "mouse",
  // browse (the browser-use skill's lean loop over agent-browser)
  look: "read", shot: "screenshot", visuals: "set",
};
const alias = (w: string): BrowserAction | undefined => (Object.prototype.hasOwnProperty.call(BROWSER_ALIAS, w.toLowerCase()) ? BROWSER_ALIAS[w.toLowerCase()] : undefined);
/** stored descriptions ("acme.dev/pricing 열기", "‘프로 시작하기’ 클릭"): the verb comes last */
const BROWSER_KO: Record<string, BrowserAction> = { 열기: "open", 클릭: "click", 입력: "type", 선택: "select", 스크롤: "scroll", 캡처: "screenshot" };

/** words of a command, quotes taken off ('a b', "a b", ‘a b’ stay one word) */
const words = (s: string) => [...s.matchAll(/'([^']*)'|"([^"]*)"|‘([^’]*)’|“([^”]*)”|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
/** an address without its scheme, www or trailing slash */
const address = (s: string) => s.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\/$/, "");
const quoted = (s: string) => {
  const x = s.replace(/\s+/g, " ").trim();
  return x ? `‘${[...x].length > 40 ? `${[...x].slice(0, 39).join("")}…` : x}’` : undefined;
};
/** what a selector points at, in words: text=Start Pro, [name="Start Pro"], a bare label; refs (@e3) say nothing */
function element(sel: string | undefined): string | undefined {
  if (!sel || /^@?e\d+$/.test(sel)) return undefined;
  const named = sel.match(/(?:name|aria-label|title|placeholder)\s*[=:]\s*["']?([^"'\]]+)/)?.[1] ?? sel.match(/^(?:text|label)\s*[=:]\s*["']?(.+?)["']?$/)?.[1];
  if (named) return quoted(named);
  return /^[#.[]|[>~:=[\]]/.test(sel) ? sel : quoted(sel);
}

/** flags that take the next word as their value */
const FLAG_VALUE = /^--(session|profile|timeout|port|cdp|headers|executable-path|proxy|user-agent|state|name|account|load|url|text|fn)$/;

/** what only looks or waits, next to the step that does something */
const PASSIVE: BrowserAction[] = ["read", "screenshot", "wait", "load", "verify", "other"];
/** the program in front of a browser command: agent-browser, or the skill's `browse` */
const BROWSER_PROGRAM = /^.*?(?:\bagent-browser|(?:^|\/)browse)\s+/;

/** one agent-browser command (its words after `agent-browser` and its --flags) */
function browserStep(w: string[]): { action: BrowserAction; target?: string } {
  const args = w.filter((x, i) => !x.startsWith("--") && !FLAG_VALUE.test(w[i - 1] ?? ""));
  const [cmd = "", ...rest] = args;
  const name = w.find((_, i) => w[i - 1] === "--name");
  // browse do "fill @e3 x" "click @e5": the step among its commands that does something
  if (cmd === "do") {
    const steps = rest.map((x) => browserStep(words(x)));
    return steps.find((s) => !PASSIVE.includes(s.action)) ?? steps.find((s) => s.action !== "other") ?? { action: "other" };
  }
  let action: BrowserAction = alias(cmd) ?? "other";
  switch (action) {
    case "open":
      return { action, target: rest[0] ? address(rest[0]) : undefined };
    case "read":
      return { action, target: cmd === "read" && rest[0] && /[./]/.test(rest[0]) ? address(rest[0]) : undefined };
    case "type":
      // type/fill <sel> <text>, keyboard type <text>
      return { action, target: quoted(rest.slice(1).join(" ")) ?? (cmd === "keyboard" ? undefined : element(rest[0])) };
    case "press":
      return { action, target: rest[0] };
    case "select":
      return { action, target: quoted(rest.slice(1).join(", ")) ?? element(rest[0]) };
    case "upload":
      return { action, target: rest.slice(1).map((f) => f.split("/").pop()).join(", ") || undefined };
    case "download":
    case "pdf":
      return { action, target: (cmd === "pdf" ? rest[0] : rest[1])?.split("/").pop() };
    case "scroll":
      return { action, target: cmd === "scrollintoview" ? element(rest[0]) : undefined };
    case "wait": {
      // wait --load <state>: the page loading, not a quoted "networkidle"; --url / --text: what it waits for
      const flag = (f: string) => w[w.indexOf(f) + 1];
      if (w.includes("--load")) return { action: "load" };
      if (w.includes("--url")) return { action, target: flag("--url") ? address(flag("--url")) : undefined };
      if (w.includes("--text")) return { action, target: quoted(flag("--text") ?? "") };
      if (w.includes("--fn")) return { action };
      return { action, target: rest[0] && !/^\d+$/.test(rest[0]) ? element(rest[0]) : undefined };
    }
    case "tab":
      if (rest[0] === "new") return { action: "open", target: rest[1] ? address(rest[1]) : undefined };
      return { action };
    case "set":
      return { action, target: rest[0] === "viewport" && rest[2] ? `${rest[1]}×${rest[2]}` : rest[0] === "device" ? rest.slice(1).join(" ") || undefined : undefined };
    case "click":
    case "dblclick":
    case "hover":
    case "focus":
    case "check":
    case "uncheck":
      return { action, target: name ? quoted(name) : element(rest[0]) };
    case "other":
      // find <locator> <value> <action> [text]: the action at the end, on what was found
      if (cmd === "find") {
        const at = rest.findIndex((x, i) => i >= 1 && !!alias(x));
        if (at > 0) {
          action = alias(rest[at])!;
          const text = rest.slice(at + 1).join(" ");
          return { action, target: action === "type" && text ? quoted(text) : quoted(name ?? (/^(first|last|nth)$/.test(rest[0]) ? rest[at - 1] : rest[1])) };
        }
      }
      return { action };
    default:
      return { action };
  }
}

/**
 * A browser step in plain words, from what was run (`open https://acme.dev/pricing`,
 * `click @e3`, a chain of agent-browser calls) or a stored description
 * ("acme.dev/pricing 열기"). `label` is the step done ("열었음"), `now` the step going
 * on ("여는 중"), `target` what it worked on ("acme.dev/pricing", "‘프로 시작하기’");
 * show them verb first. `action` is "other" when it isn't one this knows ("브라우저 씀").
 */
export function describeBrowser(cmd: string): Said & { action: BrowserAction } {
  const c = cmd.trim();
  const ko = c.match(/^(.+?)\s+(열기|클릭|입력|선택|스크롤|캡처)$/);
  let step: { action: BrowserAction; target?: string };
  if (ko) {
    const action = BROWSER_KO[ko[2]];
    const x = ko[1].trim();
    step = { action, target: action === "open" ? address(x) : /^['"‘“]/.test(x) ? quoted(words(x).join(" ")) : x };
  } else if (/^(https?:\/\/|www\.)/.test(c)) step = { action: "open", target: address(c.split(/\s/)[0]) };
  else {
    // a chain: the step that does something (open a page, click) over the looking around it
    const steps = c
      .split(/\s*(?:&&|\|\||;|\n|\|)\s*/)
      .map((p) => p.replace(BROWSER_PROGRAM, ""))
      .filter((p) => p && !/^(sleep|echo|cd|timeout|true)\b/.test(p))
      .map((p) => browserStep(words(p)));
    step = steps.find((s) => !PASSIVE.includes(s.action)) ?? steps.find((s) => s.action !== "other") ?? steps[0] ?? { action: "other" };
  }
  const [label, now] = BROWSER_VERBS[step.action];
  return { label: t(label), now: t(now), nowKo: step.target ? `${now} ${step.target}` : now, target: step.target, action: step.action };
}

/** A computer-use step (extensions/computer.ts), done / going on, the verb before the target. */
export type ComputerAction = "open" | "look" | "read" | "click" | "dblclick" | "menu" | "type" | "press" | "scroll" | "drag" | "stop" | "other";
const COMPUTER_VERBS: Record<ComputerAction, [string, string]> = {
  open: ["열었음", "여는 중"],
  look: ["화면 봄", "화면 보는 중"],
  read: ["화면 읽음", "화면 읽는 중"],
  click: ["클릭함", "클릭 중"],
  dblclick: ["더블클릭함", "더블클릭 중"],
  menu: ["메뉴 엶", "메뉴 여는 중"],
  type: ["입력함", "입력 중"],
  press: ["키 누름", "키 누르는 중"],
  scroll: ["스크롤함", "스크롤 중"],
  drag: ["끌어다 놓음", "끌어다 놓는 중"],
  stop: ["앱 사용 마침", "앱 사용 마치는 중"],
  other: ["앱 조작함", "앱 조작 중"],
};
const SCROLL_WAY: Record<string, string> = { up: "위로", down: "아래로", left: "왼쪽으로", right: "오른쪽으로" };

/**
 * What a computer call does, from its arguments: the step and what it worked on (the app
 * opened, the text typed, the key, the scroll direction). A click's element is named once
 * the call returns (its label, see tasks.ts).
 */
export function computerStep(args: any): { action: ComputerAction; target?: string } {
  // several steps in one call: named by the first ("입력함 ‘hello’")
  const input = args?.input ?? (Array.isArray(args?.steps) ? args.steps[0] : undefined) ?? {};
  switch (args?.action) {
    case "start":
      return { action: "open", target: typeof args.app === "string" ? args.app : undefined };
    case "look":
      return { action: "look" };
    case "observe":
      return { action: "read" };
    case "stop":
      return { action: "stop" };
    case "act":
      switch (input.kind) {
        case "click":
        case "click-at":
          return { action: input.button === "right" ? "menu" : input.count === 2 ? "dblclick" : "click" };
        case "type":
        case "set-value":
          return { action: "type", target: quoted(String(input.text ?? input.value ?? "")) };
        case "press": {
          const mods = Array.isArray(input.modifiers) ? input.modifiers.filter((m: unknown) => typeof m === "string") : [];
          return { action: "press", target: typeof input.key === "string" ? [...mods, input.key].join("+") : undefined };
        }
        case "scroll":
          return { action: "scroll", target: typeof input.direction === "string" ? input.direction : undefined };
        case "drag":
          return { action: "drag" };
        case "action":
          return { action: "click" };
      }
  }
  return { action: "other" };
}

/** A computer step in plain words: "클릭함 ‘보내기’", "스크롤 중 아래로", "열었음 Instagram". */
export function describeComputer(action: string | undefined, target?: string): Said {
  const [label, now] = COMPUTER_VERBS[(action as ComputerAction) in COMPUTER_VERBS ? (action as ComputerAction) : "other"];
  const said = action === "scroll" && target && SCROLL_WAY[target] ? SCROLL_WAY[target] : target;
  return { label: t(label), now: t(now), nowKo: said ? `${now} ${said}` : now, target: said ? (action === "scroll" ? t(said) : said) : undefined };
}

/** An element's label as a click target: ‘보내기’. */
export const computerLabel = (label: string) => quoted(label);
