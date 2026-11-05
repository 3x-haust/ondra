import { describe, expect, it } from "vitest";
import { broadKill } from "../extensions/permissions";

describe("killing processes", () => {
  it.each(["pkill -f Electron; sleep 2", 'pkill -f "vite"', "killall Simulator", "pkill node", "cd /x && sudo pkill -9 chrome"])(
    "blocks %s, which also kills the user's own apps",
    (command) => expect(broadKill(command)).toBeTruthy(),
  );

  it.each([
    'pkill -f "/Users/me/worktrees/a/app/node_modules/electron"',
    "pkill -f 'next dev --port 3100'",
    "lsof -ti :3000 | xargs kill",
    "kill 1234",
    "ps aux | grep electron",
  ])("allows %s, which only reaches what the job started", (command) => expect(broadKill(command)).toBeUndefined());
});
