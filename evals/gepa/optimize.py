#!/usr/bin/env python3
"""GEPA (arXiv 2507.19457, github.com/gepa-ai/gepa) on main's system prompt (CAPTAIN_SYSTEM).

The prompt is cut into parts (its "# " sections, and in the long Role section each route
bullet), and each part is a component GEPA evolves on its own: a reflection reads the cases
main got wrong, in words (which check failed, what main did, what the case expected), and
proposes small edits to one part. Candidates are kept on a Pareto front over the validation
cases, and merge combines parts that improved in different lines of descent.

Scoring is evals/main-sim: main decides with the real model in a made-up situation (nothing is
started) and every step gets the case's checks and the shared lint. Everything that touches the
app goes through evals/gepa/bridge.mjs (the dev bridge), so this file reads no credential.

    # free: no app, no model; proves the loop end to end
    evals/gepa/run.sh --mock --name dry
    # real: the dev app from this branch running (`pnpm tauri dev`)
    evals/gepa/run.sh --name main-1 --max-calls 120 --max-usd 10

See evals/gepa/README.md.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from gepa import optimize
from gepa.core.adapter import EvaluationBatch

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "bridge.mjs"
RUNS = Path(os.environ.get("GEPA_RUNS", "/Users/lyu/Work/cache/gepa-runs"))
CHARS_PER_TOKEN = 3.2  # main's prompt is English with Korean examples


def bridge(op: str, payload: dict[str, Any] | None = None, mock: bool = False) -> Any:
    env = {**os.environ, **({"GEPA_MOCK": "1"} if mock else {})}
    p = subprocess.run(["node", str(BRIDGE), op], input=json.dumps(payload or {}), capture_output=True, text=True, env=env, timeout=900)
    out = json.loads(p.stdout or "{}")
    if p.returncode != 0 or (isinstance(out, dict) and "error" in out and len(out) == 1):
        raise RuntimeError(f"bridge {op}: {out.get('error') if isinstance(out, dict) else p.stderr[-500:]}")
    return out


# ── the prompt in parts ──────────────────────────────────────────────────────────────────────


def split_prompt(text: str) -> list[tuple[str, str]]:
    """Ordered (name, text) parts whose texts joined give the prompt back exactly."""
    sections = re.split(r"(?m)^(?=# )", text)
    parts: list[tuple[str, str]] = []
    for sec in sections:
        if not sec:
            continue
        head = sec.split("\n", 1)[0].lstrip("# ").strip()
        key = re.sub(r"[^a-z0-9]+", "-", head.lower()).strip("-")[:24] or "part"
        # a long section is cut before each top-level route bullet (- "answer": …)
        pieces = re.split(r'(?m)^(?=- "[a-z]+")', sec) if len(sec) > 6000 else [sec]
        for i, piece in enumerate(pieces):
            if not piece:
                continue
            m = re.match(r'- "([a-z]+)"', piece)
            name = f"{key}.{m.group(1)}" if m else (key if i == 0 else f"{key}.{i}")
            while name in dict(parts):
                name += "'"
            parts.append((name, piece))
    assert "".join(t for _, t in parts) == text
    return parts


def join_prompt(candidate: dict[str, str], order: list[str]) -> str:
    return "".join(candidate[k] for k in order)


# ── the adapter: evaluate with main-sim, explain failures, propose edits ────────────────────


class MainAdapter:
    def __init__(self, order: list[str], args: argparse.Namespace, seed: str):
        self.order = order
        self.seed = seed
        self.args = args
        self.mock = args.mock
        self.lock = threading.Lock()
        self.calls = 0
        self.usd = 0.0
        self.log = open(Path(args.run_dir) / "calls.jsonl", "a")

    # a rough price for what a step sends and gets back (the app does not report usage here)
    def _cost(self, chars_in: int, chars_out: int) -> float:
        a = self.args
        return (chars_in / CHARS_PER_TOKEN) * a.price_in / 1e6 + (chars_out / CHARS_PER_TOKEN) * a.price_out / 1e6

    def _sim(self, case: dict, system: str) -> dict:
        """A case run --repeats times: its score is the mean, and the worst run is the one shown to
        a reflection (one lucky or unlucky sample says little about a prompt)."""
        runs = [self._sim_once(case, system) for _ in range(max(1, self.args.repeats))]
        worst = min(runs, key=lambda r: r["score"])
        return {**worst, "score": sum(r["score"] for r in runs) / len(runs), "runs": [r["score"] for r in runs]}

    def _sim_once(self, case: dict, system: str) -> dict:
        try:
            # the prompt as it ships is the app's own: not sent (works with any dev app)
            r = bridge("sim", {"case": case, **({} if system == self.seed else {"system": system})}, self.mock)
        except Exception as e:  # one case failing to run is a failed case, not a failed run
            r = {"score": 0.0, "problems": [[f"error: {e}"]], "steps": []}
        r["score"] = float(r["score"])
        steps = r.get("steps", [])
        spent = sum(self._cost(len(system) + len(s.get("context") or "") + 2000, len(json.dumps(s.get("routes"), ensure_ascii=False)) + len(s.get("reply") or "") + 1500) for s in steps) if not self.mock else 0.0
        with self.lock:
            self.calls += 1
            self.usd += spent
            self.log.write(json.dumps({"kind": "sim", "case": case["name"], "score": r["score"], "usd": round(spent, 4)}, ensure_ascii=False) + "\n")
            self.log.flush()
        return {"case": case, **r}

    def evaluate(self, batch: list[dict], candidate: dict[str, str], capture_traces: bool = False) -> EvaluationBatch:
        system = join_prompt(candidate, self.order)
        with ThreadPoolExecutor(max_workers=self.args.parallel) as ex:
            outs = list(ex.map(lambda c: self._sim(c, system), batch))
        return EvaluationBatch(outputs=outs, scores=[float(o["score"]) for o in outs], trajectories=outs if capture_traces else None)

    def make_reflective_dataset(self, candidate: dict[str, str], eval_batch: EvaluationBatch, components_to_update: list[str]) -> dict[str, list[dict]]:
        records = []
        for o in eval_batch.trajectories or []:
            case = o["case"]
            said = []
            for k, s in enumerate(o.get("steps", [])):
                routes = json.dumps(s.get("routes"), ensure_ascii=False)[:1500]
                probs = (o.get("problems") or [[]])[k] if k < len(o.get("problems") or []) else []
                said.append({"user": s.get("text"), "main replied": s.get("reply") or "-", "main's routes": routes, "checks": "; ".join(probs) or "all passed"})
            records.append(
                {
                    "Situation": f"{case.get('note') or case['name']} (space {case.get('space')}, {len(case.get('tasks') or [])} jobs, {len(case.get('projects') or [])} projects)",
                    "Steps": said,
                    "Expected": json.dumps(case.get("expect"), ensure_ascii=False),
                    "Score": o["score"],
                    **({"Runs": f"passed {sum(1 for x in o['runs'] if x >= 1)} of {len(o['runs'])} runs; the steps shown are the worst run"} if len(o.get("runs") or []) > 1 else {}),
                }
            )
        # what went wrong first; a few that went right keep the edit from breaking them
        records.sort(key=lambda r: r["Score"])
        bad = [r for r in records if r["Score"] < 1][: self.args.reflect_examples]
        good = [r for r in records if r["Score"] >= 1][:2]
        return {c: bad + good for c in components_to_update}

    def propose_new_texts(self, candidate: dict[str, str], reflective_dataset: dict[str, list[dict]], components_to_update: list[str]) -> dict[str, str]:
        out = {}
        for comp in components_to_update:
            part = candidate[comp]
            whole = join_prompt({**candidate, comp: f"<part>\n{part}\n</part>"}, self.order)
            prompt = REFLECT.replace("{whole}", whole).replace("{name}", comp).replace("{examples}", json.dumps(reflective_dataset.get(comp, []), ensure_ascii=False, indent=1)[:24000])
            try:
                text = bridge("reflect", {"prompt": prompt}, self.mock)["text"]
            except Exception as e:
                print(f"reflect {comp}: {e}", file=sys.stderr)
                text = ""
            with self.lock:
                self.usd += 0.0 if self.mock else self._cost(len(prompt), len(text))
                self.log.write(json.dumps({"kind": "reflect", "part": comp, "chars": len(text)}, ensure_ascii=False) + "\n")
                self.log.flush()
            out[comp] = apply_edits(part, text)
        return out


REFLECT = """You improve one part of the system prompt of "main", the session that reads a user's
messages in an agent workspace and routes each (answer / ask / append to a job / stop a job / new
job / remember). Below is the whole prompt; the part you may change is between <part> and </part>
(it is called {name}).

