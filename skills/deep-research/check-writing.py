#!/usr/bin/env python3
"""Point out what may make a report hard to read or sound machine-written.

    python3 check-writing.py report.html

Prints hints with the text they were found in. They are suggestions, not
rules: read them and change what helps the reader. Exits 0, except when
template placeholders ({{…}}) are left in the file (exit 1): that is a real
error, the reader would see them.
"""
import html, re, sys
from collections import Counter

path = sys.argv[1]
raw = open(path, encoding="utf-8").read()
raw = re.sub(r"<(style|script|svg)\b.*?</\1>", " ", raw, flags=re.S | re.I)
raw = re.sub(r"<!--.*?-->", " ", raw, flags=re.S)
left = re.findall(r"\{\{[^}]*\}\}", raw)


def text(s):
    s = re.sub(r"<sup>.*?</sup>", "", s, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()


cells = [text(c) for c in re.findall(r"<td\b[^>]*>(.*?)</td>", raw, flags=re.S | re.I)]
blocks = [text(b) for b in re.findall(r"<(?:p|li|figcaption|h1|h2|h3)\b[^>]*>(.*?)</(?:p|li|figcaption|h1|h2|h3)>", raw, flags=re.S | re.I)]
blocks = [b for b in blocks if b]
sentences = [s.strip() for b in blocks for s in re.split(r"(?<=[.!?다요])\s+(?=\S)", b) if len(s.strip()) > 1]
bold = len(re.findall(r"<(strong|b)\b", raw, flags=re.I))

hints = []
def hint(msg, where=""):
    if (msg, where[:140]) not in hints:
        hints.append((msg, where[:140]))

# length: long sentences and wordy cells are often harder to read
for s in sentences:
    if len(s) > 80:
        hint(f"long sentence ({len(s)} characters): two sentences may read easier", s)
for c in cells:
    if len(c) > 28:
        hint(f"wordy table cell ({len(c)}): maybe a sentence or a picture instead", c)

# Korean phrasings that often read as translated or machine-written (from im-not-ai)
KO = [
    (r"에\s*있어(서)?\b", "'~에 있어(서)' often reads better as '~에서'"),
    (r"되어\s*지|되어진|지게\s*된", "double passive: an active verb may be clearer"),
    (r"가지고\s*있", "'가지고 있다' often reads better as a plain verb ('경쟁력이 강해요')"),
    (r"시사하는\s*바|시사점을\s*(준|제공)|주목할\s*만", "a stock phrase: saying the point itself may be stronger"),
    (r"결론적으로|요약하자면|종합하면|정리하자면", "a summary opener: the point can usually stand alone"),
    (r"단순한?\s*\S+(을|를)?\s*넘어", "'단순한 X를 넘어 Y': saying Y directly is often enough"),
    (r"중요한\s*역할을\s*(한|합|해)|핵심적인\s*역할", "'중요한 역할': what it actually does may say more"),
    (r"할\s*수\s*있을\s*것으로|것으로\s*(보여|보입|판단|예상)되", "stacked hedge: one is usually enough"),
    (r"에\s*의해|에\s*의한", "'~에 의해': the doer as subject may be clearer"),
    (r"(을|를)\s*통해|(을|를)\s*통하여", "'~를 통해': '~로' is often enough"),
    (r"에\s*기반(하여|한|해)|(을|를)\s*바탕으로", "'~에 기반한': '~로' or '~을 보고' may be plainer"),
    (r"와\s*관련(하여|된|해)|과\s*관련(하여|된|해)", "'~와 관련된': '~의' or '~에' may be plainer"),
    (r"에서의|으로의|에로의|으로부터의", "double particle: maybe reword"),
    (r"다양한|효과적(인|으로)|체계적(인|으로)|전반적(인|으로)", "vague adjective: which or how?"),
]
for pat, msg in KO:
    for s in sentences + cells:
        if re.search(pat, s):
            hint(msg, s)

# dashes: fine if the user's own writing uses them; a page full of them reads machine-made
dashes = [s for s in sentences if re.search(r"—|(?<!\d)–|–(?!\d)|\s--\s", s)]
if len(dashes) > 2:
    hint(f"{len(dashes)} sentences with dashes: a period, comma or colon often reads more natural", dashes[0])

# the same disclaimer after many paragraphs
neg = [s for s in sentences if re.search(r"(아닙니다|아니에요|아니다)[.]?$", s) and re.search(r"(뜻하지|의미하지|입증한|검증한|결과가)", s)]
if len(neg) > 1:
    hint(f"{len(neg)} disclaimer sentences: once, under '확실하지 않은 것', may be enough", neg[0])

hedge = [s for s in sentences if re.search(r"(수\s*있|수도\s*있|가능성이|것\s*같)", s)]
if len(hedge) > max(4, len(sentences) // 6):
    hint(f"{len(hedge)} hedged sentences: what you know can be said plainly", hedge[0])

openers = Counter(re.split(r"[\s,]", s, maxsplit=1)[0] for s in sentences)
for w, n in openers.items():
    if n >= 4 and w in {"또한", "따라서", "즉", "나아가", "이에", "특히", "이는", "이를", "그러나", "하지만", "한편"}:
        hint(f"{n} sentences start with '{w}'")

paren = Counter(re.findall(r"\(([A-Za-z][A-Za-z .\-]{2,})\)", " ".join(blocks)))
for w, n in paren.items():
    if n > 1:
        hint(f"'({w})' appears {n} times: once is usually enough")

if bold > max(6, len(blocks) // 4):
    hint(f"{bold} bold spans: bold works best on the few things the reader must not miss")

if left:
    print(f"[error] template placeholders left: {', '.join(sorted(set(left))[:5])}")
# one line per passage, with every hint about it under it
by = {}
for msg, where in hints:
    by.setdefault(where, []).append(msg)
for where, msgs in by.items():
    if where:
        print(f"[hint] {where}")
        for m in msgs:
            print(f"        - {m}")
    else:
        for m in msgs:
            print(f"[hint] {m}")
print(f"\n{len(sentences)} sentences · {len(hints)} hints" + (" · placeholders left" if left else ""))
sys.exit(1 if left else 0)
