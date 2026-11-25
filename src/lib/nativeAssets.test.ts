import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mockConvertFileSrc } from "@tauri-apps/api/mocks";

beforeAll(() => {
  vi.stubGlobal("window", {});
  mockConvertFileSrc("windows");
});
afterAll(() => vi.unstubAllGlobals());

it("serves a Windows result and the images next to its HTML through the asset protocol", async () => {
  const { fileSrc, pageSrc } = await import("./native");
  const page = pageSrc(String.raw`C:\Work\my report\index.html`);
  expect(new URL(page).origin).toBe("http://asset.localhost");
  expect(decodeURIComponent(new URL("img/a%20b.png", page).pathname.slice(1))).toBe("C:/Work/my report/img/a b.png");
  expect(decodeURIComponent(new URL(fileSrc(String.raw`C:\Work\my report\shot.png`)).pathname.slice(1))).toBe(String.raw`C:\Work\my report\shot.png`);
  expect(pageSrc("https://example.com/report.html")).toBe("https://example.com/report.html");
});
