#!/usr/bin/env python3
"""Check the research before (and after) writing: notes, quotes, claims, report.

    python3 check-research.py "$R"            # notes + quotes + claims (+ report.html if there)
    python3 check-research.py "$R" --offline  # don't fetch pages missing a snapshot
    python3 check-research.py "$R" --score    # the eval scorecard (also writes $R/eval.json)

Reads $R/notes.jsonl and $R/notes-*.jsonl, the page snapshots web.py saved
($R/sources/index.jsonl), and $R/report.html. Writes $R/claims.json: one entry
per claim id with its status, which decides how the report may state it:

  verified      quote found on the page, and a primary source or 2+ independent
                organisations say it                    → state it plainly
  single        one secondary source only                → tag 확인 안 됨
  conflict      sources give different numbers           → both sides, 출처 엇갈림
  quote-missing the quote isn't on the page              → fix the note first

[error] lines are about facts being real (a quote that isn't on its page, a
number missing from its quote, an empty field, a citation or link with no
source behind it): exit 1 while any is left. [warn] lines are about format or
process (date format, tags, a counter-search, the --score targets): worth a
look, they don't block. Python 3 stdlib only.
The claim rules (independence by organisation, verbatim quotes checked against
a saved copy, a counter-search for high-risk claims) follow insane-research
(MIT, fivetaku); the code is our own.
"""
import html, json, os, re, subprocess, sys, unicodedata
from glob import glob
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # no __pycache__ inside the app's skill folder
import web  # noqa: E402  (same folder: snapshots and the fetch chain)

DATE = re.compile(r"^\d{4}(-\d{2}(-\d{2})?)?$")
SECOND = {"co.kr", "go.kr", "or.kr", "ac.kr", "re.kr", "ne.kr", "co.uk", "ac.uk", "gov.uk", "org.uk", "co.jp", "or.jp",
          "ne.jp", "go.jp", "ac.jp", "com.au", "org.au", "com.cn", "com.br", "com.tw", "com.sg", "co.in"}
HOSTED = {"github.io", "gitlab.io", "readthedocs.io", "netlify.app", "vercel.app", "pages.dev", "web.app",
          "blogspot.com", "wordpress.com", "substack.com", "tistory.com", "notion.site", "hashnode.dev"}
BY_PATH = {"github.com", "gitlab.com", "huggingface.co", "medium.com", "x.com", "twitter.com", "youtube.com", "blog.naver.com"}


def org(url):
    """Independence is counted per organisation, not per host: docs.x.com and blog.x.com are one."""
    if url.startswith("file://"):
        return "run"
    s = urlsplit(url)
    host = (s.hostname or "").removeprefix("www.").removeprefix("m.")
    if host in BY_PATH:
        seg = s.path.strip("/").split("/")[0]
        return f"{host}/{seg.lower()}" if seg else host
    parts = host.split(".")
    if len(parts) > 2 and (".".join(parts[-2:]) in SECOND or ".".join(parts[-2:]) in HOSTED):
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


QMAP = str.maketrans({"“": '"', "”": '"', "‘": "'", "’": "'", " ": " ", "‐": "-", "‑": "-",
                      "‒": "-", "–": "-", "—": "-", "−": "-", "*": None, "`": None, "#": None})


def norm(s):
    s = unicodedata.normalize("NFKC", html.unescape(s or ""))
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s).translate(QMAP)
    return re.sub(r"\s+", " ", s).strip().lower()


def quote_on_page(quote, page):
    """Verbatim after normalising spaces, quotes and markdown; '…' may skip text between parts."""
    parts = [p for p in (norm(x) for x in re.split(r"…|\.\.\.", quote)) if len(p) >= 6]
    at = 0
    for p in parts:
        i = page.find(p, at)
        if i < 0:
            return False
        at = i + len(p)
    return bool(parts)


