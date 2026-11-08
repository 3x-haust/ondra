import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import { cutTitle, mainCommand, noteText, nowText, describeCommand as d } from "./describe";

describe("describeCommand", () => {
  it("names what commands do, not the command", () => {
    expect(d(`aside repl --account u5 "const pb = await openTab('https://play.google.com/console/u/0'); console.log(1)"`).label).toBe("Aside로 play.google.com 보기");
    expect(d(`date -u +%H:%MZ; gh api repos/a/b/actions/jobs/12771658931 --jq '.status'`).label).toBe("GitHub 빌드 확인");
    expect(d(`for i in $(seq 1 7); do s=$(gh api repos/a/b/actions/jobs/1 --jq .status); [ "$s" = completed ] && break; sleep 60; done`).label).toBe("GitHub 빌드 기다리기");
    expect(d(`gh pr create --base dev --title x --body y`).label).toBe("PR 올리기");
    expect(d(`cd /x && git push -u origin feat/a`).label).toBe("올리기");
    expect(d(`python3 - <<'PY'\nprint(1)\nPY`).label).toBe("스크립트로 처리");
    expect(d(`python3 '/Users/me/artifacts/build_report.py' --out x`).label).toBe("build_report.py 실행");
    expect(d(`pdftoppm -png -r 80 report.pdf page`).label).toBe("PDF 확인");
    expect(d(`pnpm -s typecheck && pnpm -s test`).label).toBe("검사");
    expect(d(`curl -s https://api.example.com/v1/x`).target).toBe("api.example.com");
    expect(d(`sed -n 1,80p src/views/Canvas.tsx`)).toMatchObject({ label: "살펴보기", target: "Canvas.tsx" });
    expect(d(`export FOO=1; jq . data.json`).label).toBe("살펴보기");
    expect(d(`weird-tool --flag`).label).toBe("weird-tool 실행");
  });
});

describe("mainCommand", () => {
  it("skips setup, cleanup and wait loops", () => {
    const c = `pkill -f "scripts/dev.mjs" ; for i in $(seq 1 20); do pgrep -f "x" >/dev/null || break; sleep 1; done; pgrep -fl yomates-appshot; cd /a/app && (nohup npm run dev -- --port 9333 > /tmp/l 2>&1 &); for i in $(seq 1 90); do curl -s localhost:9333/json >/dev/null && break; sleep 2; done`;
    expect(mainCommand(c).startsWith("npm run dev")).toBe(true);
    expect(mainCommand("cd /x && pnpm test")).toBe("pnpm test");
    expect(mainCommand("git status")).toBe("git status");
  });
});

describe("nowText", () => {
  it("keeps the stored Korean line in Korean and shows it in English", () => {
    setState("settings", "language", "ko");
    // stored lines are Korean whatever the app's language
    expect(d("python3 tool.py").nowKo).toBe("tool.py 실행 중");
    expect(nowText("router.ts 읽는 중")).toBe("router.ts 읽는 중");
    setState("settings", "language", "en");
    expect(d("python3 tool.py").nowKo).toBe("tool.py 실행 중");
    expect(nowText("테스트 실행 중")).toBe("Running tests");
    expect(nowText("일시정지됨")).toBe("Paused");
    expect(nowText("router.ts 읽는 중")).toBe("Reading router.ts");
    expect(nowText("NOTES.md에 적는 중")).toBe("Writing to NOTES.md");
    expect(nowText("tool.py 실행 중")).toBe("Running tool.py");
    expect(nowText("서브에이전트 1개 기다리는 중")).toBe("Waiting for 1 subagent");
    expect(nowText("서브에이전트 3개 기다리는 중")).toBe("Waiting for 3 subagents");
    // what the model wrote stays as written
    expect(nowText("프로 요금제 결제 버튼을 누르는 중")).toBe("프로 요금제 결제 버튼을 누르는 중");
    expect(nowText("a | b")).toBe("a | b");
    setState("settings", "language", "ko");
  });
});

