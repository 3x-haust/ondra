import { describe, expect, it } from "vitest";
import { shortUrl, urlsIn } from "../lib/links";
import { nextRender } from "./renderPace";

describe("link card", () => {
  it("names a link by its site, then its path", () => {
    expect(shortUrl("https://www.example.com/docs/a/?q=1")).toEqual({ host: "example.com", rest: "/docs/a/?q=1" });
    expect(shortUrl("https://example.com/")).toEqual({ host: "example.com", rest: "" });
    expect(shortUrl("https://ko.wikipedia.org/wiki/%EC%88%98%ED%95%99")).toEqual({ host: "ko.wikipedia.org", rest: "/wiki/수학" });
  });
});

describe("render pace", () => {
  it("waits twice the last render, at most 2 s", () => {
    expect(nextRender(1000, 5)).toBe(1010);
    expect(nextRender(1000, 3000)).toBe(3000);
    expect(nextRender(1000, -1)).toBe(1000);
  });
});

describe("links in a message", () => {
  it("finds each address once, without the punctuation after it", () => {
    expect(urlsIn("이거 봐 https://github.com/deepseek-ai/chat-demo, 그리고 https://katex.org.")).toEqual(["https://github.com/deepseek-ai/chat-demo", "https://katex.org"]);
    expect(urlsIn("(https://en.wikipedia.org/wiki/Foo_(bar)) 참고")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
    expect(urlsIn("same https://a.example.com/x https://a.example.com/x")).toEqual(["https://a.example.com/x"]);
    expect(urlsIn("http://localhost:3000 and https://x")).toEqual([]);
    expect(urlsIn("a https://a.io b https://b.io c https://c.io d https://d.io")).toHaveLength(3);
  });
});
