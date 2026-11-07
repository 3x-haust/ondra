import { ComputerObservation } from "./computer-observation";
import type { ComputerEvaluation, ComputerObservationCapture } from "./computer-evaluation";

export type GuestExecute = (argv: string[], signal?: AbortSignal) => Promise<unknown>;
/** Pixel position in the latest screen look's image. */
export type ComputerPoint = { x: number; y: number };
export type ComputerAction =
  | { kind: "click"; epoch: string; ref: string }
  | { kind: "set-value"; epoch: string; ref: string; value: string }
  | { kind: "press"; epoch: string; key: string; modifiers?: ("cmd" | "ctrl" | "alt" | "shift")[] }
  /** Types into ref, or into the focused field when ref is omitted. */
  | { kind: "type"; epoch: string; ref?: string; text: string }
  /** Scrolls ref, or under a point of the latest screen look. */
  | { kind: "scroll"; epoch: string; direction: "up" | "down" | "left" | "right"; amount?: number; ref?: string; x?: number; y?: number }
  /** Both ends are refs, or both are points of the latest screen look. */
  | { kind: "drag"; epoch: string; from: { ref: string } | ComputerPoint; to: { ref: string } | ComputerPoint }
  /** Clicks a point of the latest screen look. epoch is that look's frame. */
  | { kind: "click-at"; epoch: string; x: number; y: number; button?: "left" | "right"; count?: 1 | 2 };
export type SessionObservation = ReturnType<ComputerObservation["accept"]>;
export type GuestImage = { mimeType: "image/png"; data: string; width: number; height: number; frame?: string };
type Frame = { id: string; width: number; height: number; scaleX: number; scaleY: number; originX: number; originY: number };
export type CommandReport = {
  ok: boolean | null;
  /** Verification is the adapter's named scope, never application-level persistence. */
  outcome: "verified" | "not_delivered" | "unknown";
  envelope?: unknown;
  error?: string;
};
export type ActionReport = {
  action: CommandReport;
  observation?: SessionObservation;
  observationError?: string;
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const unknownReport = (error: unknown): CommandReport => ({ ok: null, outcome: "unknown", error: message(error) });

function envelope(value: unknown, command: string): RecordValue {
  if (!record(value) || value.version !== "2.6" || value.command !== command || typeof value.ok !== "boolean" ||
      !record(value.ok ? value.data : value.error)) throw new Error(`Malformed ${command} envelope`);
  if (!value.ok) {
    const error = value.error as RecordValue;
    if (typeof error.code !== "string" || typeof error.message !== "string") throw new Error(`Malformed ${command} error`);
    disposition(error.disposition);
  }
  return value;
}

function disposition(value: unknown): string {
  if (!record(value) || !["unknown", "not_delivered", "delivery_uncertain", "delivered_unverified", "delivered_verified"].includes(String(value.delivery))) {
    throw new Error("Malformed delivery disposition");
  }
  const retry = value.delivery === "not_delivered" ? "safe" : value.delivery === "unknown" ? "unknown" : "unsafe";
  if (value.retry !== retry) throw new Error("Inconsistent retry disposition");
  return value.delivery as string;
}

function report(value: unknown, command: string, requiresDisposition = true): CommandReport {
  const parsed = envelope(value, command);
  const payload = (parsed.ok ? parsed.data : parsed.error) as RecordValue;
  const delivery = parsed.ok && !requiresDisposition && payload.disposition === undefined
    ? "unknown" : disposition(payload.disposition);
  return {
    ok: parsed.ok as boolean,
    outcome: delivery === "not_delivered" ? "not_delivered" : parsed.ok && delivery === "delivered_verified" ? "verified" : "unknown",
    envelope: value,
  };
}

function screenshotImage(value: unknown): GuestImage {
  const parsed = envelope(value, "screenshot");
  if (!parsed.ok) throw new Error("Guest screenshot failed; observe again before acting");
  const payload = parsed.data as RecordValue;
  const image = payload.image;
  const maxBytes = 4 * 1024 * 1024;
  if (Object.keys(payload).length !== 1 || !record(image) ||
      Object.keys(image).length !== 4 || image.mimeType !== "image/png" ||
      typeof image.data !== "string" || !image.data.length || image.data.length > 4 * Math.ceil(maxBytes / 3) ||
      image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) {
    throw new Error("Malformed screenshot image or base64 limit exceeded");
  }
  const { width, height } = image;
  if (typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) {
    throw new Error("Invalid screenshot dimensions");
  }
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== image.data) throw new Error("Invalid screenshot base64 or byte limit exceeded");
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error("Invalid PNG header or dimensions");
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
    throw new Error("Invalid PNG header encoding");
  }
  let hasData = false;
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("Truncated PNG chunk");
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error("Truncated PNG chunk");
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (type === "IHDR" && offset !== 8) || ["acTL", "fcTL", "fdAT"].includes(type)) {
      throw new Error("Invalid PNG chunk");
    }
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) throw new Error("Invalid PNG checksum");
    if (type === "IDAT" && size > 0) hasData = true;
    if (type === "IEND") {
      if (size !== 0 || end !== bytes.length || !hasData) throw new Error("Invalid PNG end");
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw new Error("Missing PNG end");
  return { mimeType: "image/png", data: image.data, width, height };
}

