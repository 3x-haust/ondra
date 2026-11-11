import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import { computerStep, cutTitle, describeBrowser as b, describeComputer, mainCommand, noteText, nowText, unwrapCommand, describeCommand as d } from "./describe";

describe("describeCommand", () => {
  it("names what commands do, not the command", () => {
    expect(d(`aside repl --account u5 "const pb = await openTab('https://play.google.com/console/u/0'); console.log(1)"`).label).toBe("Aside로 play.google.com 봄");
    expect(d(`date -u +%H:%MZ; gh api repos/a/b/actions/jobs/12771658931 --jq '.status'`).label).toBe("GitHub 빌드 확인함");
    expect(d(`for i in $(seq 1 7); do s=$(gh api repos/a/b/actions/jobs/1 --jq .status); [ "$s" = completed ] && break; sleep 60; done`).label).toBe("GitHub 빌드 기다림");
    expect(d(`gh pr create --base dev --title x --body y`).label).toBe("PR 올림");
    expect(d(`cd /x && git push -u origin feat/a`).label).toBe("올림");
    expect(d(`python3 - <<'PY'\nprint(1)\nPY`).label).toBe("스크립트로 처리함");
    expect(d(`python3 '/Users/me/artifacts/build_report.py' --out x`).label).toBe("build_report.py 실행함");
    expect(d(`pdftoppm -png -r 80 report.pdf page`).label).toBe("PDF 확인함");
    expect(d(`pnpm -s typecheck && pnpm -s test`).label).toBe("검사함");
    expect(d(`curl -s https://api.example.com/v1/x`).target).toBe("api.example.com");
    expect(d(`sed -n 1,80p src/views/Canvas.tsx`)).toMatchObject({ label: "살펴봄", target: "Canvas.tsx" });
    expect(d(`export FOO=1; jq . data.json`).label).toBe("살펴봄");
    expect(d(`weird-tool --flag`).label).toBe("weird-tool 실행함");
  });

  it("says a done step in its past form", () => {
    setState("settings", "language", "ko");
    expect(d("sleep 5").label).toBe("기다림");
    expect(d("find src -name '*.ts'").label).toBe("파일 찾음");
    expect(d("rg isAuthed src").label).toBe("검색함");
    expect(d("pnpm install").label).toBe("설치함");
    expect(d("pnpm build").label).toBe("빌드함");
    expect(d("git commit -m x").label).toBe("커밋함");
    expect(d("git status").label).toBe("바뀐 곳 봄");
    setState("settings", "language", "en");
    expect(d("sleep 5")).toMatchObject({ label: "Waited", now: "Waiting" });
    expect(d("git push").label).toBe("Pushed");
    expect(d("rg x").label).toBe("Searched");
    setState("settings", "language", "ko");
  });

  it("looks past package runners for the tool they run", () => {
    setState("settings", "language", "ko");
    expect(d("npx vitest run")).toMatchObject({ label: "테스트 돌림", now: "테스트 실행 중" });
    expect(d("npx playwright test e2e/login.spec.ts").label).toBe("테스트 돌림");
    expect(d("pnpm exec vitest run auth").label).toBe("테스트 돌림");
    expect(d("bunx jest").label).toBe("테스트 돌림");
    expect(d("yarn dlx prettier --write src").label).toBe("정리함");
    expect(d("npx prettier --check .").label).toBe("검사함");
    expect(d("npx -y tsc --noEmit").label).toBe("검사함");
    expect(d("pnpm -s test").label).toBe("테스트 돌림");
    expect(d("npx wait-on http://localhost:3000 && curl -s localhost:3000/api/checkout")).toMatchObject({ label: "기다림", now: "기다리는 중", target: "localhost:3000" });
    expect(d("npx wait-on tcp:5173").target).toBe("5173");
    setState("settings", "language", "en");
    expect(d("npx prettier --write .").label).toBe("Formatted");
    expect(d("npx vitest run").label).toBe("Ran tests");
    setState("settings", "language", "ko");
  });
});

