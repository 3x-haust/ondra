/**
 * A shell command in plain words, for the canvas and the "now" line: what it does
 * ("GitHub 빌드 확인") and on what, never the command itself. No model involved.
 */
export interface Said {
  /** short, for a list of steps: "PR 올리기" */
  label: string;
  /** going on now: "PR 올리는 중" */
  now: string;
  /** the file, site or thing it works on */
  target?: string;
}

const host = (s: string) => s.match(/https?:\/\/(?:www\.)?([^/'"\s)]+)/)?.[1];
const file = (s: string) => {
  const m = [...s.matchAll(/(?:^|\s)['"]?((?:~|\.{0,2})?\/?[\w.\-@가-힣/ ]*?[\w\-가-힣]+\.[A-Za-z0-9]{1,6})['"]?(?=\s|$|;|\|)/g)].map((x) => x[1]).filter((x) => !/^\d+(\.\d+)*$/.test(x));
  const f = m[m.length - 1];
  return f ? f.split("/").filter(Boolean).pop() : undefined;
};
const S = (label: string, now: string, target?: string): Said => ({ label, now, target });

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
    return h ? S(`Aside로 ${h} 보기`, `Aside로 ${h} 보는 중`, h) : S("Aside 브라우저", "Aside 브라우저 쓰는 중");
  }
  if (/\bpr-media\.sh\b/.test(c)) return S("PR에 사진 넣기", "PR에 사진 넣는 중");
  if (/\bgh\b/.test(c)) {
    if (/\bactions\b|\bgh\s+run\b/.test(c)) return waits ? S("GitHub 빌드 기다리기", "GitHub 빌드 기다리는 중") : S("GitHub 빌드 확인", "GitHub 빌드 확인 중");
    if (/\bgh\s+pr\s+create\b/.test(c)) return S("PR 올리기", "PR 올리는 중");
    if (/\bgh\s+pr\s+merge\b/.test(c)) return S("PR 합치기", "PR 합치는 중");
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
      merge: ["합치기", "합치는 중"],
      rebase: ["합치기", "합치는 중"],
      checkout: ["브랜치 준비", "브랜치 준비 중"],
      switch: ["브랜치 준비", "브랜치 준비 중"],
      worktree: ["작업 폴더 준비", "작업 폴더 준비 중"],
    };
    const [l, n] = G[git] ?? ["git", "git 쓰는 중"];
    return S(l, n);
  }
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(build|bundle)\b|\bcargo\s+build\b|\bxcodebuild\b|\bgradlew\b|\b(vite|next|tauri)\s+build\b|\bexpo\s+(export|prebuild)\b|\beas\s+build\b/.test(k))
    return S("빌드", "빌드 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b|\bpod\s+install\b/.test(k)) return S("설치", "설치하는 중");
  if (/\b(typecheck|lint|eslint|biome|prettier|clippy)\b|\btsc\b|\bcargo\s+check\b/.test(k)) return S("검사", "검사하는 중");
  if (/\b(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\btauri\s+dev\b/.test(k)) return S("앱 띄우기", "앱 띄우는 중");
  if (/^(curl|wget|http)\b/.test(k)) {
    const h = host(k);
    return S(h ? `${h} 요청` : "웹 요청", h ? `${h} 요청 중` : "웹 요청 중", h);
  }
  if (/^(python3?|node|deno|bun|ruby|swift|osascript)\s+(-\s*<<|-[ce]\b|<<)/.test(k) || /^(python3?|node)\s+-\s*$/.test(k)) return S("스크립트로 처리", "스크립트로 처리하는 중");
  const script = k.match(/^(?:python3?|node|deno|bun|ruby|bash|sh|zsh|swift)\s+(?:-\S+\s+)*['"]?([^\s'"]+)/)?.[1];
  if (script) return S(`${script.split("/").pop()} 실행`, `${script.split("/").pop()} 실행 중`);
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
  return prog ? S(`${prog} 실행`, `${prog} 실행 중`) : S("명령 실행", "명령 실행 중");
}
