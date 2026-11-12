import { describe, expect, it } from "vitest";
import { draftAnswer, prose, readFences } from "./fences";

describe("draftAnswer", () => {
  it("reads an answer's text as it is written, board and all", () => {
    const full = "```route\n" + JSON.stringify({ routes: [{ kind: "answer", text: "VPN은요 \"터널\"이에요.\n\n```board\ntitle VPN\nbox 1 2 3 4 \"내 기기\"\n```" }] }) + "\n```";
    const cut = full.indexOf("box") + 12;
    expect(draftAnswer(full.slice(0, cut))).toBe("VPN은요 \"터널\"이에요.\n\n```board\ntitle VPN\nbox 1 2 3 4 ");
    expect(draftAnswer(full)).toContain("\"내 기기\"\n```");
  });
  it("shows nothing for a fork, or before the text starts, or mid-escape", () => {
    expect(draftAnswer('```route\n{"routes":[{"kind":"new","text":"do it"}]}')).toBe("");
    expect(draftAnswer('```route\n{"routes":[{"kind":"answer","te')).toBe("");
    expect(draftAnswer('```route\n{"routes":[{"kind":"answer","text":"a\\')).toBe("a");
    expect(draftAnswer('```route\n{"routes":[{"kind":"answer","text":"\\uAC00\\uAC')).toBe("가");
  });
});

describe("fences", () => {
  it("keeps a route whole when its answer carries a board fence in the string", () => {
    const text = JSON.stringify({ routes: [{ kind: "answer", text: "설명이에요.\n\n```board\ntitle VPN\nbox 1 2 3 4 \"a\"\n```\n\n끝." }] });
    const raw = "```route\n" + text + "\n```";
    const { items, end } = readFences(raw, "route");
    expect(items[0].routes[0].text).toContain("```board\ntitle VPN");
    expect(end).toBe(raw.length);
    expect(prose(raw)).toBe("");
  });

  it("reads blocks fences in turn from a cursor, one object per line", () => {
    const raw = 'hi\n```blocks\n{"a":1}\n{"b":"x```y"}\n```\nmid\n```blocks\n{"c":3}\n```';
    const first = readFences(raw, "blocks");
    expect(first.items).toEqual([{ a: 1 }, { b: "x```y" }, { c: 3 }]);
    expect(readFences(raw, "blocks", first.end).items).toEqual([]);
  });

  it("leaves a half-written fence for later", () => {
    expect(readFences('```route\n{"routes":[{"text":"```bo', "route").items).toEqual([]);
  });

  it("strips the app's fences but keeps boards and code for the reader", () => {
    const raw = "앞\n```board\ntitle x\n```\n```blocks\n{\"kind\":\"file\"}\n```\n```js\nlet a = 1\n```\n뒤\n```blo";
    expect(prose(raw)).toBe("앞\n```board\ntitle x\n```\n\n```js\nlet a = 1\n```\n뒤");
    expect(prose("말\n```route\n{\"reply\":\"a")).toBe("말");
  });
});
