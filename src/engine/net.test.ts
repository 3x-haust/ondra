import { describe, expect, it } from "vitest";
import { isNetError } from "./net";

describe("isNetError", () => {
  it("knows a dropped connection", () => {
    for (const m of ["TypeError: fetch failed", "read ECONNRESET", "getaddrinfo ENOTFOUND api.openai.com", "socket hang up", "Connection error.", "503 Service Unavailable", "terminated"]) expect(isNetError(m)).toBe(true);
  });
  it("leaves model and request errors alone", () => {
    for (const m of ["The model `gpt-x` does not exist", "400 invalid_request_error: prompt is too long", "401 Unauthorized", "rate_limit_error: 429"]) expect(isNetError(m)).toBe(false);
  });
});
