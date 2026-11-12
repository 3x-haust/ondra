// A board's 3D model: each part a simple shape with a real-looking material, built
// in the order the explanation goes, turned by dragging, clicked to pick a part.
// Loaded only when a board has parts. It draws only when something changes (a drag,
// a part appearing): no frame loop runs while nothing moves.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Material, Part, Tone } from "./parse";

const LOOKS: Record<Material, { color: string; metal: number; rough: number; opacity?: number }> = {
  steel: { color: "#a9adb3", metal: 0.85, rough: 0.32 },
  wood: { color: "#b58358", metal: 0, rough: 0.75 },
  glass: { color: "#cfe6f2", metal: 0, rough: 0.05, opacity: 0.35 },
  gold: { color: "#d4a73c", metal: 1, rough: 0.28 },
  copper: { color: "#c57b4f", metal: 1, rough: 0.35 },
  rubber: { color: "#2b2b2e", metal: 0, rough: 0.9 },
  plastic: { color: "#e8e8ea", metal: 0, rough: 0.45 },
  stone: { color: "#9b958c", metal: 0, rough: 0.95 },
  paper: { color: "#f4f1ea", metal: 0, rough: 1 },
};
const TONE_VAR: Record<Tone, string> = { ink: "--ink-2", quiet: "--ink-3", accent: "--accent", ok: "--ok", warn: "--warn", bad: "--bad", live: "--live", violet: "--merged" };

function geometry(p: Part): THREE.BufferGeometry {
  const [a, b, c] = p.dims;
  switch (p.shape) {
    case "box": return new THREE.BoxGeometry(a, b, c);
    case "cylinder": return new THREE.CylinderGeometry(c ?? a, a, b, 40);
    case "cone": return new THREE.ConeGeometry(a, b, 40);
    case "sphere": return new THREE.SphereGeometry(a, 40, 24);
    case "torus": return new THREE.TorusGeometry(a, b, 20, 64);
    case "capsule": return new THREE.CapsuleGeometry(a, b, 8, 24);
  }
}

const key = (p: Part) => JSON.stringify([p.shape, p.dims, p.at, p.rot, p.look]);
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export type ThreeView = {
  /** show these parts; each new one appears after its delay (ms), or at once when delays are absent */
  set(parts: Part[], delays?: number[]): void;
  select(i: number | null): void;
  dispose(): void;
};

export function createThreeView(host: HTMLElement, opts: { onPick: (i: number | null, at?: { x: number; y: number }) => void }): ThreeView {
  const css = getComputedStyle(host);
  const cssColor = (v: string) => css.getPropertyValue(v).trim() || "#888";
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.01, 1000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a90, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 7, 5);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-5, 2, -3);
  scene.add(fill);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: cssColor("--line-soft"), transparent: true, opacity: 0.8 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  type Shown = { key: string; mesh: THREE.Mesh; from: number };
  let shown: Shown[] = [];
  let selected: number | null = null;
  let frame = 0;
  let fitted = "";

  const draw = () => {
    frame = 0;
    const now = performance.now();
    let moving = controls.update();
    for (const s of shown) {
      const t = s.from <= now ? Math.min(1, (now - s.from) / 420) : 0;
      const k = Math.max(0.0001, ease(t));
      s.mesh.scale.setScalar(k);
      s.mesh.visible = t > 0;
      if (t < 1) moving = true;
    }
    renderer.render(scene, camera);
    if (moving) frame = requestAnimationFrame(draw);
  };
  const wake = () => { if (!frame) frame = requestAnimationFrame(draw); };
  controls.addEventListener("change", wake);

  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    wake();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  /** frame the whole model from a three-quarter view, once its extent is known */
  const fit = (parts: Part[]) => {
    const box = new THREE.Box3();
    for (const s of shown) { s.mesh.updateMatrixWorld(); box.expandByObject(s.mesh, true); }
    if (box.isEmpty()) return;
    const sig = parts.map(key).join("|");
    if (sig === fitted) return;
    fitted = sig;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(0.05, sphere.radius);
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 0.95;
    controls.target.copy(sphere.center);
    camera.position.set(sphere.center.x + dist * 0.62, sphere.center.y + dist * 0.42, sphere.center.z + dist * 0.66);
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    // a soft floor just wider than the model's footprint
    ground.scale.setScalar(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 0.62 + r * 0.08);
    ground.position.set(sphere.center.x, box.min.y - 0.001, sphere.center.z);
    controls.minDistance = r * 0.8;
    controls.maxDistance = dist * 4;
  };

  const material = (p: Part) => {
    if (p.look in LOOKS) {
      const l = LOOKS[p.look as Material];
      return new THREE.MeshStandardMaterial({ color: l.color, metalness: l.metal, roughness: l.rough,
        ...(l.opacity ? { transparent: true, opacity: l.opacity } : {}) });
    }
    return new THREE.MeshStandardMaterial({ color: cssColor(TONE_VAR[p.look as Tone]), metalness: 0.05, roughness: 0.5 });
  };

  const highlight = () => {
    shown.forEach((s, i) => {
      const m = s.mesh.material as THREE.MeshStandardMaterial;
      m.emissive.set(i === selected ? cssColor("--accent") : "#000000");
      m.emissiveIntensity = i === selected ? 0.35 : 0;
    });
    wake();
  };

  // a click (not a drag) picks the part under the pointer
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return void (down = null);
    down = null;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects(shown.filter((s) => s.mesh.visible).map((s) => s.mesh))[0];
    const i = hit ? shown.findIndex((s) => s.mesh === hit.object) : -1;
    selected = i >= 0 ? i : null;
    highlight();
    opts.onPick(selected, selected === null ? undefined : { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    renderer.domElement.style.cursor = ray.intersectObjects(shown.map((s) => s.mesh))[0] ? "pointer" : "grab";
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);

  return {
    set(parts, delays) {
      const now = performance.now();
      const next: Shown[] = parts.map((p, i) => {
        const old = shown[i];
        if (old && old.key === key(p)) return old;
        if (old) { scene.remove(old.mesh); old.mesh.geometry.dispose(); (old.mesh.material as THREE.Material).dispose(); }
        const mesh = new THREE.Mesh(geometry(p), material(p));
        mesh.position.set(...p.at);
        mesh.rotation.set(...(p.rot.map((d) => (d * Math.PI) / 180) as [number, number, number]));
        mesh.userData.label = p.label;
        scene.add(mesh);
        // a part replaced in place is just there; a new one grows in at its moment
        const from = old || !delays ? now - 1000 : now + (delays[i] ?? 0);
        return { key: key(p), mesh, from };
      });
      for (const s of shown.slice(parts.length)) { scene.remove(s.mesh); s.mesh.geometry.dispose(); (s.mesh.material as THREE.Material).dispose(); }
      shown = next;
      // measure at full size, then let draw() scale them in
      for (const s of shown) s.mesh.scale.setScalar(1);
      fit(parts);
      highlight();
      resize();
    },
    select(i) { selected = i; highlight(); },
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      for (const s of shown) { s.mesh.geometry.dispose(); (s.mesh.material as THREE.Material).dispose(); }
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}
