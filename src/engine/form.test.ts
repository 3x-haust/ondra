import { describe, expect, it } from "vitest";
import { formAnswer, initial, missing, readFields } from "./form";

describe("a question with things to fill in", () => {
  it("reads the fields an ask carries, and drops what isn't one", () => {
    const f = readFields([
      { id: "env", label: "배포 대상", kind: "choice", options: ["staging", "prod"], value: "staging", required: true },
      { label: "고칠 것", kind: "multi", options: ["A", "B", "C"], value: ["A", "Z"] },
      { id: "when", label: "날짜", type: "datetime" },
      { id: "n", label: "동시 실행", kind: "slider", min: 1, max: 8, unit: "개" },
      { id: "ok", label: "알림 보내기", kind: "checkbox", value: true },
      { id: "why", label: "메모", long: true },
      "그냥 문자열",
      { kind: "text" },
    ])!;
    expect(f.map((x) => x.kind)).toEqual(["choice", "choice", "date", "number", "check", "text"]);
    expect(f[0]).toMatchObject({ id: "env", options: ["staging", "prod"], value: ["staging"], required: true });
    expect(f[1]).toMatchObject({ id: "고칠 것", multi: true, value: ["A"] });
    expect(f[2]).toMatchObject({ time: true });
    expect(f[3]).toMatchObject({ min: 1, max: 8, unit: "개" });
    expect(f[5]).toMatchObject({ long: true });
    expect(readFields("x")).toBeUndefined();
    expect(readFields([{ nope: 1 }])).toBeUndefined();
  });

  it("keeps ids apart and caps how many there are", () => {
    const f = readFields(Array.from({ length: 30 }, () => ({ id: "a", label: "a" })))!;
    expect(f).toHaveLength(12);
    expect(new Set(f.map((x) => x.id)).size).toBe(12);
  });

  it("holds the card while a required field is empty", () => {
    const f = readFields([{ id: "a", label: "이름", required: true }, { id: "b", label: "동의", kind: "check", required: true }, { id: "c", label: "선택" }])!;
    const v = Object.fromEntries(f.map((x) => [x.id, initial(x)]));
    expect(missing(f, v)).toBe("이름");
    expect(missing(f, { ...v, a: "Ondra" })).toBe("동의");
    expect(missing(f, { ...v, a: "Ondra", b: true })).toBeUndefined();
  });

  it("sends back the button pressed and a line per field", () => {
    const form = readFields([
      { id: "env", label: "배포 대상", options: ["staging", "prod"] },
      { id: "fix", label: "고칠 것", kind: "multi", options: ["A", "B"] },
      { id: "n", label: "동시 실행", kind: "number", unit: "개" },
      { id: "ok", label: "알림", kind: "check" },
      { id: "memo", label: "메모" },
    ])!;
    const d = { options: [{ id: "보내기", label: "보내기" }], form };
    expect(formAnswer(d, "보내기", { env: "prod", fix: ["A", "B"], n: 3, ok: false })).toBe(
      ["보내기", "- 배포 대상: prod", "- 고칠 것: A, B", "- 동시 실행: 3개", "- 알림: 아니오", "- 메모: (비움)"].join("\n"),
    );
    expect(formAnswer(d, "보내기")).toBe("보내기");
  });
});