def numbers(s):
    s = unicodedata.normalize("NFKC", s or "")
    return {n.replace(",", "").lstrip("0") or "0" for n in re.findall(r"\d[\d,]*(?:\.\d+)?", s)}


def load_notes(r):
    notes, bad, seen = [], [], set()
    for path in sorted(glob(os.path.join(r, "notes.jsonl")) + glob(os.path.join(r, "notes-*.jsonl"))):
        for i, line in enumerate(open(path, encoding="utf-8"), 1):
            line = line.strip()
            if not line or line in seen:
                continue
            seen.add(line)
            try:
                n = json.loads(line)
            except ValueError as e:
                bad.append(f"{os.path.basename(path)}:{i} is not JSON ({e})")
                continue
            n["_at"] = f"{os.path.basename(path)}:{i}"
            notes.append(n)
    return notes, bad


def load_snapshots(r):
    snaps = {}
    for line in open(os.path.join(r, "sources", "index.jsonl"), encoding="utf-8") if os.path.exists(os.path.join(r, "sources", "index.jsonl")) else []:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        snaps[web.norm_url(rec["url"])] = rec
    return snaps


def page_of(r, rec, cache={}):
    p = os.path.join(r, rec["file"])
    if p not in cache:
        cache[p] = norm(open(p, encoding="utf-8", errors="replace").read()) if os.path.exists(p) else ""
    return cache[p]


def snapshot(r, url, snaps, offline):
    if url.startswith("file://"):  # the output of a test this job ran
        path = url[7:]
        return {"file": path, "via": "run"} if os.path.isfile(path) else None
    key = web.norm_url(url)
    if key in snaps or offline:
        return snaps.get(key)
    log = []
    via, res = web.fetch(url, ["route", "direct", "jsonld", "mobile", "reader"], log)
    if not via:
        return None
    snaps[key] = web.save(r, url, via, res, log)
    return snaps[key]


def published_part(item):
    """A source line without the day it was read: only the page's own date counts."""
    return re.sub(r"읽은 날\s*\d{4}-\d{2}-\d{2}", "", re.sub(r"<[^>]+>", " ", item))


