import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ComputerObservation } from "./computer-observation.ts";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OBSERVATIONS = 10_000;
const failure = (operation: string) => new Error(`Computer observation ${operation} failed`);

function privateDirectory(path: string, expected?: Stats): Stats {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("Unsafe directory");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 ||
      (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino))) throw new Error("Unsafe directory");
  return stat;
}

function privateFile(stat: Stats): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600) {
    throw new Error("Unsafe file");
  }
}

function writePrivate(path: string, text: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { privateFile(fstatSync(fd)); writeFileSync(fd, text, "utf8"); }
  finally { closeSync(fd); }
}

/** Project only the desktop envelope; never persist transport identity, stderr or command reports. */
function snapshotEnvelope(value: unknown, validator: ComputerObservation): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid snapshot");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const envelope: Record<string, unknown> = {};
  for (const key of ["version", "command", "ok", "data", "error"]) {
    const descriptor = descriptors[key];
    if (!descriptor) continue;
    if (!("value" in descriptor)) throw new Error("Invalid snapshot");
    envelope[key] = descriptor.value;
  }
  // Validates the entire projected JSON, including unknown fields inside data/error.
  validator.accept(envelope, true);
  return JSON.stringify(envelope);
}

/** Raw UI content remains sensitive. This is local capture, not redaction or an OS sandbox. */
export class ComputerObservationCapture {
  private readonly root: string;
  private readonly rootStat: Stats;
  private readonly validator = new ComputerObservation("capture");
  private run?: { path: string; stat: Stats };
  private segment?: { path: string; stat: Stats; count: number };
  private segmentNumber = 0;
  private totalBytes = 0;
  private count = 0;
  private failed = false;

  constructor(root: string) {
    this.root = root;
    this.rootStat = privateDirectory(root);
  }

  /** A context/model/ref baseline reset must never be silently replayed as one continuous trace. */
  reset(): void { this.segment = undefined; this.validator.invalidate(); }

  record(value: unknown): void {
    try {
      if (this.failed) throw new Error("Capture incomplete");
      const text = snapshotEnvelope(value, this.validator);
      const size = Buffer.byteLength(text);
      if (this.count >= MAX_OBSERVATIONS || this.totalBytes + size > MAX_BYTES) throw new Error("Capture limit");
      privateDirectory(this.root, this.rootStat);
      if (!this.run) {
        const path = mkdtempSync(join(this.root, "computer-capture-"));
        this.run = { path, stat: privateDirectory(path) };
      }
      privateDirectory(this.run.path, this.run.stat);
      if (!this.segment) {
        const path = join(this.run.path, `segment-${String(++this.segmentNumber).padStart(8, "0")}`);
        mkdirSync(path, { mode: 0o700 });
        this.segment = { path, stat: privateDirectory(path), count: 0 };
      }
      privateDirectory(this.segment.path, this.segment.stat);
      writePrivate(join(this.segment.path, `${String(this.segment.count + 1).padStart(8, "0")}.json`), text);
      this.segment.count++;
      this.count++;
      this.totalBytes += size;
    } catch {
      // A failed recorder cannot silently resume and produce a trace with missing observations.
      this.failed = true;
      throw failure("capture");
    }
  }
}

export type ComputerEvaluation = Readonly<{ forceFull: boolean; capture?: ComputerObservationCapture }>;

/** Trusted application environment only. Do not expose these settings as tool parameters. */
export function createComputerEvaluation(env: Readonly<Record<string, string | undefined>>): ComputerEvaluation {
  try {
    const mode = env.ONDRA_COMPUTER_EVALUATION_MODE;
    if (mode !== undefined && mode !== "compact" && mode !== "forced-full") throw new Error("Invalid mode");
    const root = env.ONDRA_COMPUTER_CAPTURE_DIR;
    return Object.freeze({ forceFull: mode === "forced-full", ...(root !== undefined ? { capture: new ComputerObservationCapture(root) } : {}) });
  } catch { throw new Error("Invalid computer evaluation configuration"); }
}

/**
 * Developer-only local export of one completed context segment, not a model tool.
 * Both directories must already be canonical, owned and 0700. Creates a fresh
 * 0700 child with a 0600 snapshots.json; never overwrites a destination or follows
 * a source symlink. The ordered array is input to compare-observations.mjs.
 * No tokens, latency, model/tool counts or application success are inferred.
 */
export function exportComputerObservations(segmentDirectory: string, destinationDirectory: string): { path: string; observations: number } {
  let output: string | undefined;
  try {
    const sourceStat = privateDirectory(segmentDirectory);
    const destinationStat = privateDirectory(destinationDirectory);
    const names = readdirSync(segmentDirectory).sort();
    if (!names.length || names.length > MAX_OBSERVATIONS ||
        names.some((name, index) => name !== `${String(index + 1).padStart(8, "0")}.json`)) throw new Error("Invalid sequence");
    const validator = new ComputerObservation("export");
    let totalBytes = 0;
    const snapshots = names.map(name => {
      privateDirectory(segmentDirectory, sourceStat);
      const fd = openSync(join(segmentDirectory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        privateFile(stat);
        totalBytes += stat.size;
        if (stat.size > 8 * 1024 * 1024 || totalBytes > MAX_BYTES) throw new Error("Export limit");
        const bytes = readFileSync(fd);
        if (bytes.length !== stat.size) throw new Error("Capture changed");
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        return snapshotEnvelope(value, validator);
      } finally { closeSync(fd); }
    });
    privateDirectory(segmentDirectory, sourceStat);
    if (JSON.stringify(readdirSync(segmentDirectory).sort()) !== JSON.stringify(names)) throw new Error("Capture changed");
    privateDirectory(destinationDirectory, destinationStat);
    output = mkdtempSync(join(destinationDirectory, "computer-export-"));
    privateDirectory(output);
    const path = join(output, "snapshots.json");
    writePrivate(path, `[${snapshots.join(",")}]\n`);
    return { path, observations: snapshots.length };
  } catch {
    if (output) rmSync(output, { recursive: true, force: true });
    throw failure("export");
  }
}
