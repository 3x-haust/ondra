// Seeded samples for the gallery examples only (the same picture on every load).
// Agents are told to chart only data they really have.
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function rnorm(n: number, mu: number, sd: number, seed: number, digits = 1): number[] {
  const r = rng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = Math.max(1e-9, r()), v = r();
    out.push(+(mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)).toFixed(digits));
  }
  return out;
}
/** right-skewed (log-normal) values, e.g. latencies */
export const rlognorm = (n: number, mu: number, sd: number, seed: number, digits = 0) => rnorm(n, mu, sd, seed, 6).map((v) => +Math.exp(v).toFixed(digits));