/** Primary display bounds in guest screen points, the space of coordinate commands. */
function primaryDisplay(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!record(value) || value.version !== "2.6" || value.command !== "list-displays" || value.ok !== true || !Array.isArray(value.data)) {
    throw new Error("Malformed list-displays envelope");
  }
  const primary = value.data.find(display => record(display) && display.is_primary === true);
  const bounds = record(primary) ? primary.bounds : undefined;
  if (!record(bounds) || ![bounds.x, bounds.y, bounds.width, bounds.height].every(n => typeof n === "number" && Number.isFinite(n)) ||
      (bounds.width as number) < 1 || (bounds.height as number) < 1) throw new Error("Primary guest display unavailable");
  return bounds as { x: number; y: number; width: number; height: number };
}

function appName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /^[\s-]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid app name");
  }
}

const REF = /^e[1-9]\d*$/;
const isRef = (value: unknown): value is string => typeof value === "string" && REF.test(value);
const isPoint = (value: unknown): value is ComputerPoint => record(value) && Object.keys(value).length === 2 &&
  [value.x, value.y].every(n => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 16384);
const isEnd = (value: unknown): value is { ref: string } => record(value) && Object.keys(value).length === 1 && isRef(value.ref);
const textValue = (value: unknown) => typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= 65536;

/** Coordinate actions target a screen look's frame; the rest target an observation epoch. */
function usesFrame(action: ComputerAction): boolean {
  return action.kind === "click-at" || (action.kind === "scroll" && action.ref === undefined) ||
    (action.kind === "drag" && !isEnd(action.from));
}

