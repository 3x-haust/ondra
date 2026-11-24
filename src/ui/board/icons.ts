// Pictures of things for boards: lucide's icons (the ones the app's own buttons use),
// loaded in one piece the first time a board draws one. Each is a list of SVG elements
// on a 24 × 24 grid, drawn with a stroke.

export type IconNode = [string, Record<string, string>][];

let all: Promise<Record<string, IconNode>> | undefined;
let ready: Record<string, IconNode> | undefined;

/** every lucide icon by name ("server", "file-text"), loaded once */
export function loadIcons(): Promise<Record<string, IconNode>> {
  all ??= import("./iconSet").then((m) => (ready = m.ICONS));
  return all;
}

/** an icon's elements once they have loaded; undefined before that or for an unknown name */
export function iconNode(name: string): IconNode | undefined {
  return ready?.[name] ?? ready?.[ALIAS[name] ?? ""];
}
export const iconsReady = () => !!ready;

/** names a model reaches for that lucide spells differently */
const ALIAS: Record<string, string> = {
  computer: "monitor",
  desktop: "monitor",
  phone: "smartphone",
  mobile: "smartphone",
  db: "database",
  person: "user",
  people: "users",
  document: "file-text",
  doc: "file-text",
  file: "file",
  envelope: "mail",
  email: "mail",
  money: "banknote",
  coin: "coins",
  gear: "settings",
  cog: "settings",
  router: "router",
  internet: "globe",
  web: "globe",
  browser: "app-window",
  robot: "bot",
  ai: "bot",
  brain: "brain",
  chip: "cpu",
  processor: "cpu",
  memory: "memory-stick",
  ram: "memory-stick",
  disk: "hard-drive",
  storage: "hard-drive",
  queue: "list-ordered",
  cache: "zap",
  warning: "triangle-alert",
  error: "circle-x",
  check: "circle-check",
  ok: "circle-check",
  time: "clock",
  timer: "timer",
  home: "house",
  building: "building",
  company: "building",
  car: "car",
  truck: "truck",
  package: "package",
  box: "package",
  cart: "shopping-cart",
  store: "store",
  shop: "store",
  bank: "landmark",
  card: "credit-card",
  wallet: "wallet",
  chart: "chart-column",
  graph: "chart-line",
  search: "search",
  camera: "camera",
  image: "image",
  photo: "image",
  video: "video",
  music: "disc",
  sun: "sun",
  moon: "moon",
  water: "droplet",
  fire: "flame",
  tree: "tree-pine",
  plant: "sprout",
  battery: "battery",
  power: "plug",
  wifi: "wifi",
  signal: "signal",
  satellite: "satellite",
  rocket: "rocket",
  terminal: "square-terminal",
  code: "code",
  api: "webhook",
  container: "container",
  docker: "container",
  key: "key-round",
  password: "key-round",
  lock: "lock",
  unlock: "lock-open",
  shield: "shield",
  token: "ticket",
  ticket: "ticket",
};
