// The main chat's own tools, behind use: the chat starts with only use
// declared and calls read / bash through it when it needs them.
// Every engine loads the app's extensions; only the main chat (started with
// ONDRA_MAIN=1 and --no-builtin-tools) gets these. Jobs keep the built-in tools.
import { createBashToolDefinition, createReadToolDefinition } from "@earendil-works/pi-coding-agent";

export default function (pi: any) {
  if (process.env.ONDRA_MAIN !== "1") return;
  const cwd = process.cwd();
  for (const def of [createReadToolDefinition(cwd), createBashToolDefinition(cwd)]) pi.registerTool({ ...def, exposure: "deferred" });
}