function actionFields(action: ComputerAction): void {
  if (!record(action)) throw new Error("Expected one typed action");
  const fields = action.kind === "click" ? ["kind", "epoch", "ref"]
    : action.kind === "set-value" ? ["kind", "epoch", "ref", "value"]
    : action.kind === "press" ? ["kind", "epoch", "key", "modifiers"]
    : action.kind === "type" ? ["kind", "epoch", "ref", "text"]
    : action.kind === "scroll" ? ["kind", "epoch", "direction", "amount", "ref", "x", "y"]
    : action.kind === "drag" ? ["kind", "epoch", "from", "to"]
    : action.kind === "click-at" ? ["kind", "epoch", "x", "y", "button", "count"] : [];
  if (!fields.length || Object.keys(action).some(key => !fields.includes(key)) || typeof action.epoch !== "string") {
    throw new Error("Invalid action fields");
  }
  if ((action.kind === "click" || action.kind === "set-value") && !isRef(action.ref)) throw new Error("Invalid observation ref");
  if (action.kind === "set-value" && (typeof action.value !== "string" || action.value.includes("\0"))) throw new Error("Invalid value");
  if (action.kind === "type") {
    if (action.ref !== undefined && !isRef(action.ref)) throw new Error("Invalid observation ref");
    if (!textValue(action.text) || !action.text) throw new Error("Invalid text");
  }
  if (action.kind === "scroll") {
    if (!["up", "down", "left", "right"].includes(action.direction)) throw new Error("Invalid scroll direction");
    if (action.amount !== undefined && (!Number.isSafeInteger(action.amount) || action.amount < 1 || action.amount > 50)) throw new Error("Invalid scroll amount");
    const point = action.x !== undefined || action.y !== undefined;
    if (point ? action.ref !== undefined || !isPoint({ x: action.x, y: action.y }) : !isRef(action.ref)) throw new Error("Scroll needs a ref or a point");
  }
  if (action.kind === "drag" && !((isEnd(action.from) && isEnd(action.to)) || (isPoint(action.from) && isPoint(action.to)))) {
    throw new Error("Drag needs two refs or two points");
  }
  if (action.kind === "click-at") {
    if (!isPoint({ x: action.x, y: action.y })) throw new Error("Invalid point");
    if (action.button !== undefined && !["left", "right"].includes(action.button)) throw new Error("Invalid button");
    if (action.count !== undefined && action.count !== 1 && action.count !== 2) throw new Error("Invalid click count");
  }
  if (action.kind === "press") {
    if (typeof action.key !== "string" || !/^(?:[a-zA-Z0-9]|return|escape|tab|space|delete|up|down|left|right|f[1-9]|f1[0-2])$/.test(action.key)) {
      throw new Error("Invalid key");
    }
    if (action.modifiers !== undefined && (!Array.isArray(action.modifiers) || action.modifiers.length > 4 ||
        [...action.modifiers].some(key => !["cmd", "ctrl", "alt", "shift"].includes(key)) || new Set(action.modifiers).size !== action.modifiers.length)) {
      throw new Error("Invalid modifiers");
    }
  }
}

function completeTree(node: RecordValue): boolean {
  if (node.truncated === true || node.subtree_truncated === true || node.identity_unproven === true) return false;
  return !Array.isArray(node.children) || node.children.every(child => completeTree(child as RecordValue));
}

/**
 * A single app in a single guest session. execute must already be guest-only and
 * must settle only when its command is no longer in flight, including on abort.
 * No executable, shell, environment activation string or host fallback is used here.
 * CLI session_id scopes refmaps; it is not an authorization or isolation token.
 */
export class ComputerSession {
  private busy = false;
  private started = false;
  private stopped = false;
  private closing = false;
  private app?: string;
  private sessionId?: string;
  private observations?: ComputerObservation;
  private epoch?: string;
  private frame?: Frame;
  private frames = 0;
  private generation = 0;
  private pending?: AbortController;

  private readonly evaluationFull: boolean;
  private readonly capture?: ComputerObservationCapture;

  constructor(private readonly execute: GuestExecute, evaluation: Partial<ComputerEvaluation> = {}) {
    this.evaluationFull = evaluation.forceFull === true;
    this.capture = evaluation.capture;
  }

  /** Never relaunch on duplicate start. A different app requires another instance. */
  start(app: string, signal?: AbortSignal): Promise<{ sessionId: string; app: string; launch: CommandReport; observation?: SessionObservation; observationError?: string }> {
    return this.exclusive(signal, async active => {
      appName(app);
      if (this.started) throw new Error("Session already started; use another session for another app");
      this.started = true;
      this.app = app;
      // An ambiguous start cannot be repeated: the remote session may already exist.
      const value = envelope(await this.execute(["session", "start", "--no-trace"], active), "session");
      if (!value.ok) throw new Error(`Session start failed: ${JSON.stringify(value.error)}`);
      const id = (value.data as RecordValue).session_id;
      if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new Error("Malformed session_id");
      this.sessionId = id;
      this.observations = new ComputerObservation(id);
      this.checkAbort(active);
      const launch = await this.runReport(["launch", app], "launch", active, false);
      const observed = await this.afterAction(active);
      return { sessionId: id, app, launch, ...observed };
    });
  }

  observe(full = false, signal?: AbortSignal): Promise<SessionObservation> {
    return this.exclusive(signal, active => {
      this.requireSession();
      if (typeof full !== "boolean") throw new Error("full must be a boolean");
      return this.snapshot(full, active);
    });
  }

