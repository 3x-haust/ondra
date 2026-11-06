import { describe, expect, it, vi } from "vitest";
import { bindPdfGestures, pdfScale } from "./pdf-gestures";

function setup() {
  const target = Object.assign(new EventTarget(), { ownerDocument: { defaultView: new EventTarget() } });
  const viewport = { clientHeight: 600, getBoundingClientRect: () => ({ left: 10, top: 44, right: 810, bottom: 644, width: 800, height: 600 }) };
  const zoom = vi.fn();
  const dispose = bindPdfGestures(target as unknown as HTMLElement, viewport as HTMLElement, zoom);
  const send = (type: string, fields: Record<string, unknown> = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { clientX: 300, clientY: 200, deltaMode: 0, deltaY: 0, ctrlKey: false }, fields);
    target.dispatchEvent(e);
    return e;
  };
  return { target, zoom, dispose, send };
}

describe("PDF scale", () => {
  it.each([[1, 2, 2], [4, 2, 5], [0.2, 0.1, 0.1], [1, NaN, 1], [1, Infinity, 1], [1, -2, 1], [1, 0, 1]])(
    "bounds scale %s × %s to %s", (current, factor, expected) => expect(pdfScale(current, factor)).toBe(expected),
  );
});

describe("PDF trackpad events", () => {
  it("cancels browser pinch zoom and forwards the pointer as zoom origin", () => {
    const { send, zoom } = setup();
    expect(send("wheel", { ctrlKey: true, deltaY: -20 }).defaultPrevented).toBe(true);
    expect(zoom).toHaveBeenCalledWith(Math.exp(0.2), [300, 200]);
  });
  it("leaves ordinary two-axis scroll and momentum to the browser", () => {
    const { send, zoom } = setup();
    expect(send("wheel", { deltaX: 40, deltaY: 60 }).defaultPrevented).toBe(false);
    expect(zoom).not.toHaveBeenCalled();
  });
  it.each([[0, 100], [1, 6.25], [2, 1 / 6]])("normalizes delta mode %s", (deltaMode, deltaY) => {
    const { send, zoom } = setup();
    send("wheel", { ctrlKey: true, deltaMode, deltaY });
    expect(zoom.mock.calls[0][0]).toBeCloseTo(Math.exp(-1));
  });
  it("uses incremental WebKit scales without also applying ctrl-wheel", () => {
    const { send, zoom } = setup();
    expect(send("gesturestart").defaultPrevented).toBe(true);
    send("gesturechange", { scale: 2 });
    expect(send("wheel", { ctrlKey: true, deltaY: -20 }).defaultPrevented).toBe(true);
    send("gesturechange", { scale: 3 });
    expect(zoom.mock.calls).toEqual([[2, [300, 200]], [1.5, [300, 200]]]);
    expect(send("gestureend").defaultPrevented).toBe(true);
    send("wheel", { ctrlKey: true, deltaY: -20 });
    expect(zoom).toHaveBeenCalledTimes(3);
  });
  it("allows immediate reversal at the zoom limit", () => {
    const { send, zoom } = setup();
    let scale = 4;
    zoom.mockImplementation((factor) => { scale = pdfScale(scale, factor); });
    send("gesturestart");
    send("gesturechange", { scale: 2 });
    expect(scale).toBe(5);
    send("gesturechange", { scale: 1.8 });
    expect(scale).toBe(4.5);
  });
  it("ignores malformed and orphaned gestures", () => {
    const { send, zoom } = setup();
    send("gesturechange", { scale: 2 });
    send("gesturestart");
    for (const scale of [0, -1, Infinity, NaN]) send("gesturechange", { scale });
    expect(zoom).not.toHaveBeenCalled();
    send("gesturechange", { scale: 1.2 });
    expect(zoom).toHaveBeenCalledWith(1.2, [300, 200]);
  });
  it("clamps toolbar coordinates and falls back to the viewport center", () => {
    const { send, zoom } = setup();
    send("wheel", { ctrlKey: true, deltaY: -10, clientY: 10 });
    expect(zoom.mock.calls[0][1]).toEqual([300, 44]);
    send("gesturestart");
    send("gesturechange", { scale: 2, clientX: undefined, clientY: undefined });
    expect(zoom.mock.calls[1][1]).toEqual([410, 344]);
  });
  it("clears an interrupted gesture on blur and removes listeners on disposal", () => {
    const { send, zoom, target, dispose } = setup();
    send("gesturestart");
    target.ownerDocument.defaultView.dispatchEvent(new Event("blur"));
    send("wheel", { ctrlKey: true, deltaY: -10 });
    expect(zoom).toHaveBeenCalledTimes(1);
    dispose();
    expect(send("wheel", { ctrlKey: true }).defaultPrevented).toBe(false);
    send("gesturestart");
    send("gesturechange", { scale: 2 });
    expect(zoom).toHaveBeenCalledTimes(1);
  });
});