describe("describeBrowser", () => {
  it("names the step by its action, verb first, with what it worked on", () => {
    setState("settings", "language", "ko");
    expect(b("open https://www.acme.dev/pricing/")).toMatchObject({ label: "열었음", now: "여는 중", target: "acme.dev/pricing", action: "open" });
    expect(b("acme.dev/pricing 열기")).toMatchObject({ label: "열었음", target: "acme.dev/pricing" });
    expect(b("‘프로 시작하기’ 클릭")).toMatchObject({ now: "클릭 중", target: "‘프로 시작하기’", nowKo: "클릭 중 ‘프로 시작하기’" });
    expect(b(`click "text=Start Pro"`).target).toBe("‘Start Pro’");
    expect(b("click @e3")).toMatchObject({ label: "클릭함", target: undefined, action: "click" });
    expect(b(`fill @e2 "me@acme.dev"`)).toMatchObject({ label: "입력함", target: "‘me@acme.dev’" });
    expect(b("press Enter")).toMatchObject({ label: "키 누름", target: "Enter" });
    expect(b(`find role button click --name "Sign in"`)).toMatchObject({ label: "클릭함", target: "‘Sign in’" });
    expect(b("snapshot -i").label).toBe("페이지 읽음");
    expect(b("screenshot /tmp/a.png")).toMatchObject({ label: "화면 캡처함", target: undefined });
    expect(b("set viewport 1440 900").target).toBe("1440×900");
    // waiting for the page to load, not a quoted load state
    expect(b("wait --load networkidle")).toMatchObject({ label: "페이지 로드 기다림", now: "페이지 로드 기다리는 중", target: undefined });
    expect(b("wait --url https://acme.dev/done").target).toBe("acme.dev/done");
    expect(b("wait 1000")).toMatchObject({ label: "기다림", target: undefined });
    // a chain: the step that does something, not the look around it
    expect(b("open https://acme.dev && agent-browser --session s wait 1000 && agent-browser snapshot -i")).toMatchObject({ label: "열었음", target: "acme.dev" });
    expect(b("cookies clear")).toMatchObject({ label: "브라우저 씀", action: "other" });
    // browse, the skill's lean loop: its own verbs, and the step inside a `do` batch
    expect(b("browse open https://acme.dev/pricing")).toMatchObject({ label: "열었음", target: "acme.dev/pricing" });
    expect(b("/x/browser-use/browse read https://acme.dev/docs --section Auth")).toMatchObject({ label: "페이지 읽음", target: "acme.dev/docs" });
    expect(b(`browse do "fill @e3 kim" "click @e5" --read`)).toMatchObject({ label: "입력함", target: "‘kim’" });
    expect(b(`browse do "wait --text Saved" "click @e5"`)).toMatchObject({ label: "클릭함" });
    expect(b("browse look -s main").label).toBe("페이지 읽음");
    expect(b("browse shot /tmp/a.png").label).toBe("화면 캡처함");
    setState("settings", "language", "en");
    expect(b("open https://acme.dev/pricing")).toMatchObject({ label: "Opened", now: "Opening", nowKo: "여는 중 acme.dev/pricing" });
    expect(b("‘프로 시작하기’ 클릭").now).toBe("Clicking");
    expect(b("wait --load networkidle").label).toBe("Waited for page load");
    expect(nowText("페이지 로드 기다리는 중")).toBe("Waiting for page load");
    expect(nowText("클릭 중 ‘Start Pro’")).toBe("Clicking ‘Start Pro’");
    setState("settings", "language", "ko");
  });
});

