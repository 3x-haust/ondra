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

/** Where the character itself is in a picture (its first frame), in the picture's pixels: the first and last
 *  columns and rows where something shows. Pets are sized by its height and put against walls by its sides,
 *  so a picture drawn with room around it shows the same as one cut close. null: nothing showing. */
export function bodyBox(rgba: Uint8ClampedArray, w: number, h: number, alpha = 40): { l: number; r: number; t: number; b: number } | null {
  let l = w, r = -1, t = -1, b = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] <= alpha) continue;
      if (t < 0) t = y;
      b = y;
      if (x < l) l = x;
      if (x > r) r = x;
    }
  }
  return t < 0 ? null : { l, r, t, b };
}

/** how tall the character is in a picture's pixels (bodyBox) */
export const bodyHeight = (rgba: Uint8ClampedArray, w: number, h: number, alpha = 40) => {
  const box = bodyBox(rgba, w, h, alpha);
  return box ? box.b - box.t + 1 : null;
};

export interface PictureBody {
  w: number;
  h: number;
  /** the character in it (the whole picture when it can't be read) */
  box: { l: number; r: number; t: number; b: number };
}

/** a picture by address: its size and where the character is in it */
export async function pictureBody(src: string): Promise<PictureBody | null> {
  const im = new Image();
  im.crossOrigin = "anonymous";
  const ok = await new Promise<boolean>((done) => {
    im.onload = () => done(true);
    im.onerror = () => done(false);
    im.src = src;
  });
  const w = im.naturalWidth, h = im.naturalHeight;
  if (!ok || !w || !h) return null;
  const whole = { w, h, box: { l: 0, r: w - 1, t: 0, b: h - 1 } };
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    if (!x) return whole;
    x.drawImage(im, 0, 0);
    const box = bodyBox(x.getImageData(0, 0, w, h).data, w, h);
    return box ? { w, h, box } : whole;
  } catch {
    return whole;
  }
}
