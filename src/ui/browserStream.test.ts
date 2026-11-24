import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import * as native from "../lib/native";

class FakeSocket {
  static last: FakeSocket;
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  frame(data: string, w: number) {
    this.onmessage?.({ data: JSON.stringify({ type: "frame", data, metadata: { deviceWidth: w, deviceHeight: 800 } }) });
  }
}

describe("the browser stream in a pane", () => {
  it("a frame laid out for another size is passed over while the page refits, and shown after all if none fits", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.spyOn(native, "browserStreamPort").mockResolvedValue(4000);
    const { useBrowserStream, FIT_MS } = await import("./browserStream");
    let s!: ReturnType<typeof useBrowserStream>;
    createRoot(() => {
      const [job] = createSignal({ id: "t1" });
      s = useBrowserStream(job);
    });
    await vi.waitFor(() => expect(FakeSocket.last).toBeTruthy());
    s.fit(400, 600);
    FakeSocket.last.open();
    expect(JSON.parse(FakeSocket.last.sent[0])).toEqual({ type: "viewport", width: 400, height: 600 });
    // the last frame kept from before, at the desktop width: not shown yet
    FakeSocket.last.frame("old", 1280);
    expect(s.frame()).toBeNull();
    // the page laid out at the pane's width: shown
    FakeSocket.last.frame("fit", 400);
    expect(s.frame()).toBe("data:image/jpeg;base64,fit");
    // a page that never refits is still shown, a moment later
    vi.useFakeTimers();
    s.fit(700, 600);
    FakeSocket.last.frame("wide", 1280);
    expect(s.frame()).toBe("data:image/jpeg;base64,fit");
    vi.advanceTimersByTime(FIT_MS + 10);
    expect(s.frame()).toBe("data:image/jpeg;base64,wide");
    vi.useRealTimers();
  });
});
