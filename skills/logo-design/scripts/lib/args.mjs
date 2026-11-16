// Tiny argv parser: positionals in `_`, `--key value` pairs, and the listed boolean flags.
export function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (booleans.includes(k)) out[k] = true;
    else out[k] = argv[++i];
  }
  return out;
}
