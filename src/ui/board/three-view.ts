// A board's 3D model: each part a simple shape with a real-looking material, built
// in the order the explanation goes, turned by dragging, clicked to pick a part.
// Loaded only when a board has parts. It draws only when something changes (a drag,
// a part appearing): no frame loop runs while nothing moves.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Material, Part, Tone } from "./parse";
import { short } from "./names";

const LOOKS: Record<Material, { color: string; metal: number; rough: number; opacity?: number }> = {
  steel: { color: "#a9adb3", metal: 0.85, rough: 0.32 },
  wood: { color: "#b58358", metal: 0, rough: 0.75 },
  glass: { color: "#cfe6f2", metal: 0, rough: 0.05, opacity: 0.35 },
  gold: { color: "#d4a73c", metal: 1, rough: 0.28 },
  copper: { color: "#c57b4f", metal: 1, rough: 0.35 },
  rubber: { color: "#2b2b2e", metal: 0, rough: 0.9 },
  plastic: { color: "#34373c", metal: 0, rough: 0.5 },
  stone: { color: "#9b958c", metal: 0, rough: 0.95 },
  paper: { color: "#f4f1ea", metal: 0, rough: 1 },
};
const TONE_VAR: Record<Tone, string> = { ink: "--ink-2", quiet: "--ink-3", accent: "--accent", ok: "--ok", warn: "--warn", bad: "--bad", live: "--live", violet: "--merged" };

function geometry(p: Part): THREE.BufferGeometry {
  const [a, b, c] = p.dims;
  switch (p.shape) {
    // corners softened a little, as made things have
    case "box": return new RoundedBoxGeometry(a, b, c, 2, Math.min(a, b, c) * 0.05);
    case "cylinder": return new THREE.CylinderGeometry(c ?? a, a, b, 40);
    case "cone": return new THREE.ConeGeometry(a, b, 40);
    case "sphere": return new THREE.SphereGeometry(a, 40, 24);
    case "torus": return new THREE.TorusGeometry(a, b, 20, 64);
    case "capsule": return new THREE.CapsuleGeometry(a, b, 8, 24);
  }
}

/** the drawn outline of a shape: its edges as thin dark lines, so it reads like an illustration */
function outline(p: Part): THREE.BufferGeometry | undefined {
  const [a, b, c] = p.dims;
  switch (p.shape) {
    case "box": return new THREE.EdgesGeometry(new THREE.BoxGeometry(a, b, c));
    case "cylinder": return new THREE.EdgesGeometry(new THREE.CylinderGeometry(c ?? a, a, b, 40), 30);
    case "cone": return new THREE.EdgesGeometry(new THREE.ConeGeometry(a, b, 40), 30);
    default: return undefined;
  }
}
const sizeNow = new THREE.Vector2();
const EDGE = new THREE.LineBasicMaterial({ color: "#16181b", transparent: true, opacity: 0.6 });

const key = (p: Part) => JSON.stringify([p.shape, p.dims, p.at, p.rot, p.look]);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export type ThreeView = {
  /** show these parts; each new one appears after its delay (ms), or at once when delays are absent */
  set(parts: Part[], delays?: number[]): void;
  select(i: number | null): void;
  /** draw again: after the board was moved in the page (WebKit clears a moved canvas) */
  wake(): void;
  dispose(): void;
};

/**
 * One WebGL renderer for every 3D board in the app, so a page with many 3D boards holds
 * one GPU context (and one lighting room) instead of one each, which is what makes
 * WebKit drop contexts. Its canvas sits live in the board being drawn (turned, built);
 * the board it leaves keeps a still picture of its last frame. Copying every frame
 * instead would read the picture back from the GPU each time, which stutters.
 * If the context is lost anyway, a new renderer is made and every board draws again.
 */
type Shared = { renderer: THREE.WebGLRenderer; env: THREE.Texture; owner?: { leave: () => void } };
let shared: Shared | undefined;
const boards = new Set<() => void>();
function sharedRenderer(): Shared {
  if (shared) return shared;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // a board's light never moves with its camera, so its shadow is worked out only when the model changes
  renderer.shadowMap.autoUpdate = false;
  // a soft room around the model, so metal reflects something instead of going black
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.04).texture;
  room.dispose?.();
  pmrem.dispose();
  renderer.domElement.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  const made: Shared = { renderer, env };
  renderer.domElement.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    if (shared !== made) return;
    shared = undefined;
    renderer.domElement.remove();
    env.dispose();
    renderer.dispose();
    setTimeout(() => boards.forEach((redraw) => redraw()), 200);
  });
  shared = made;
  return made;
}