describe("shell wrappers", () => {
  it("names the real program, never the assignment or subshell around it", () => {
    setState("settings", "language", "ko");
    expect(d(`list=$(find . -name '*.html')`)).toMatchObject({ label: "파일 찾음", now: "파일 찾는 중" });
    expect(mainCommand(`list=$(find . -name '*.html')`)).toBe(`find . -name '*.html'`);
    expect(d("cd web && pnpm build").label).toBe("빌드함");
    // what a read or a search looks at or for is not what runs
    expect(d(`rg -n "next build|pnpm install" package.json docs`).label).toBe("검색함");
    expect(d(`cat package.json | grep -n "tsc\\|lint"`).label).toBe("살펴봄");
    expect(d(`sed -n 1,40p scripts/build.sh`).label).toBe("살펴봄");
    expect(d(`rg -n "gh pr create" skills/`).label).toBe("검색함");
    expect(mainCommand("cd web && pnpm build")).toBe("pnpm build");
    expect(d("FOO=1 BAR=2 node x.js").label).toBe("x.js 실행함");
    expect(mainCommand("FOO=1 BAR=2 node x.js")).toBe("node x.js");
    expect(d("timeout 30 rg foo")).toMatchObject({ label: "검색함", now: "검색 중" });
    expect(mainCommand("timeout 30 rg foo")).toBe("rg foo");
    expect(d("(cd a; ls)").label).toBe("살펴봄");
    expect(mainCommand("(cd a; ls)")).toBe("ls");
    expect(unwrapCommand("sudo env time npm test")).toBe("npm test");
    expect(unwrapCommand("out=`git rev-parse HEAD`")).toBe("git rev-parse HEAD");
    expect(unwrapCommand("echo $(date)")).toBe("echo $(date)");
    expect(unwrapCommand("FOO=1")).toBe("");
    // shell syntax never becomes the verb
    expect(d("x=$(./weird)").label).toBe("weird 실행함");
    expect(d(`"$BIN" --all`).label).toBe("명령 실행함");
    setState("settings", "language", "en");
    expect(d(`list=$(find . -name '*.html')`).now).toBe("Finding files");
    expect(d(`"$BIN" --all`).now).toBe("Running a command");
    setState("settings", "language", "ko");
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
    expect(noteText("main에 병합 · 워크트리 정리")).toBe("main에 병합 · 워크트리 정리");
    // stored before the wording changed
    expect(noteText("main에 병합했어요")).toBe("main에 병합 · 워크트리 정리");
    expect(noteText("main에 합쳤어요")).toBe("main에 병합 · 워크트리 정리");
    expect(noteText('브랜치 feat/a는 "로그인 고치기" 일로 넘어갔어요')).toBe('브랜치 feat/a는 "로그인 고치기" 작업으로 넘어갔어요');
    expect(noteText("변경을 버렸어요")).toBe("변경 버림");
    expect(noteText("기억함 · pnpm만 써요")).toBe("메모리에 저장 · pnpm만 써요");
    expect(noteText("메모리 저장 · pnpm만 써요")).toBe("메모리에 저장 · pnpm만 써요");
    expect(noteText("끝내기 전에 확인 · 아직 할 일이 남음")).toBe("확인 필요 · 남은 작업 있음");
    expect(noteText("모델 → openai-codex/gpt-5.6-terra · xhigh")).toBe("모델 → GPT-5.6 Terra · 매우 높음");
    setState("settings", "language", "en");
    expect(noteText("변경을 버렸어요")).toBe("Changes discarded");
    expect(noteText("변경 버림")).toBe("Changes discarded");
    expect(noteText("검색 멈춤 · 1분 넘게 결과 없음")).toBe("Stopped searching · no output for over a minute");
    expect(noteText("기다림 멈춤 · 2분 넘게 변화 없음")).toBe("Stopped waiting · nothing changed for over 2 minutes");
    expect(noteText("일시정지")).toBe("Paused");
    expect(noteText("main에 병합 · 워크트리 정리")).toBe("Merged into main · worktree removed");
    expect(noteText("main에 병합했어요")).toBe("Merged into main · worktree removed");
    expect(noteText("작업 전용 브랜치 task/t1에서 시작해요")).toBe("Started on its own branch task/t1");
    expect(noteText("재시도 1/3")).toBe("Retry 1/3");
    expect(noteText("모델 변경 → gpt-5.5")).toBe("Model changed → GPT-5.5");
    expect(noteText("모델 변경 → openai-codex/gpt-5.6-terra")).toBe("Model changed → GPT-5.6 Terra");
    expect(noteText("모델 → gpt-5.6-terra · high")).toBe("Model → GPT-5.6 Terra · High");
    expect(noteText("모델 → claude-opus-4-6")).toBe("Model → Claude Opus 4.6");
    expect(noteText("기억함 · pnpm만 써요")).toBe("Saved to memory · pnpm만 써요");
    expect(noteText("메모리에 저장 · pnpm만 써요")).toBe("Saved to memory · pnpm만 써요");
    expect(noteText("끝내기 전에 확인 · 리뷰 · 증거")).toBe("Still to check: review · evidence");
    expect(noteText("확인 필요 · 증거 안 맞음")).toBe("Still to check: evidence doesn't match");
    expect(noteText('"로그인 고치기" 작업으로 넘어가요')).toBe('Handing over to "로그인 고치기"');
    expect(noteText('"A" 일의 결과와 브랜치를 이어받아 새로 시작해요')).toBe('Continues from "A" with its results and branch');
    expect(noteText("PR #12 병합됨 · 워크트리 정리")).toBe("PR #12 merged · worktree removed");
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
      "검색 멈춤 · 1분 넘게 결과 없음", "기다림 멈춤 · 2분 넘게 변화 없음",
      '"A" 작업의 결과를 이어받아 시작해요', "확인 필요 · 리뷰 지적 · 증거 안 맞음 · 남은 작업 있음",
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
  it("keeps a title up to 80 characters whole", () => {
    const t = "로그인 후 원래 보던 페이지로 돌아가게 리다이렉트 처리를 고치고 테스트까지 추가하기";
    expect(cutTitle(t)).toBe(t);
    expect(cutTitle("Fix the login redirect so people land on the page they were reading")).toBe("Fix the login redirect so people land on the page they were reading");
  });
  it("cuts a longer one where a word ends", () => {
    const long = "로그인 후 원래 보던 페이지로 돌아가게 리다이렉트 처리를 고치고 테스트까지 추가하기, 그리고 세션이 만료된 경우에도 로그인 화면을 거쳐 같은 페이지로 돌려보내는 흐름까지 확인하기";
    const c = cutTitle(long);
    expect(c.endsWith("…")).toBe(true);
    expect([...c].length).toBeLessThanOrEqual(80);
    // the part before … is whole words of the original
    expect(long.startsWith(c.slice(0, -1))).toBe(true);
    expect(long[c.length - 1]).toBe(" ");
    expect(
      cutTitle("Fix the login redirect so people land on the page they were reading before the session timed out"),
    ).toBe("Fix the login redirect so people land on the page they were reading before the…");
  });
  it("cuts one very long word where it must", () => {
    const c = cutTitle("a".repeat(120));
    expect(c).toBe(`${"a".repeat(79)}…`);
  });
});

describe("computer steps", () => {
  const said = (args: any, label?: string) => {
    const s = computerStep(args);
    const d = describeComputer(s.action, label ?? s.target);
    return d.target ? `${d.label} ${d.target}` : d.label;
  };
  it("says what each call did, in words", () => {
    expect(said({ action: "start", app: "Instagram" })).toBe("열었음 Instagram");
    expect(said({ action: "look" })).toBe("화면 봄");
    expect(said({ action: "observe", full: true })).toBe("화면 읽음");
    expect(said({ action: "act", input: { kind: "click", epoch: "h1", ref: "e1" } }, "‘보내기’")).toBe("클릭함 ‘보내기’");
    expect(said({ action: "act", input: { kind: "click", epoch: "h1", ref: "e1", count: 2 } })).toBe("더블클릭함");
    expect(said({ action: "act", input: { kind: "type", epoch: "h1", text: "안녕" } })).toBe("입력함 ‘안녕’");
    expect(said({ action: "act", input: { kind: "press", epoch: "h1", key: "f", modifiers: ["cmd"] } })).toBe("키 누름 cmd+f");
    expect(said({ action: "act", input: { kind: "scroll", epoch: "h1", direction: "down" } })).toBe("스크롤함 아래로");
    expect(said({ action: "stop" })).toBe("앱 사용 마침");
  });
  it("stores the step going on in Korean, as a task's now line", () => {
    expect(describeComputer("scroll", "up").nowKo).toBe("스크롤 중 위로");
    expect(describeComputer("look").nowKo).toBe("화면 보는 중");
  });
});