  /**
   * A screenshot never refreshes refs. An app look is evidence only. A screen look
   * captures the whole primary guest display and returns a frame: the epoch for
   * coordinate actions on that image's pixels, valid until the next action or read.
   */
  look(signal?: AbortSignal, screen = false): Promise<GuestImage> {
    return this.exclusive(signal, async active => {
      this.requireSession();
      const generation = this.generation;
      this.epoch = undefined;
      this.frame = undefined;
      this.observations!.invalidateRefs();
      try {
        this.checkAbort(active);
        const display = screen ? primaryDisplay(await this.execute(["--session", this.sessionId!, "list-displays"], active)) : undefined;
        this.checkAbort(active);
        const value = await this.execute(["--session", this.sessionId!, "screenshot", ...(screen ? ["--screen", "0"] : ["--app", this.app!])], active);
        this.checkAbort(active);
        if (generation !== this.generation) throw new Error("Observations reset during capture; look again");
        const image = screenshotImage(value);
        if (!display) return image;
        const frame: Frame = { id: `f${++this.frames}`, width: image.width, height: image.height,
          scaleX: display.width / image.width, scaleY: display.height / image.height, originX: display.x, originY: display.y };
        this.frame = frame;
        return { ...image, frame: frame.id };
      } catch (error) {
        this.resetObservations();
        throw error;
      }
    });
  }

  act(action: ComputerAction, signal?: AbortSignal): Promise<ActionReport> {
    return this.exclusive(signal, async active => {
      this.requireSession();
      actionFields(action);
      const frame = usesFrame(action) ? this.frame : undefined;
      if (usesFrame(action) ? !frame || action.epoch !== frame.id : !this.epoch || action.epoch !== this.epoch) {
        throw new Error(usesFrame(action) ? "Fresh screen look frame required for coordinates" : "Fresh actionable observation epoch required");
      }
      const commands = this.commands(action, frame);
      this.epoch = undefined;
      this.frame = undefined;
      this.observations!.invalidateRefs();
      let result!: CommandReport;
      for (const [argv, command, requiresDisposition] of commands) {
        result = await this.runReport(argv, command, active, requiresDisposition);
        if (result.ok !== true) break;
      }
      if (result.ok !== true) this.resetObservations();
      return { action: result, ...await this.afterAction(active) };
    });
  }

  /** Guest CLI commands for one action; refs and points are resolved before refs are invalidated. */
  private commands(action: ComputerAction, frame?: Frame): [string[], string, boolean][] {
    const ref = (value: string) => this.observations!.resolve(action.epoch, value);
    const point = ({ x, y }: ComputerPoint) => {
      if (!frame || x >= frame.width || y >= frame.height) throw new Error("Point outside the screen look");
      return [Math.round(frame.originX + x * frame.scaleX), Math.round(frame.originY + y * frame.scaleY)];
    };
    switch (action.kind) {
      case "click": return [[["click", ref(action.ref)], "click", true]];
      case "set-value": return [[["set-value", ref(action.ref), "--", action.value], "set-value", true]];
      case "press": return [[["press", [...(action.modifiers ?? []), action.key].join("+"), "--app", this.app!], "press", true]];
      case "type":
        return action.ref !== undefined ? [[["type", ref(action.ref), "--", action.text], "type", false]]
          // No ref: paste into the focused field through the guest clipboard.
          : [[["clipboard-set", "--", action.text], "clipboard-set", false], [["press", "cmd+v", "--app", this.app!], "press", true]];
      case "scroll": {
        const amount = action.amount ?? 3;
        if (action.ref !== undefined) return [[["scroll", ref(action.ref), "--direction", action.direction, "--amount", String(amount)], "scroll", false]];
        const [x, y] = point({ x: action.x!, y: action.y! });
        const dx = action.direction === "right" ? amount : action.direction === "left" ? -amount : 0;
        const dy = action.direction === "up" ? amount : action.direction === "down" ? -amount : 0;
        return [[["mouse-wheel", `--x=${x}`, `--y=${y}`, `--dx=${dx}`, `--dy=${dy}`, "--headed"], "mouse-wheel", false]];
      }
      case "drag": {
        const side = (name: "from" | "to", value: { ref: string } | ComputerPoint) =>
          "ref" in value ? [`--${name}`, ref(value.ref)] : [`--${name}-xy=${point(value).join(",")}`];
        return [[["drag", ...side("from", action.from), ...side("to", action.to), "--headed"], "drag", false]];
      }
      case "click-at": {
        const [x, y] = point(action);
        return [[["mouse-click", `--xy=${x},${y}`, "--button", action.button ?? "left", "--count", String(action.count ?? 1), "--headed"], "mouse-click", false]];
      }
    }
  }