export function createThreeView(host: HTMLElement, opts: { onPick: (i: number | null, at?: { x: number; y: number }) => void; onLost?: () => void }): ThreeView {
  const css = getComputedStyle(host);
  const cssColor = (v: string) => css.getPropertyValue(v).trim() || "#888";
  // the board's drawing surface: the live renderer canvas while this board is drawn,
  // and under it a still picture of its last frame for when another board has the renderer
  const canvas = document.createElement("div");
  canvas.className = "bd-surface";
  const still = document.createElement("canvas");
  still.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block";
  canvas.appendChild(still);
  host.appendChild(canvas);
  // 1.5× is sharp enough with antialiasing and much lighter than 2× on a retina screen
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  let cssW = 0, cssH = 0;
  // each part's name beside it, joined to it by a thin line; kept next to the part as the model turns
  const labels = document.createElement("div");
  labels.className = "bd-labels";
  const leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  leaders.setAttribute("class", "bd-leaders");
  labels.appendChild(leaders);
  host.appendChild(labels);
  type Label = { chip: HTMLButtonElement; line: SVGLineElement; dot: SVGCircleElement; cw: number; ch: number };
  const chips = new Map<number, Label>();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.01, 1000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a90, 0.8));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(4, 7, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.radius = 4;
  scene.add(sun, sun.target);
  // no floor, only the soft shadow the model casts on where a floor would be
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  scene.add(catcher);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-5, 2, -3);
  scene.add(fill);
  scene.environmentIntensity = 0.55;
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  // follows the hand closely, with only a short glide after letting go
  controls.dampingFactor = 0.2;
  controls.enablePan = false;

  type Shown = { key: string; mesh: THREE.Mesh; from: number };
  let shown: Shown[] = [];
  let selected: number | null = null;
  let frame = 0;
  let fitted = "";

  let later = 0;
  let shadowStale = true;
  const draw = () => {
    frame = 0;
    clearTimeout(later);
    const now = performance.now();
    let moving = controls.update();
    let next = Infinity;
    if (!merged) for (const s of shown) {
      const t = s.from <= now ? Math.min(1, (now - s.from) / 420) : 0;
      if (t === 1 && s.mesh.scale.x === 1 && s.mesh.visible) continue;
      s.mesh.scale.setScalar(Math.max(0.0001, ease(t)));
      s.mesh.visible = t > 0;
      if (t > 0 && t < 1) moving = true;
      if (t === 0) next = Math.min(next, s.from);
      if (t === 1) shadowStale = true;
    }
    // built and still: draw it as a handful of merged shapes from now on
    if (!merged && !moving && next === Infinity && shown.length) consolidate();
    if (cssW && cssH) {
      const sh = sharedRenderer();
      // take the live canvas over; the board that had it keeps a picture of its last frame
      if (sh.owner !== me) {
        sh.owner?.leave();
        sh.owner = me;
        canvas.appendChild(sh.renderer.domElement);
      }
      paintFrame(sh);
      still.hidden = true;
    }
    placeLabels();
    // frames only while something moves; a part still to come wakes it at its moment
    if (moving) frame = requestAnimationFrame(draw);
    else if (next < Infinity) later = window.setTimeout(wake, Math.max(16, next - now));
  };
  const center = new THREE.Vector3();
  const v = new THREE.Vector3();
  const toScreen = (p: THREE.Vector3, w: number, h: number) => {
    v.copy(p).project(camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  };
  /**
   * The names of the parts that matter (the biggest, at most 8), as coloured tags in a
   * row above the model and a row below it, each joined to its part by a thin line, so
   * they never cover the model or each other. A part without a tag is still named on click.
   */
  const placeLabels = () => {
    const w = host.clientWidth, h = host.clientHeight;
    leaders.setAttribute("viewBox", `0 0 ${w} ${h}`);
    const named = new Set<string>();
    const order = shown.map((_, i) => i).sort((a, b) => (shown[b].mesh.userData.size ?? 0) - (shown[a].mesh.userData.size ?? 0));
    const want: { i: number; name: string; p: { x: number; y: number } }[] = [];
    for (const i of order) {
      const s = shown[i];
      const name = short(String(s.mesh.userData.label ?? ""));
      if (!name || named.has(name) || (!merged && !s.mesh.visible) || s.mesh.scale.x < 0.6 || want.length >= 8) continue;
      named.add(name);
      want.push({ i, name, p: toScreen(s.mesh.position, w, h) });
    }
    const on = new Set(want.map((x) => x.i));
    for (const [i, l] of chips) if (!on.has(i)) { l.chip.hidden = true; l.line.setAttribute("visibility", "hidden"); l.dot.setAttribute("visibility", "hidden"); }
    const tag = (i: number, name: string): Label => {
      let l = chips.get(i);
      if (l) return l;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `bd-chip bd-chip-${chips.size % 5}`;
      chip.textContent = name;
      chip.title = String(shown[i].mesh.userData.label ?? "");
      chip.onclick = (e) => {
        e.stopPropagation();
        const r = host.getBoundingClientRect(), c = chip.getBoundingClientRect();
        selected = i;
        highlight();
        opts.onPick(i, { x: c.left - r.left, y: c.bottom - r.top + 40 });
      };
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", "2.5");
      leaders.append(line, dot);
      labels.appendChild(chip);
      // measured once: reading sizes every frame makes the page lay itself out again each time
      l = { chip, line, dot, cw: chip.offsetWidth || name.length * 9 + 20, ch: chip.offsetHeight || 24 };
      chips.set(i, l);
      return l;
    };
    // a row: each tag over its part, pushed right past the one before, then back left from the edge
    const lay = (row: typeof want, top: boolean) => {
      const items = row.map((x) => {
        const l = tag(x.i, x.name);
        l.chip.hidden = false;
        return { ...x, l, cw: l.cw, ch: l.ch, x: 0 };
      }).sort((a, b) => a.p.x - b.p.x);
      let edge = 8;
      for (const it of items) { it.x = Math.max(edge, it.p.x - it.cw / 2); edge = it.x + it.cw + 8; }
      edge = w - 8;
      for (const it of [...items].reverse()) { it.x = Math.min(it.x, edge - it.cw); edge = it.x - 8; }
      for (const it of items) {
        const fits = it.x >= 4;
        const y = top ? 10 : h - it.ch - 10;
        it.l.chip.hidden = !fits;
        it.l.line.setAttribute("visibility", fits ? "visible" : "hidden");
        it.l.dot.setAttribute("visibility", fits ? "visible" : "hidden");
        if (!fits) continue;
        it.l.chip.style.transform = `translate(${Math.round(it.x)}px, ${Math.round(y)}px)`;
        it.l.chip.classList.toggle("is-on", selected === it.i);
        const ex = Math.max(it.x + 6, Math.min(it.x + it.cw - 6, it.p.x)), ey = top ? y + it.ch : y;
        for (const [k, val] of [["x1", it.p.x], ["y1", it.p.y], ["x2", ex], ["y2", ey]] as const) it.l.line.setAttribute(k, String(Math.round(val)));
        it.l.dot.setAttribute("cx", String(Math.round(it.p.x)));
        it.l.dot.setAttribute("cy", String(Math.round(it.p.y)));
      }
    };
    // the higher half of the parts name above, the lower half below
    const byY = [...want].sort((a, b) => a.p.y - b.p.y);
    const half = Math.ceil(byY.length / 2);
    lay(byY.slice(0, half), true);
    lay(byY.slice(half), false);
    for (const [i, l] of chips) if (i >= shown.length) (l.chip.remove(), l.line.remove(), l.dot.remove(), chips.delete(i));
  };
  const wake = () => { if (!frame) frame = requestAnimationFrame(draw); };
  /** this board's scene, drawn by the shared renderer at this board's size */
  const paintFrame = (sh: Shared) => {
    const { renderer } = sh;
    scene.environment = sh.env;
    if (renderer.getPixelRatio() !== dpr) renderer.setPixelRatio(dpr);
    const size = renderer.getSize(sizeNow);
    if (size.x !== cssW || size.y !== cssH) renderer.setSize(cssW, cssH, false);
    renderer.shadowMap.needsUpdate = shadowStale;
    shadowStale = false;
    renderer.render(scene, camera);
    renderer.shadowMap.needsUpdate = false;
  };
  const me = {
    /** another board takes the renderer: keep a picture of this one (read back once, not every frame) */
    leave: () => {
      const sh = shared;
      if (!sh) return;
      paintFrame(sh);
      still.width = sh.renderer.domElement.width;
      still.height = sh.renderer.domElement.height;
      still.getContext("2d")?.drawImage(sh.renderer.domElement, 0, 0);
      still.hidden = false;
    },
  };
  controls.addEventListener("change", wake);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    cssW = w;
    cssH = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  // put back into the page or scrolled into view: draw it again
  const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && wake());
  io.observe(host);
  // the shared renderer was made again: this board's shadow and picture with it
  const redraw = () => { shadowStale = true; wake(); };
  boards.add(redraw);

  /** frame the whole model from a three-quarter view, once its extent is known */
  const fit = (parts: Part[]) => {
    const box = new THREE.Box3();
    for (const s of shown) { s.mesh.updateMatrixWorld(); box.expandByObject(s.mesh, true); }
    if (box.isEmpty()) return;
    const sig = parts.map(key).join("|");
    if (sig === fitted) return;
    fitted = sig;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    center.copy(sphere.center);
    const r = Math.max(0.05, sphere.radius);
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 0.85;
    controls.target.copy(sphere.center);
    camera.position.set(sphere.center.x + dist * 0.62, sphere.center.y + dist * 0.42, sphere.center.z + dist * 0.66);
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls.minDistance = r * 0.8;
    controls.maxDistance = dist * 4;
    // the light and its shadow sized to the model
    sun.target.position.copy(sphere.center);
    sun.position.copy(sphere.center).add(new THREE.Vector3(0.6, 1.4, 0.8).multiplyScalar(r * 2));
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -r * 1.4;
    sc.right = sc.top = r * 1.4;
    sc.near = r * 0.1;
    sc.far = r * 6;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = r * 0.004;
    catcher.scale.setScalar(r * 6);
    catcher.position.set(sphere.center.x, box.min.y - r * 0.002, sphere.center.z);
  };

  const material = (p: Part) => {
    if (p.look in LOOKS) {
      const l = LOOKS[p.look as Material];
      return new THREE.MeshStandardMaterial({ color: l.color, metalness: l.metal, roughness: l.rough,
        ...(l.opacity ? { transparent: true, opacity: l.opacity } : {}) });
    }
    // a #hex is the colour the thing really has; a tone is the app's colour
    const color = p.look.startsWith("#") ? p.look : cssColor(TONE_VAR[p.look as Tone] ?? "--ink-3");
    return new THREE.MeshStandardMaterial({ color, metalness: 0.05, roughness: 0.55 });
  };

  // the same shape at the same size (a row of pins) shares one geometry and one outline
  const shapes = new Map<string, { geo: THREE.BufferGeometry; edges?: THREE.BufferGeometry }>();
  const shapeOf = (p: Part) => {
    const k = JSON.stringify([p.shape, p.dims]);
    let g = shapes.get(k);
    if (!g) {
      g = { geo: geometry(p), edges: outline(p) };
      g.geo.computeBoundingSphere();
      shapes.set(k, g);
    }
    return g;
  };
  const drop = (m: THREE.Mesh) => (m.material as THREE.Material).dispose();

  const highlight = () => {
    shown.forEach((s, i) => {
      const m = s.mesh.material as THREE.MeshStandardMaterial;
      m.emissive.set(i === selected ? cssColor("--accent") : "#000000");
      m.emissiveIntensity = i === selected ? 0.35 : 0;
      // over the merged model, the picked part is drawn again on its own, lit, just in front
      m.polygonOffset = i === selected;
      m.polygonOffsetFactor = m.polygonOffsetUnits = -2;
      if (merged) s.mesh.visible = i === selected;
    });
    wake();
  };

  /**
   * Each part is its own draw (and its outline another), a few hundred for a detailed
   * model, which is what makes turning it stutter in WebKit. Once the model is built
   * and still, its parts are merged by look into a handful of shapes and one outline;
   * the parts stay, unseen, for picking and for the next change.
   */
  let merged: THREE.Group | null = null;
  let mergedMats: THREE.Material[] = [];
  const unmerge = () => {
    if (!merged) return;
    scene.remove(merged);
    merged.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    mergedMats.forEach((m) => m.dispose());
    merged = null;
    mergedMats = [];
    for (const s of shown) s.mesh.visible = true;
    shadowStale = true;
  };
  const consolidate = () => {
    if (merged || shown.length < 12) return;
    const looks = new Map<string, { mat: THREE.MeshStandardMaterial; geos: THREE.BufferGeometry[] }>();
    const lines: THREE.BufferGeometry[] = [];
    const only = (g: THREE.BufferGeometry, keep: string[]) => { for (const n of Object.keys(g.attributes)) if (!keep.includes(n)) g.deleteAttribute(n); return g; };
    for (const s of shown) {
      s.mesh.updateMatrixWorld(true);
      const m = s.mesh.material as THREE.MeshStandardMaterial;
      const k = `${m.color.getHexString()}|${m.metalness}|${m.roughness}|${m.opacity}`;
      let l = looks.get(k);
      if (!l) {
        const mat = m.clone();
        mat.emissive.set("#000000");
        mat.emissiveIntensity = 0;
        mat.polygonOffset = false;
        looks.set(k, (l = { mat, geos: [] }));
      }
      const g = only(s.mesh.geometry.index ? s.mesh.geometry.toNonIndexed() : s.mesh.geometry.clone(), ["position", "normal"]);
      l.geos.push(g.applyMatrix4(s.mesh.matrixWorld));
      const edge = s.mesh.children[0] as THREE.LineSegments | undefined;
      if (edge) lines.push(only(edge.geometry.clone(), ["position"]).applyMatrix4(s.mesh.matrixWorld));
    }
    const group = new THREE.Group();
    let ok = true;
    for (const l of looks.values()) {
      const g = mergeGeometries(l.geos);
      l.geos.forEach((x) => x.dispose());
      mergedMats.push(l.mat);
      if (!g) { ok = false; continue; }
      const mesh = new THREE.Mesh(g, l.mat);
      mesh.castShadow = true;
      group.add(mesh);
    }
    const lg = lines.length ? mergeGeometries(lines) : null;
    lines.forEach((x) => x.dispose());
    if (lg) group.add(new THREE.LineSegments(lg, EDGE));
    merged = group;
    if (!ok) return unmerge();
    scene.add(group);
    shown.forEach((s, i) => (s.mesh.visible = i === selected));
    shadowStale = true;
  };

  // a click (not a drag) picks the part under the pointer
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return void (down = null);
    down = null;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(shown.filter((s) => s.mesh.visible).map((s) => s.mesh), false)[0];
    const i = hit ? shown.findIndex((s) => s.mesh === hit.object) : -1;
    selected = i >= 0 ? i : null;
    highlight();
    opts.onPick(selected, selected === null ? undefined : { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    canvas.style.cursor = ray.intersectObjects(shown.map((s) => s.mesh), false)[0] ? "pointer" : "grab";
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointermove", onMove);

  return {
    set(parts, delays) {
      const now = performance.now();
      // a change to the model: back to separate parts until it is still again
      if (parts.length !== shown.length || parts.some((p, i) => shown[i]?.key !== key(p))) unmerge();
      const next: Shown[] = parts.map((p, i) => {
        const old = shown[i];
        if (old && old.key === key(p)) return old;
        if (old) { scene.remove(old.mesh); drop(old.mesh); }
        const shape = shapeOf(p);
        const mesh = new THREE.Mesh(shape.geo, material(p));
        mesh.position.set(...p.at);
        mesh.rotation.set(...(p.rot.map((d) => (d * Math.PI) / 180) as [number, number, number]));
        mesh.userData.label = p.label;
        mesh.castShadow = true;
        if (shape.edges) mesh.add(new THREE.LineSegments(shape.edges, EDGE));
        mesh.userData.size = mesh.geometry.boundingSphere?.radius ?? 0;
        scene.add(mesh);
        // a part replaced in place is just there; a new one grows in at its moment
        const from = old || !delays ? now - 1000 : now + (delays[i] ?? 0);
        return { key: key(p), mesh, from };
      });
      for (const s of shown.slice(parts.length)) { scene.remove(s.mesh); drop(s.mesh); }
      shown = next;
      // measure at full size, then let draw() scale them in
      for (const s of shown) s.mesh.scale.setScalar(1);
      fit(parts);
      shadowStale = true;
      highlight();
      resize();
    },
    select(i) { selected = i; highlight(); },
    wake,
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
      controls.dispose();
      unmerge();
      for (const s of shown) drop(s.mesh);
      for (const g of shapes.values()) { g.geo.dispose(); g.edges?.dispose(); }
      clearTimeout(later);
      catcher.geometry.dispose();
      (catcher.material as THREE.Material).dispose();
      boards.delete(redraw);
      sun.shadow.dispose();
      if (shared?.owner === me) { shared.owner = undefined; shared.renderer.domElement.remove(); }
      canvas.remove();
      labels.remove();
    },
  };
}
