import { describe, expect, it } from "vitest";
import { shortUrl } from "../lib/links";
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
