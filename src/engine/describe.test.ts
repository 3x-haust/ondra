import { describe, expect, it } from "vitest";
import { describeCommand as d } from "./describe";

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
