import type { ComputerInput } from "../computer";

const appPattern = "^[a-zA-Z0-9_][a-zA-Z0-9_. -]{0,119}\\.[eE][xX][eE]$";
const app = new RegExp(appPattern);
const step = {
  type: "object", additionalProperties: false, required: ["kind", "ref", "direction"], properties: {
    kind: { const: "scroll", type: "string" }, ref: { type: "integer", minimum: 1 },
    direction: { type: "string", enum: ["up", "down"] },
  },
};
export const windowsParameters = {
  type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: ["start", "observe", "act", "stop"] },
    app: { type: "string", pattern: appPattern, description: "start: exact running executable basename, no path" },
    input: step, full: { type: "boolean" }, query: { type: "string" },
  },
};
export const windowsDescription = "Use one already-running Windows app on this Windows worker's interactive desktop. start {app: exact executable basename} asks the user to confirm the running app and PID before reading it, observe {full?, query?}, act {input:{kind:'scroll',ref,direction:'down'|'up'}}, stop. UI Automation exposes supported visible lists/documents only. Each scroll moves one increment. No launch, capture, keys, clicks, text input, dialog, approval, elevated app, or remote input. If refused, ask the user to do that step; do not try another input path.";

export function validateWindows(input: ComputerInput): void {
  const a = input?.input;
  if (!windowsParameters.properties.action.enum.includes(input?.action) ||
      (input.action === "start" && (typeof input.app !== "string" || !app.test(input.app))) ||
      (input.action === "act" && (!a || input.steps !== undefined || a.kind !== "scroll" ||
        Object.keys(a).some(k => !["kind", "ref", "direction"].includes(k)) ||
        typeof a.ref !== "number" || !Number.isSafeInteger(a.ref) || a.ref < 1 || !["up", "down"].includes(a.direction)))) {
    throw new Error("WINDOWS_UNSUPPORTED: start by exact running .exe name, observe, scroll one visible list/document by ref, or stop");
  }
}