<prompt>
{whole}
</prompt>

Here are situations main was run on with this prompt, what it did, and which checks failed
(a check's message says what was expected). Some passed; your change must keep them passing.

{examples}

Work out why main went wrong, as a general rule about such messages, not about these exact cases
(never quote a test case or its words; the prompt must stay true for every user). Then change
the part as little as you can: sharpen a rule, add a missing one, remove a misleading line. Keep
its voice, language and format. If nothing in this part is the cause, change nothing.

Answer with a JSON list of edits inside one ```json block, each {"old": "exact text that occurs
once in the part", "new": "its replacement"}; [] for no change."""


def apply_edits(part: str, text: str) -> str:
    m = re.search(r"```(?:json)?\s*\n(.*?)\n```", text, re.S)
    try:
        edits = json.loads(m.group(1) if m else text)
    except Exception:
        return part
    new = part
    for e in edits if isinstance(edits, list) else []:
        old, rep = e.get("old"), e.get("new")
        if isinstance(old, str) and isinstance(rep, str) and old and new.count(old) == 1:
            new = new.replace(old, rep)
    return new


class Budget:
    """GEPA stops when the estimated spend reaches --max-usd."""

    def __init__(self, adapter: MainAdapter, cap: float):
        self.adapter, self.cap = adapter, cap

    def __call__(self, gepa_state: Any) -> bool:
        if self.adapter.usd >= self.cap:
            print(f"budget: ~${self.adapter.usd:.2f} spent, cap ${self.cap:.2f}: stopping", file=sys.stderr)
            return True
        return False


# ── run ─────────────────────────────────────────────────────────────────────────────────────


def split_cases(cases: list[dict], val_share: float) -> tuple[list[dict], list[dict]]:
    """A fixed split by name, so a resumed run sees the same sets."""

    def h(s: str) -> int:
        v = 7
        for ch in s:
            v = (v * 31 + ord(ch)) & 0xFFFFFFFF
        return v

    val = [c for c in cases if h(c["name"]) % 100 < val_share * 100]
    train = [c for c in cases if c not in val]
    return train, val


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="run name; the same name resumes (state in $GEPA_RUNS/<name>)")
    ap.add_argument("--mock", action="store_true", help="no app, no model: fake scores and edits (free)")
    ap.add_argument("--cases", nargs="*", default=[], help="only these cases (file names or name:id)")
    ap.add_argument("--limit", type=int, default=0, help="at most this many cases (after --cases)")
    ap.add_argument("--val-share", type=float, default=0.35, help="share of cases held out for the Pareto front")
    ap.add_argument("--max-calls", type=int, default=60, help="metric calls (one case run with one prompt)")
    ap.add_argument("--max-usd", type=float, default=5.0, help="stop when the estimated spend reaches this")
    ap.add_argument("--price-in", type=float, default=3.0, help="USD per million input tokens (estimate)")
    ap.add_argument("--price-out", type=float, default=15.0, help="USD per million output tokens (estimate)")
    ap.add_argument("--minibatch", type=int, default=3, help="cases per reflection step")
    ap.add_argument("--reflect-examples", type=int, default=4, help="failed cases shown to a reflection")
    ap.add_argument("--parallel", type=int, default=3)
    ap.add_argument("--focus", nargs="*", default=[], help="cases main gets wrong: trained on (with --train-extra others) and also validated")
    ap.add_argument("--train-extra", type=int, default=6, help="with --focus: this many other cases kept in training")
    ap.add_argument("--repeats", type=int, default=1, help="run each case this many times and score the mean (each run is a metric call's worth of spend)")
    ap.add_argument("--no-merge", action="store_true")
    ap.add_argument("--seed-from-file", action="store_true", help="read the prompt from src/ instead of the app")
    ap.add_argument("--prompt-file", help="with --eval-only: score this prompt instead of the app's")
    ap.add_argument("--eval-only", action="store_true", help="score the current prompt on the cases and stop")
    args = ap.parse_args()

    run_dir = RUNS / args.name
    run_dir.mkdir(parents=True, exist_ok=True)
    args.run_dir = str(run_dir)

    cases = bridge("cases", {"names": args.cases}, True)
    if args.limit:
        cases = cases[: args.limit]
    seed_path = run_dir / "seed.md"
    if seed_path.exists():  # a resumed run starts from the same prompt it started with
        seed = seed_path.read_text()
    else:
        s = bridge("seed", {"fromFile": args.seed_from_file}, args.mock)
        seed = s["text"]
        if s.get("from") == "app" and not s.get("hook"):
            print("note: the running app has no override hook; only --eval-only works with it", file=sys.stderr)
        seed_path.write_text(seed)
    parts = split_prompt(seed)
    order = [n for n, _ in parts]
    seed_candidate = dict(parts)
    adapter = MainAdapter(order, args, seed)
    train, val = split_cases(cases, args.val_share)
    if args.focus:
        # the cases main gets wrong: reflections mostly see them (with a few others so an edit
        # doesn't break what works), and they're scored on validation too, so a fix shows
        focus = [c for c in cases if any(c["name"] == n or c["name"].startswith(f"{n}:") for n in args.focus)]
        rest = [c for c in train if c not in focus]
        step = max(1, len(rest) // max(1, args.train_extra))
        train = focus + rest[::step][: args.train_extra]
        val = [c for c in val if c not in focus] + focus
    print(f"{len(cases)} cases: {len(train)} train, {len(val)} val · prompt {len(seed)} chars in {len(order)} parts: {', '.join(order)}", file=sys.stderr)

    if args.eval_only:
        # --prompt-file: score that prompt (e.g. a run's best.md) instead of the app's own
        cand = dict(split_prompt(Path(args.prompt_file).read_text())) if args.prompt_file else seed_candidate
        adapter.order = list(cand) if args.prompt_file else order
        res = adapter.evaluate(cases, cand, capture_traces=True)
        rows = [{"case": o["case"]["name"], "score": o["score"], "runs": o.get("runs"), "problems": o.get("problems")} for o in res.outputs]
        (run_dir / "eval.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))
        print(json.dumps({"mean": sum(res.scores) / max(1, len(res.scores)), "calls": adapter.calls, "usd_est": round(adapter.usd, 3), "cases": rows}, ensure_ascii=False, indent=1))
        return

    result = optimize(
        seed_candidate=seed_candidate,
        trainset=train,
        valset=val,
        adapter=adapter,
        candidate_selection_strategy="pareto",
        module_selector="round_robin",
        reflection_minibatch_size=args.minibatch,
        use_merge=not args.no_merge,
        max_merge_invocations=5,
        max_metric_calls=args.max_calls,
        stop_callbacks=[Budget(adapter, args.max_usd)],
        run_dir=str(run_dir / "gepa"),
        display_progress_bar=False,
        raise_on_exception=False,
        seed=0,
    )

    best = join_prompt(result.best_candidate, order)
    (run_dir / "best.md").write_text(best)
    (run_dir / "best.diff").write_text("".join(difflib.unified_diff(seed.splitlines(True), best.splitlines(True), "CAPTAIN_SYSTEM (now)", "CAPTAIN_SYSTEM (best)")))
    seed_scores = result.val_subscores[0]
    best_scores = result.val_subscores[result.best_idx]
    per_case = [{"case": k if isinstance(k, str) else val[k]["name"], "seed": seed_scores.get(k), "best": best_scores.get(k)} for k in best_scores]
    summary = {
        "candidates": len(result.candidates),
        "best_idx": result.best_idx,
        "val_seed": result.val_aggregate_scores[0],
        "val_best": result.val_aggregate_scores[result.best_idx],
        "metric_calls_this_session": adapter.calls,
        "metric_calls_total": result.total_metric_calls,
        "usd_est": round(adapter.usd, 3),
        "changed_parts": [k for k in order if result.best_candidate[k] != seed_candidate[k]],
        "per_case": per_case,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "per_case"}, ensure_ascii=False, indent=1))
    print(f"best prompt: {run_dir / 'best.md'} · diff: {run_dir / 'best.diff'} · per case: {run_dir / 'summary.json'}")


if __name__ == "__main__":
    main()