describe("noteText", () => {
  it("shows Ondra's notes in the app's language and old wordings as today's", () => {
    setState("settings", "language", "ko");
    expect(noteText("main에 병합했어요")).toBe("main에 병합했어요");
    // stored before the wording changed
    expect(noteText("main에 합쳤어요")).toBe("main에 병합했어요");
    expect(noteText('브랜치 feat/a는 "로그인 고치기" 일로 넘어갔어요')).toBe('브랜치 feat/a는 "로그인 고치기" 작업으로 넘어갔어요');
    expect(noteText("기억함 · pnpm만 써요")).toBe("메모리 저장 · pnpm만 써요");
    expect(noteText("끝내기 전에 확인 · 아직 할 일이 남음")).toBe("끝내기 전에 확인 · 남은 작업 있음");
    setState("settings", "language", "en");
    expect(noteText("변경을 버렸어요")).toBe("Changes discarded");
    expect(noteText("일시정지")).toBe("Paused");
    expect(noteText("main에 병합했어요")).toBe("Merged into main");
    expect(noteText("작업 전용 브랜치 task/t1에서 시작해요")).toBe("Started on its own branch task/t1");
    expect(noteText("재시도 1/3")).toBe("Retry 1/3");
    expect(noteText("모델 변경 → gpt-5.5")).toBe("Model changed → gpt-5.5");
    expect(noteText("모델 → opus · high")).toBe("Model → opus · high");
    expect(noteText("기억함 · pnpm만 써요")).toBe("Memory saved · pnpm만 써요");
    expect(noteText("끝내기 전에 확인 · 리뷰 · 증거")).toBe("Checked before finishing · review · evidence");
    expect(noteText('"로그인 고치기" 작업으로 넘어가요')).toBe('Handing over to "로그인 고치기"');
    expect(noteText('"A" 일의 결과와 브랜치를 이어받아 새로 시작해요')).toBe('Continues from "A" with its results and branch');
    expect(noteText("PR #12 병합됨 · 워크트리 정리")).toBe("PR #12 merged · worktree cleaned up");
    // not one of Ondra's notes
    expect(noteText("그냥 메모")).toBe("그냥 메모");
    expect(noteText("a | b")).toBe("a | b");
    setState("settings", "language", "ko");
  });

  it("has English for every note the engine writes, none with 일", () => {
    setState("settings", "language", "en");
    const stored = [
      "이전 작업의 리뷰가 그대로 유효해요", "리뷰가 아직 진행 중이에요", "리뷰는 이미 한 번 받았어요", "워크트리 정리 · 변경은 PR에 있어요",
      "컨텍스트 압축 중", "연결이 끊겼어요 · 다시 연결되면 이어서 해요", "main에 이미 반영됨 · 워크트리 정리", "같은 검사 반복", "같은 실패 반복",
      '"A" 작업의 결과를 이어받아 시작해요', "끝내기 전에 확인 · 리뷰 지적 · 증거 안 맞음 · 남은 작업 있음",
    ];
    for (const s of stored) {
      expect(noteText(s), s).not.toMatch(/[가-힣]/);
      expect(s, s).not.toMatch(/(^|\s|")일(의|로|이|을|에)?\s/);
    }
    setState("settings", "language", "ko");
  });
});

describe("cutTitle", () => {
  it("keeps a short title whole", () => {
    expect(cutTitle("  로그인 리다이렉트 고치기 ")).toBe("로그인 리다이렉트 고치기");
  });
  it("cuts a long one where a word ends", () => {
    const long = "로그인 후 원래 보던 페이지로 돌아가게 리다이렉트 처리를 고치고 테스트까지 추가하기";
    const c = cutTitle(long);
    expect(c.endsWith("…")).toBe(true);
    expect([...c].length).toBeLessThanOrEqual(40);
    // the part before … is whole words of the original
    expect(long.startsWith(c.slice(0, -1))).toBe(true);
    expect(long[c.length - 1]).toBe(" ");
    expect(cutTitle("Fix the login redirect so people land on the page they were reading")).toBe("Fix the login redirect so people land…");
  });
  it("cuts one very long word where it must", () => {
    const c = cutTitle("a".repeat(60));
    expect(c).toBe(`${"a".repeat(39)}…`);
  });
});
