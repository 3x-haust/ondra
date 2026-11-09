import { describe, expect, it } from "vitest";
import { linkTip, routeLink } from "./links";

const to = (url: string, cx = {}) => routeLink(url, { panel: true, ...cx }).to;
const why = (url: string, cx = {}) => routeLink(url, { panel: true, ...cx }).why;

describe("routeLink", () => {
  it("opens web pages inside by default", () => {
    expect(to("https://github.com/acme/web/pull/42")).toBe("inside");
    expect(to("http://localhost:5173/dashboard")).toBe("inside");
    expect(to("  https://example.com  ")).toBe("inside");
    expect(routeLink("  https://example.com  ", { panel: true }).target).toBe("https://example.com");
  });

  it("sends ⌘/⌥-clicks, the setting and an explicit ask outside", () => {
    expect(why("https://example.com", { outsideKey: true })).toBe("key");
    expect(why("https://example.com", { setting: "outside" })).toBe("setting");
    expect(why("https://example.com", { setting: "inside" })).toBe("web");
    expect(why("https://example.com", { outside: true })).toBe("asked");
  });

  it("goes outside where the panel can't show it", () => {
    expect(why("https://example.com", { panel: false })).toBe("no-panel");
  });

  it("keeps sign-ins in the system browser", () => {
    expect(why("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe("sign-in");
    expect(why("https://github.com/login/device")).toBe("sign-in");
    expect(why("https://github.com/login/oauth/authorize?client_id=a")).toBe("sign-in");
    expect(why("https://auth.openai.com/oauth/authorize?client_id=a&redirect_uri=http%3A%2F%2Flocalhost%3A1455")).toBe("sign-in");
    expect(why("https://slack.com/oauth/v2/authorize?client_id=a&response_type=code")).toBe("sign-in");
    // a page that only mentions a client id isn't a sign-in
    expect(why("https://example.com/docs?client_id=a")).toBe("web");
    // the setting can't pull a sign-in inside
    expect(to("https://appleid.apple.com/auth", { setting: "inside" })).toBe("outside");
  });

  it("hands downloads to the system browser", () => {
    expect(why("https://example.com/Ondra_0.34.1_aarch64.dmg")).toBe("download");
    expect(why("https://example.com/a.ZIP?sig=1")).toBe("download");
    expect(why("https://github.com/acme/app/releases/download/v1/app")).toBe("download");
    expect(why("https://example.com/zip-codes")).toBe("web");
  });

  it("gives mail and phone links to their apps, and drops other schemes", () => {
    expect(why("mailto:me@example.com")).toBe("scheme");
    expect(to("tel:+821012345678")).toBe("outside");
    expect(to("javascript:alert(1)")).toBe("none");
    expect(to("data:text/html,hi")).toBe("none");
    expect(to("vscode://file/x")).toBe("none");
    expect(to("not a link")).toBe("none");
    expect(to("")).toBe("none");
  });

  it("opens files and folders in the app", () => {
    expect(to("/Users/me/Downloads/report.pdf")).toBe("file");
    expect(to("~/notes")).toBe("file");
    expect(to("file:///Users/me/a.png")).toBe("file");
    // even with ⌘ held (ui/links reveals it in Finder then) or the setting outside
    expect(to("/tmp/x", { outsideKey: true, setting: "outside" })).toBe("file");
  });
});

describe("linkTip", () => {
  it("says where a link goes only when its words don't", () => {
    expect(linkTip("https://github.com/acme/web/pull/42", "PR #42")).toBe("github.com/acme/web/pull/42");
    expect(linkTip("https://www.example.com/", "https://example.com")).toBeUndefined();
    expect(linkTip("https://example.com/a", "example.com/a")).toBeUndefined();
    expect(linkTip("/Users/me/a.md", "a.md")).toBe("/Users/me/a.md");
  });
});
