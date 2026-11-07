import { describe, expect, it } from "vitest";
import { ComputerObservation } from "../../extensions/lib/computer-observation";

type Observation = ReturnType<ComputerObservation["accept"]>;

function fixture(id = "s1", count = 12) {
  return {
    version: "2.6", ok: true, command: "snapshot",
    data: {
      app: "편집기", window: { id: "w1", title: "문서" }, snapshot_id: id,
      complete: true, ref_count: count,
      tree: {
        role: "window", name: "문서",
        children: Array.from({ length: count }, (_, i) => ({
          role: "textfield", name: `항목 ${i}`, value: `내용 ${i}`, enabled: true,
          ref_id: `@${id}:e${i + 20}`, available_actions: ["SetValue"],
          bounds: { x: i, y: 12, width: 100, height: 20 },
        })),
      },
    },
  };
}

// Independent consumer: path components are literal keys, not dotted paths or JSON pointers.
function restore(previous: any, observation: Observation): any {
  if (observation.kind === "full") return structuredClone(observation.snapshot);
  const result = structuredClone(previous);
  if (observation.kind === "unchanged") return result;
  for (const change of observation.changes) {
    if (!change.path.length) {
      if (change.op !== "set") throw new Error("Cannot remove root");
      return structuredClone(change.value);
    }
    let parent = result;
    for (const key of change.path.slice(0, -1)) parent = parent[key];
    const key = change.path[change.path.length - 1];
    if (change.op === "remove") delete parent[key];
    else Object.defineProperty(parent, key, { value: structuredClone(change.value), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function expected(envelope: ReturnType<typeof fixture>) {
  const result: any = structuredClone(envelope);
  delete result.data.snapshot_id;
  result.data.tree.children.forEach((node: any, i: number) => { node.ref_id = `e${i + 1}`; });
  return result;
}

const errorEnvelope = {
  version: "2.6", ok: false, command: "snapshot",
  error: {
    code: "TIMEOUT", message: "시간 초과", suggestion: "다시 관측",
    disposition: { delivery: "not_delivered", retry: "safe" },
    recovery: { strategy: "refresh_snapshot_then_retry_original", requires_fresh_snapshot: true },
    details: { refusal: { code: "AMBIGUOUS_TARGET", details: { kind: "identity_not_unique" } } },
  },
};

describe("ComputerObservation", () => {
  it("returns a full lossless UI envelope with short aliases mapped to exact CLI refs", () => {
    const observations = new ComputerObservation("session");
    const input = fixture();
    const original = structuredClone(input);
    const output = observations.accept(input);

    expect(output.kind).toBe("full");
    expect(output.snapshot_id).toBe("s1");
    expect(restore(undefined, output)).toEqual(expected(input));
    expect(observations.resolve(output.epoch, "e1")).toBe("@s1:e20");
    expect(observations.resolve(output.epoch, "e12")).toBe("@s1:e31");
    expect(() => observations.resolve(output.epoch, "@s1:e20")).toThrow("Unknown");
    expect(input).toEqual(original);
  });

  it("aliases nested nodes in preorder and supports windowless process snapshots", () => {
    const observations = new ComputerObservation("session");
    const input: any = fixture("s1", 0);
    delete input.data.window;
    input.data.identity_unproven = false;
    input.data.tree = {
      role: "application", ref_id: "@s1:e70", children: [
        { role: "group", children: [{ role: "button", ref_id: "@s1:e4", name: "실행", subtree_truncated: false }] },
      ],
    };
    const output = observations.accept(input);
    const normalized = structuredClone(input);
    delete normalized.data.snapshot_id;
    normalized.data.tree.ref_id = "e1";
    normalized.data.tree.children[0].children[0].ref_id = "e2";

    expect(restore(undefined, output)).toEqual(normalized);
    expect(observations.resolve(output.epoch, "e1")).toBe("@s1:e70");
    expect(observations.resolve(output.epoch, "e2")).toBe("@s1:e4");
  });

  it("returns unchanged for identical UI with new snapshot and raw element IDs", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    const next = fixture("s2");
    next.data.tree.children.forEach((node, i) => { node.ref_id = `@s2:e${900 - i}`; });
    const second = observations.accept(next);

    expect(second).toEqual({ epoch: second.epoch, kind: "unchanged", base_epoch: first.epoch, snapshot_id: "s2" });
    expect(second.epoch).not.toBe(first.epoch);
    expect(observations.resolve(second.epoch, "e1")).toBe("@s2:e900");
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(restore(restore(undefined, first), second)).toEqual(expected(next));
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length / 4);
  });

  it("emits only a changed value and chains the immediately preceding epoch", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    const same = observations.accept(fixture("s2"));
    const changed = fixture("s3");
    changed.data.tree.children[3].value = "새 값 👨‍👩‍👧‍👦";
    const output = observations.accept(changed);

    expect(output).toEqual({
      epoch: output.epoch, kind: "delta", base_epoch: same.epoch, snapshot_id: "s3",
      changes: [{ op: "set", path: ["data", "tree", "children", 3, "value"], value: "새 값 👨‍👩‍👧‍👦" }],
    });
    expect(restore(restore(undefined, first), output)).toEqual(expected(changed));
    expect(observations.resolve(output.epoch, "e4")).toBe("@s3:e23");
  });

  it.each(["add", "delete", "reorder"])("reconstructs node topology after %s without reusing identity", operation => {
    const observations = new ComputerObservation("session");
    const before = fixture();
    const first = observations.accept(before);
    const after = fixture("s2");
    const children = after.data.tree.children;
    if (operation === "add") children.push({ ...children[0], ref_id: "@s2:e999", name: "추가" });
    if (operation === "delete") children.splice(2, 1);
    if (operation === "reorder") children.reverse();
    after.data.ref_count = children.length;
    const output = observations.accept(after);

    expect(restore(restore(undefined, first), output)).toEqual(expected(after));
    children.forEach((node, i) => expect(observations.resolve(output.epoch, `e${i + 1}`)).toBe(node.ref_id));
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(() => observations.resolve(output.epoch, `e${children.length + 1}`)).toThrow("Unknown");
  });

  it("uses full when a delta costs more and honours an explicit full request", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture("s1", 0));
    const after: any = fixture("s2", 0);
    after.data.tree = { role: "button", ref_id: "@s2:e8", value: "다른 화면" };
    delete after.data.app;
    delete after.data.window;
    delete after.data.ref_count;
    after.version = "2.6";
    const second = observations.accept(after);
    expect(second.kind).toBe("full");
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify({
      epoch: second.epoch, snapshot_id: "s2", kind: "delta", base_epoch: first.epoch,
      changes: [
        { op: "remove", path: ["data", "app"] },
        { op: "remove", path: ["data", "window"] },
        { op: "remove", path: ["data", "ref_count"] },
        { op: "set", path: ["data", "tree"], value: after.data.tree },
      ],
    }).length);
    expect(observations.accept(after, true).kind).toBe("full");
  });

  it("preserves unknown fields, nested arrays, literal path keys, nulls and removals", () => {
    const observations = new ComputerObservation("session");
    const before: any = fixture();
    before.future = { "a/b~.c": [1, null, { enabled: false }], removed: "old" };
    before.data.tree.children[0].extension = { ref_id: "not-a-CLI-ref", label: "unknown" };
    const first = observations.accept(before);
    const after = structuredClone(before);
    after.future["a/b~.c"][2].enabled = true;
    delete after.future.removed;
    after.future.added = { important: "새 정보" };
    after.data.tree.children[0].extension.label = "보존";
    const output = observations.accept(after);

    expect(output.kind).toBe("delta");
    expect(restore(restore(undefined, first), output)).toEqual(expected(after));
    expect(restore(undefined, first).data.tree.children[0].extension.ref_id).toBe("not-a-CLI-ref");
  });

  it("preserves prototype-like keys without polluting objects", () => {
    const observations = new ComputerObservation("session");
    const before: any = fixture();
    before.future = JSON.parse('{"__proto__":{"polluted":"before"},"constructor":"literal"}');
    const first = observations.accept(before);
    const after = structuredClone(before);
    after.future.__proto__.polluted = "after";
    const second = observations.accept(after);

    expect(restore(restore(undefined, first), second)).toEqual(expected(after));
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it.each([
    ["partial", { complete: false, truncated: true, nodes_observed: 12 }],
    ["identity", { identity_unproven: true }],
    ["truncated", { truncated: true }],
  ])("preserves %s evidence but refuses every action target", (_name, evidence) => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    const input = fixture("s2");
    Object.assign(input.data, evidence);
    const second = observations.accept(input);

    expect(restore(restore(undefined, first), second)).toEqual(expected(input));
    expect(() => observations.resolve(second.epoch, "e1")).toThrow(/Partial|identity_unproven/);
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    const recovered = observations.accept(fixture("s3"));
    expect(observations.resolve(recovered.epoch, "e1")).toBe("@s3:e20");
  });

  it("preserves subtree truncation even when complete is inconsistent and refuses refs", () => {
    const observations = new ComputerObservation("session");
    const input: any = fixture();
    input.data.tree.children[2].subtree_truncated = true;
    const output = observations.accept(input);
    expect(restore(undefined, output)).toEqual(expected(input));
    expect(() => observations.resolve(output.epoch, "e1")).toThrow("Partial");
  });

  it("reports duplicate raw refs and refuses both aliases without overwriting the mapping", () => {
    const observations = new ComputerObservation("session");
    const input = fixture();
    input.data.tree.children[1].ref_id = input.data.tree.children[0].ref_id;
    const output = observations.accept(input);

    expect(output.blocked_refs).toEqual(["e1", "e2"]);
    expect(() => observations.resolve(output.epoch, "e1")).toThrow("Duplicate");
    expect(() => observations.resolve(output.epoch, "e2")).toThrow("Duplicate");
    expect(observations.resolve(output.epoch, "e3")).toBe("@s1:e22");
    const clean = observations.accept(fixture("s2"));
    expect(clean.blocked_refs).toBeUndefined();
    expect(observations.resolve(clean.epoch, "e1")).toBe("@s2:e20");
  });

  it("returns complete error evidence, invalidates refs and restarts the baseline", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    const output = observations.accept(errorEnvelope);

    expect(output).toEqual({ epoch: output.epoch, kind: "full", snapshot: errorEnvelope });
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(() => observations.resolve(output.epoch, "e1")).toThrow("Stale");
    expect(observations.accept(fixture()).kind).toBe("full");
  });

  it.each([
    ["null", () => null],
    ["old version", () => ({ ...fixture(), version: "2.5" })],
    ["wrong command", () => ({ ...fixture(), command: "find" })],
    ["missing complete", () => { const x: any = fixture(); delete x.data.complete; return x; }],
    ["invalid flag", () => { const x: any = fixture(); x.data.identity_unproven = "false"; return x; }],
    ["missing tree", () => { const x: any = fixture(); delete x.data.tree; return x; }],
    ["missing role", () => { const x: any = fixture(); delete x.data.tree.children[0].role; return x; }],
    ["invalid children", () => { const x: any = fixture(); x.data.tree.children = {}; return x; }],
    ["foreign ref", () => { const x = fixture(); x.data.tree.children[0].ref_id = "@s9:e20"; return x; }],
    ["bare ref", () => { const x = fixture(); x.data.tree.children[0].ref_id = "@e20"; return x; }],
    ["null ref", () => { const x: any = fixture(); x.data.tree.children[0].ref_id = null; return x; }],
    ["malformed error", () => ({ ...errorEnvelope, error: { code: "TIMEOUT" } })],
    ["undefined", () => ({ ...fixture(), unknown: undefined })],
    ["NaN", () => ({ ...fixture(), unknown: Number.NaN })],
    ["bigint", () => ({ ...fixture(), unknown: 1n })],
    ["date", () => ({ ...fixture(), unknown: new Date(0) })],
    ["cycle", () => { const x: any = fixture(); x.cycle = x; return x; }],
    ["sparse array", () => ({ ...fixture(), unknown: new Array(2) })],
    ["symbol", () => ({ ...fixture(), [Symbol("hidden")]: "hidden" })],
  ])("rejects malformed %s and invalidates all old refs", (_name, input) => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    expect(() => observations.accept(input())).toThrow();
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(observations.accept(fixture()).kind).toBe("full");
  });

  it("rejects accessors without executing them", () => {
    const observations = new ComputerObservation("session");
    let reads = 0;
    const input = Object.defineProperty(fixture(), "secret", { enumerable: true, get() { reads++; return "secret"; } });
    expect(() => observations.accept(input)).toThrow("JSON data properties");
    expect(reads).toBe(0);
  });

  it.each(["bytes", "values", "depth"])("rejects the bounded input %s limit explicitly and invalidates refs", bound => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    const input: any = fixture();
    if (bound === "bytes") input.large = "한".repeat(3 * 1024 * 1024);
    if (bound === "values") input.large = Array.from({ length: 100_001 }, () => null);
    if (bound === "depth") {
      let nested: any = null;
      for (let i = 0; i < 129; i++) nested = { nested };
      input.large = nested;
    }
    expect(() => observations.accept(input)).toThrow(/input limit/);
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
  });

  it("accepts exactly 8 MiB of JSON and rejects the next byte without clipping", () => {
    const observations = new ComputerObservation("session");
    const input: any = fixture("s1", 0);
    input.padding = "";
    const overhead = new TextEncoder().encode(JSON.stringify(input)).length;
    input.padding = "x".repeat(8 * 1024 * 1024 - overhead);
    const output = observations.accept(input);
    expect(restore(undefined, output).padding).toBe(input.padding);

    input.padding += "x";
    expect(() => observations.accept(input)).toThrow("8 MiB JSON input limit");
    expect(() => observations.resolve(output.epoch, "e1")).toThrow("Stale");
  });

  it("does not clip long Unicode UI values on full or delta observations", () => {
    const observations = new ComputerObservation("세션 🧑‍💻");
    const input = fixture();
    const text = "한글 👨‍👩‍👧‍👦 e\u0301 \n\" ".repeat(10_000) + "중요한 마지막 내용";
    input.data.tree.children[0].value = text;
    const first = observations.accept(input);
    expect(restore(undefined, first).data.tree.children[0].value).toBe(text);
    input.data.tree.children[1].value = text + " 수정";
    const next = observations.accept(input);
    expect(restore(restore(undefined, first), next)).toEqual(expected(input));
  });

  it("detaches the raw input and returned full/delta values from the stored baseline", () => {
    const observations = new ComputerObservation("session");
    const input = fixture();
    const first = observations.accept(input);
    input.data.tree.children[0].value = "외부 수정";
    if (first.kind === "full") (first.snapshot.data as any).tree.children[1].value = "반환값 수정";
    expect(observations.accept(fixture()).kind).toBe("unchanged");
    const changed: any = fixture();
    changed.data.extra = { nested: "보존" };
    const delta = observations.accept(changed);
    expect(delta.kind).toBe("delta");
    if (delta.kind === "delta") for (const change of delta.changes) {
      if (change.op === "set" && change.value && typeof change.value === "object") (change.value as any).nested = "외부 수정";
    }
    expect(observations.accept(changed).kind).toBe("unchanged");
  });

  it("uses distinct epochs across sessions and instances, and starts each with full", () => {
    const a = new ComputerObservation("first");
    const b = new ComputerObservation("second");
    const restarted = new ComputerObservation("first");
    const x = a.accept(fixture());
    const y = b.accept(fixture());
    const z = restarted.accept(fixture());
    expect([x.kind, y.kind, z.kind]).toEqual(["full", "full", "full"]);
    expect(new Set([x.epoch, y.epoch, z.epoch]).size).toBe(3);
    expect(() => b.resolve(x.epoch, "e1")).toThrow("Stale");
    expect(() => restarted.resolve(x.epoch, "e1")).toThrow("Stale");
  });

  it("consumes refs immediately without discarding the comparison baseline", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    observations.invalidateRefs();
    observations.invalidateRefs();
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    const second = observations.accept(fixture("s2"));
    expect(second).toEqual({ kind: "unchanged", epoch: second.epoch, base_epoch: first.epoch, snapshot_id: "s2" });
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(observations.resolve(second.epoch, "e1")).toBe("@s2:e20");

    observations.invalidateRefs();
    const changed = fixture("s3");
    changed.data.tree.children[0].value = "updated";
    const third = observations.accept(changed);
    expect(third).toEqual({
      kind: "delta", epoch: third.epoch, base_epoch: second.epoch, snapshot_id: "s3",
      changes: [{ op: "set", path: ["data", "tree", "children", 0, "value"], value: "updated" }],
    });
    expect(restore(restore(restore(undefined, first), second), third)).toEqual(expected(changed));
    expect(() => observations.resolve(second.epoch, "e1")).toThrow("Stale");
    expect(observations.resolve(third.epoch, "e1")).toBe("@s3:e20");
  });

  it.each(["reset", "error", "malformed"])("discards a retained comparison baseline after %s", reason => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    observations.invalidateRefs();
    if (reason === "reset") observations.invalidate();
    else if (reason === "error") expect(observations.accept(errorEnvelope).kind).toBe("full");
    else expect(() => observations.accept(null)).toThrow();
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    const next = observations.accept(fixture("s2"));
    expect(next.kind).toBe("full");
    expect(observations.resolve(next.epoch, "e1")).toBe("@s2:e20");
  });

  it("invalidates cancellation refs idempotently and never revives their epoch", () => {
    const observations = new ComputerObservation("session");
    const first = observations.accept(fixture());
    observations.invalidate();
    observations.invalidate();
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    const next = observations.accept(fixture());
    expect(next.kind).toBe("full");
    expect(next.epoch).not.toBe(first.epoch);
    expect(() => observations.resolve(first.epoch, "e1")).toThrow("Stale");
    expect(observations.resolve(next.epoch, "e1")).toBe("@s1:e20");
  });
});
