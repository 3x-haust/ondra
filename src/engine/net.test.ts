import { afterEach, describe, expect, it, vi } from "vitest";
import { isNetError, waitOnline } from "./net";

describe("isNetError", () => {
  it("knows a dropped connection", () => {
    for (const m of ["TypeError: fetch failed", "read ECONNRESET", "getaddrinfo ENOTFOUND api.openai.com", "socket hang up", "Connection error.", "503 Service Unavailable", "terminated", "Unable to connect. Is the computer able to access the url?"]) expect(isNetError(m)).toBe(true);
  });
  it("leaves model and request errors alone", () => {
    for (const m of ["The model `gpt-x` does not exist", "400 invalid_request_error: prompt is too long", "401 Unauthorized", "rate_limit_error: 429"]) expect(isNetError(m)).toBe(false);
  });
});

describe("waitOnline", () => {
  afterEach(() => vi.useRealTimers());
  const settle = async (p: Promise<void>, ms: number) => {
    let done = false;
    void p.then(() => (done = true));
    for (let t = 0; t < ms && !done; t += 1000) await vi.advanceTimersByTimeAsync(1000);
    return done;
  };

  it("carries on as soon as the network answers again, not after the whole wait", async () => {
    vi.useFakeTimers();
    let up = false;
    // the fifth try waits up to 80 s; the network is back after 10 s
    const p = waitOnline(5, async () => up);
    expect(await settle(p, 9_000)).toBe(false);
    up = true;
    expect(await settle(p, 5_000)).toBe(true);
  });

  it("still goes on once the longest wait is over, even when the check can't tell", async () => {
    vi.useFakeTimers();
    const p = waitOnline(1, async () => false);
    expect(await settle(p, 3_000)).toBe(false);
    expect(await settle(p, 10_000)).toBe(true);
  });
});
