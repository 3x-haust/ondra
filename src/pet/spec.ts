// A pet's pictures: the built-in one (src/pet/default, made by scripts/make-pet.py) or one a job
// made in <data>/pets/<id>/ (the pet-maker skill): a pet.json and a GIF per act.
//   { "name": "피카츄", "faces": "right", "actions": { "idle": "idle.gif", "walk": "walk.gif", … } }
import { ACTS, type Act } from "./brain";
import idle from "./default/idle.gif";
import walk from "./default/walk.gif";
import sit from "./default/sit.gif";
import sleep from "./default/sleep.gif";
import fall from "./default/fall.gif";
import drag from "./default/drag.gif";
import happy from "./default/happy.gif";
import alert from "./default/alert.gif";
import sad from "./default/sad.gif";
import work from "./default/work.gif";
import climb from "./default/climb.gif";
import cling from "./default/cling.gif";
import poke from "./default/poke.gif";
import play from "./default/play.gif";
import greet from "./default/greet.gif";

export interface PetSpec {
  id: string;
  name: string;
  /** the way its pictures face; it is mirrored to walk the other way */
  faces: "left" | "right";
  /** act → picture address */
  actions: Partial<Record<Act, string>>;
}

export const BUILTIN: PetSpec = { id: "default", name: "온디", faces: "right", actions: { idle, walk, sit, sleep, fall, drag, happy, alert, sad, work, climb, cling, poke, play, greet } };

/** pet.json, checked: a picture per act is a plain file name in its folder (no paths out of it), and it has idle */
export function parseSpec(id: string, json: string, src: (file: string) => string): PetSpec | null {
  let j: any;
  try {
    j = JSON.parse(json);
  } catch {
    return null;
  }
  const actions: Partial<Record<Act, string>> = {};
  for (const a of ACTS) {
    const f = j?.actions?.[a];
    if (typeof f === "string" && /^[\w.-]+\.(gif|png|webp)$/i.test(f) && !f.startsWith(".")) actions[a] = src(f);
  }
  if (!actions.idle) return null;
  return { id, name: typeof j.name === "string" && j.name.trim() ? j.name.trim().slice(0, 40) : id, faces: j.faces === "left" ? "left" : "right", actions };
}
