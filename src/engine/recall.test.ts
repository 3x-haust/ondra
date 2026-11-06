import { describe, expect, it } from "vitest";
import type { Memory } from "../state/types";
import { recall } from "./memory";

let n = 0;
const piece = (text: string): Memory => ({ id: `m${++n}`, text, scope: "space", space: "work", createdAt: Date.now(), uses: 0 } as Memory);

describe("recall", () => {
  const pool = [
    piece("레비오사 본 앱은 leviosa-frontend(Next.js·Supabase·토스)예요."),
    piece("레비오사 웹 PostHog는 PostHog 탭을 열고 HogQL을 보내요."),
    piece("leviosa-frontend PR은 dev로 열고 main으로는 열지 않아요."),
    piece("폰 엔진 토큰 절약은 결과 비우기 기준을 20만 자로 둬요."),
    piece("2026년 11월 배포는 Max님 확인을 받아요."),
    ...Array.from({ length: 40 }, (_, i) => piece(`요메이츠 앱 규칙 ${i}: 심사 전에 시뮬레이터로 확인해요.`)),
    ...Array.from({ length: 30 }, (_, i) => piece(`repo-${i} PR은 dev로 올려요.`)),
  ];

  it("finds the product's pieces from how the user names it, not from dates in the message", () => {
    const got = recall(pool, "[2026. 11. 6. 오후 12:19] HR: 2026-서울마포-2611호 통신판매업 신고번호 이거 레비오사 웹 에 적용해야하거든? pr 만 올려봐", { max: 3, budget: 600 });

    expect(got.map((m) => m.text)).toEqual(expect.arrayContaining([pool[0].text, pool[1].text]));
    expect(got.map((m) => m.text)).not.toContain(pool[3].text);
    expect(got.map((m) => m.text)).not.toContain(pool[4].text);
  });
});

describe("numbers in recall", () => {
  it("keeps short numbers that are the subject, drops times and dates", async () => {
    const { tokens } = await import("./memory");
    expect(tokens("PR 64 리뷰, 404 에러, node 18")).toEqual(expect.arrayContaining(["64", "404", "18"]));
    expect(tokens("[2026. 11. 6. 오후 12:19] 배포")).not.toEqual(expect.arrayContaining(["12", "19", "2026", "11"]));
  });
});