  /** Invalidate immediately, but retain the lock until execute settles. */
  cancel(): void {
    this.resetObservations();
    this.pending?.abort();
  }

  /** For compaction/model changes. In-flight reads cannot restore the old baseline. */
  resetObservations(): void {
    this.generation++;
    this.epoch = undefined;
    this.frame = undefined;
    this.observations?.invalidate();
    this.capture?.reset();
  }

  forceFull(): void { this.resetObservations(); }

  /** Ends only the CLI namespace, not the app or VM. Explicit end retries are idempotent. */
  stop(signal?: AbortSignal): Promise<CommandReport> {
    return this.exclusive(signal, async active => {
      if (this.stopped) return { ok: true, outcome: "not_delivered" };
      if (!this.sessionId) throw new Error("No known session_id to stop; reconcile an ambiguous start at the transport boundary");
      this.closing = true;
      this.resetObservations();
      let result = await this.runReport(["session", "end", this.sessionId], "session", active, false);
      if (result.ok) {
        const data = (result.envelope as RecordValue).data as RecordValue;
        if (data.session_id !== this.sessionId || data.ended_at == null) result = unknownReport("Malformed session end acknowledgement");
        else this.stopped = true;
      }
      return result;
    });
  }

  private requireSession(): void {
    if (!this.sessionId || !this.observations || this.closing || this.stopped) throw new Error("No active session");
  }

  private checkAbort(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("Computer session operation aborted; observe again before acting");
  }

  private async exclusive<T>(signal: AbortSignal | undefined, work: (active: AbortSignal) => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Computer session operation already in progress");
    if (signal?.aborted) {
      this.resetObservations();
      throw new Error("Computer session operation aborted");
    }
    this.busy = true;
    const controller = new AbortController();
    this.pending = controller;
    const abort = () => { this.resetObservations(); controller.abort(); };
    signal?.addEventListener("abort", abort, { once: true });
    try { return await work(controller.signal); }
    finally {
      signal?.removeEventListener("abort", abort);
      this.pending = undefined;
      this.busy = false;
    }
  }

  private async runReport(argv: string[], command: string, signal: AbortSignal, requiresDisposition = true): Promise<CommandReport> {
    try {
      this.checkAbort(signal);
      const value = await this.execute(["--session", this.sessionId!, ...argv], signal);
      this.checkAbort(signal);
      return report(value, command, requiresDisposition);
    } catch (error) { return unknownReport(error); }
  }

  private async snapshot(full: boolean, signal: AbortSignal): Promise<SessionObservation> {
    const generation = this.generation;
    // The previous refs cannot be used while a replacement observation is pending.
    this.epoch = undefined;
    this.frame = undefined;
    try {
      this.checkAbort(signal);
      const value = await this.execute(["--session", this.sessionId!, "snapshot", "--app", this.app!], signal);
      this.checkAbort(signal);
      if (generation !== this.generation) throw new Error("Observations reset during capture; observe again");
      const observation = this.observations!.accept(value, full || this.evaluationFull);
      this.capture?.record(value);
      const parsed = value as RecordValue;
      const data = parsed.data as RecordValue | undefined;
      if (parsed.ok && data?.complete === true && completeTree(data) && completeTree(data.tree as RecordValue) && !observation.blocked_refs?.length) {
        this.epoch = observation.epoch;
      }
      return observation;
    } catch (error) {
      this.resetObservations();
      throw error;
    }
  }

  private async afterAction(signal: AbortSignal): Promise<{ observation?: SessionObservation; observationError?: string }> {
    try { return { observation: await this.snapshot(false, signal) }; }
    catch (error) { return { observationError: message(error) }; }
  }
}