def report_parts(path):
    raw = open(path, encoding="utf-8").read()
    raw_nc = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    urls = set(u for u in re.findall(r'href="(https?://[^"]+)"', raw_nc) if "{{" not in u)
    src = re.search(r'<ol class="sources">(.*?)</ol>', raw_nc, re.S)
    items = re.findall(r'<li id="(s\d+)"[^>]*>(.*?)</li>', src.group(1), re.S) if src else []
    cites = set(re.findall(r'href="#(s\d+)"', raw_nc))
    gaps = re.search(r"<h2>확실하지 않은 것</h2>\s*<ul[^>]*>(.*?)</ul>", raw_nc, re.S)
    text = re.sub(r"<[^>]+>", " ", raw_nc)
    return {"urls": urls, "items": items, "cites": cites, "gaps": len(re.findall(r"<li\b", gaps.group(1))) if gaps else 0, "text": text}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    r, offline, score = args[0], "--offline" in sys.argv, "--score" in sys.argv
    hits = []
    hit = lambda level, msg: hits.append((level, msg))

    notes, bad = load_notes(r)
    for b in bad:
        hit("error", b)
    if not notes:
        hit("error", f"no notes in {r}/notes*.jsonl")
    snaps = load_snapshots(r)

    claims = {}
    for i, n in enumerate(notes):
        where = n["_at"]
        url = n.get("url", "")
        for f in ("claim", "url", "quote", "published", "source"):
            if not n.get(f):
                hit("error", f"{where}: '{f}' is empty")
        if url and not re.match(r"https?://|file://", url):
            hit("error", f"{where}: url is not http(s) or file://: {url[:80]}")
        pub = str(n.get("published") or "")
        if pub and pub != "unknown" and not DATE.match(pub):
            hit("warn", f"{where}: published '{pub}': YYYY-MM-DD, or 'unknown' when the page has no date")
        if n.get("source") not in ("primary", "secondary", None, ""):
            hit("warn", f"{where}: source is '{n.get('source')}', expected primary or secondary (counted as secondary)")
        q = n.get("quote") or ""
        if len(q) > 320:
            hit("warn", f"{where}: quote of {len(q)} characters: the passage that carries the claim is usually enough")
        n["_quote"] = "unchecked"
        rec = snapshot(r, url, snaps, offline) if re.match(r"https?://|file://", url) else None
        if rec and q:
            n["_quote"] = "ok" if quote_on_page(q, page_of(r, rec)) else "missing"
            if n["_quote"] == "missing":
                hit("error", f"{where}: quote not on the page ({url[:70]}): copy it verbatim from the page, in its language, or drop the note\n        \"{q[:90]}\"")
            n["_via"] = rec.get("via")
            if not pub or pub == "unknown":
                if rec.get("published"):
                    hit("warn", f"{where}: the page says it was published {rec['published']}: put it in 'published'")
        elif q:
            hit("warn", f"{where}: no snapshot of {url[:70]} to check the quote (web.py fetch it)")
        cn = numbers(n.get("claim"))
        if cn and n["_quote"] == "ok" and not (cn & numbers(q)) and not (cn & numbers(n.get("title"))):
            hit("error" if n.get("risk") == "high" else "warn", f"{where}: the claim's numbers {sorted(cn)[:4]} aren't in the quote: quote the passage with the number")
        cid = str(n.get("id") or f"{where}")
        claims.setdefault(cid, []).append(n)

    out = {}
    for cid, everyone in claims.items():
        group = [n for n in everyone if n["_quote"] != "missing"] or everyone
        orgs = {org(n["url"]) for n in group if n.get("url")}
        primary = any(n.get("source") == "primary" and n["_quote"] != "missing" for n in group)
        sets = [numbers(n.get("claim")) for n in group]
        clash = any(a and b and not (a & b) for i, a in enumerate(sets) for b in sets[i + 1:])
        high = any(n.get("risk") == "high" for n in group)
        if high and not any(n.get("counter") for n in group):
            hit("warn", f"claim '{cid}' is high-risk and has no 'counter': worth one search for evidence against it")
        if all(n["_quote"] == "missing" for n in everyone):
            status = "quote-missing"
        elif clash or any(n.get("conflict") for n in group):
            status = "conflict"
        elif primary or len(orgs) >= 2:
            status = "verified"
        else:
            status = "single"
        out[cid] = {"status": status, "claim": group[0].get("claim"), "orgs": sorted(orgs), "primary": primary,
                    "urls": sorted({n.get("url") for n in group}), "high": high,
                    "quotes": {n.get("url"): n["_quote"] for n in everyone}}
    with open(os.path.join(r, "claims.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    rep = os.path.join(r, "report.html")
    parts = report_parts(rep) if os.path.exists(rep) else None
    note_urls = {web.norm_url(n["url"]) for n in notes if n.get("url", "").startswith("http")}
    conflicts = [c for c, v in out.items() if v["status"] == "conflict"]
    singles = [c for c, v in out.items() if v["status"] == "single"]
    if parts:
        for u in sorted(parts["urls"]):
            if web.norm_url(u) not in note_urls:
                hit("error", f"report links a page with no note: {u[:90]}")
        ids = {i for i, _ in parts["items"]}
        for c in sorted(parts["cites"] - ids):
            hit("error", f"report cites #{c}, which is not in 출처")
        for i, body in parts["items"]:
            if not re.search(r"\d{4}-\d{2}(-\d{2})?|날짜 없음", published_part(body)):
                hit("warn", f"출처 {i}: no published date (YYYY-MM-DD, or '날짜 없음')")
        if conflicts and "출처 엇갈림" not in parts["text"]:
            hit("warn", f"{len(conflicts)} claims conflict ({', '.join(conflicts[:3])}) and the report never says 출처 엇갈림: if they're in it, show both sides with dates")
        if (conflicts or singles) and not parts["gaps"]:
            hit("warn", "'확실하지 않은 것' is empty, but some claims are unverified or conflict: if the report uses them, say so there")

    counts = {s: sum(v["status"] == s for v in out.values()) for s in ("verified", "single", "conflict", "quote-missing")}
    errors = [h for h in hits if h[0] == "error"]
    warns = [h for h in hits if h[0] == "warn"]
    for level, msg in errors + warns:
        print(f"[{level}] {msg}")
    print(f"\n{len(notes)} notes · {len(out)} claims: " + ", ".join(f"{v} {k}" for k, v in counts.items())
          + f" · {len(errors)} errors · {len(warns)} warnings")

    if score:
        print_score(r, notes, out, parts, conflicts, errors)
    sys.exit(1 if errors else 0)


def print_score(r, notes, out, parts, conflicts, errors):
    index = os.path.join(r, "sources", "index.jsonl")
    recs = [json.loads(l) for l in open(index, encoding="utf-8")] if os.path.exists(index) else []
    failed = os.path.join(r, "sources", "failed.jsonl")
    fails = sum(1 for _ in open(failed, encoding="utf-8")) if os.path.exists(failed) else 0
    rescued = [x for x in recs if x.get("via") != "direct"]  # pages plain HTTP would not have given
    cited = [u for u in (parts["urls"] if parts else set())]
    by_url = {}
    for n in notes:
        by_url.setdefault(web.norm_url(n.get("url", "")), []).append(n)
    primary = sum(any(n.get("source") == "primary" for n in by_url.get(web.norm_url(u), [])) for u in cited)
    dated = sum(bool(re.search(r"\d{4}-\d{2}", published_part(b))) for _, b in (parts["items"] if parts else []))
    checked = [n for n in notes if n["_quote"] != "unchecked"]
    # check-writing.py only fails on template placeholders left in the report
    writing = subprocess.run([sys.executable, os.path.join(HERE, "check-writing.py"), os.path.join(r, "report.html")],
                             capture_output=True).returncode == 0 if parts else False
    m = {
        "sources_cited": len(cited),
        "primary_share": round(primary / len(cited), 2) if cited else 0,
        "dated_share": round(dated / len(parts["items"]), 2) if parts and parts["items"] else 0,
        "quote_match": round(sum(n["_quote"] == "ok" for n in checked) / len(checked), 2) if checked else 0,
        "verified_share": round(sum(v["status"] == "verified" for v in out.values()) / len(out), 2) if out else 0,
        "conflicts": len(conflicts),
        "conflicts_surfaced": (not conflicts) or bool(parts and "출처 엇갈림" in parts["text"]),
        "rescued_reads": len(rescued),
        "rescued_via": {v: sum(x["via"] == v for x in rescued) for v in sorted({x["via"] for x in rescued})},
        "unread_pages": fails,
        "no_placeholders": writing,
        "errors_left": len(errors),
    }
    # pass = the facts hold up; the rest are targets worth a look, not gates
    gates = {"errors_left": m["errors_left"] == 0, "report": bool(parts), "no_placeholders": writing}
    targets = {"primary_share": m["primary_share"] >= 0.5, "dated_share": m["dated_share"] >= 0.7,
               "quote_match": m["quote_match"] >= 0.9, "conflicts_surfaced": m["conflicts_surfaced"]}
    m["pass"] = all(gates.values())
    m["failed"] = [k for k, ok in gates.items() if not ok]
    m["below_target"] = [k for k, ok in targets.items() if not ok]
    with open(os.path.join(r, "eval.json"), "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
    print("\nscore")
    for k, v in m.items():
        print(f"  {k:20} {v}")


if __name__ == "__main__":
    main()
