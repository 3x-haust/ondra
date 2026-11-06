#!/usr/bin/env python3
"""Find what makes a report hard to read or sound machine-written.

    python3 check-writing.py report.html        # exit 1 while anything must change

Mechanical checks only (see writing/README.md for the rest). Prints each hit
with the text it was found in. [must] hits have to go; [fix] hits are fine
once or twice but not as a habit.
"""
import html, re, sys
from collections import Counter

path = sys.argv[1]
raw = open(path, encoding="utf-8").read()
raw = re.sub(r"<(style|script|svg)\b.*?</\1>", " ", raw, flags=re.S | re.I)
raw = re.sub(r"<!--.*?-->", " ", raw, flags=re.S)
# placeholders left from the template
left = re.findall(r"\{\{[^}]*\}\}", raw)

def text(s):
    s = re.sub(r"<sup>.*?</sup>", "", s, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()

cells = [text(c) for c in re.findall(r"<td\b[^>]*>(.*?)</td>", raw, flags=re.S | re.I)]
blocks = [text(b) for b in re.findall(r"<(?:p|li|figcaption|h1|h2|h3)\b[^>]*>(.*?)</(?:p|li|figcaption|h1|h2|h3)>", raw, flags=re.S | re.I)]
blocks = [b for b in blocks if b]
sentences = [s.strip() for b in blocks for s in re.split(r"(?<=[.!?다요])\s+(?=\S)", b) if len(s.strip()) > 1]
bold = len(re.findall(r"<(strong|b)\b", raw, flags=re.I))

hits = []
def hit(level, rule, where=""):
    hits.append((level, rule, where[:140]))

if left:
    hit("must", f"template placeholders left: {', '.join(sorted(set(left))[:5])}")

# length
for s in sentences:
    n = len(s)
    if n > 110:
        hit("must", f"sentence of {n} characters: split it", s)
    elif n > 80:
        hit("fix", f"long sentence ({n}): one idea per sentence", s)
for c in cells:
    if len(c) > 45:
        hit("must", f"table cell of {len(c)} characters: tables hold short facts", c)
    elif len(c) > 28:
        hit("fix", f"wordy table cell ({len(c)})", c)

# Korean tells (im-not-ai quick rules, the ones a pattern can see)
KO = [
    ("must", r"에\s*있어(서)?\b", "'~에 있어(서)' → '~에서'"),
    ("must", r"되어\s*지|되어진|지게\s*된", "double passive → active"),
    ("must", r"가지고\s*있", "'가지고 있다' → plain verb ('경쟁력이 강해요')"),
    ("must", r"시사하는\s*바|시사점을\s*(준|제공)|주목할\s*만", "AI phrase: say the point"),
    ("must", r"결론적으로|요약하자면|종합하면|정리하자면", "summary opener: just say it"),
    ("must", r"단순한?\s*\S+(을|를)?\s*넘어", "'단순한 X를 넘어 Y' → say Y"),
    ("must", r"중요한\s*역할을\s*(한|합|해)|핵심적인\s*역할", "'중요한 역할' → what it does"),
    ("must", r"—|(?<!\d)–|–(?!\d)|\s--\s", "dash → period, comma or colon (number ranges like 13–29 are fine)"),
    ("must", r"할\s*수\s*있을\s*것으로|것으로\s*(보여|보입|판단|예상)되", "stacked hedge: one or none"),
    ("fix", r"에\s*의해|에\s*의한", "'~에 의해' → the doer as subject"),
    ("fix", r"(을|를)\s*통해|(을|를)\s*통하여", "'~를 통해' → '~로'"),
    ("fix", r"에\s*기반(하여|한|해)|(을|를)\s*바탕으로", "'~에 기반한' → '~로', '~을 보고'"),
    ("fix", r"와\s*관련(하여|된|해)|과\s*관련(하여|된|해)", "'~와 관련된' → '~의', '~에'"),
    ("fix", r"에서의|으로의|에로의|으로부터의", "double particle → reword"),
    ("fix", r"다양한|효과적(인|으로)|체계적(인|으로)|전반적(인|으로)", "vague adjective: say which / how"),
    ("fix", r"것(이|입니|이에|이다)", "'~것이다' ending: say it directly"),
]
for level, pat, rule in KO:
    for s in sentences + cells:
        if re.search(pat, s):
            hit(level, rule, s)

# disclaimers tacked on everywhere
neg = [s for s in sentences if re.search(r"(아닙니다|아니에요|아니다)[.]?$", s) and re.search(r"(뜻하지|의미하지|입증한|검증한|결과가)", s)]
if len(neg) > 1:
    for s in neg:
        hit("must", "disclaimer sentence: move it to '확실하지 않은 것' once", s)

# hedges
hedge = [s for s in sentences if re.search(r"(수\s*있|수도\s*있|가능성이|것\s*같)", s)]
if len(hedge) > max(4, len(sentences) // 6):
    hit("fix", f"{len(hedge)} hedged sentences: say what you know plainly", hedge[0])

# repeated openers
openers = Counter(re.split(r"[\s,]", s, maxsplit=1)[0] for s in sentences)
for w, n in openers.items():
    if n >= 4 and w in {"또한", "따라서", "즉", "나아가", "이에", "특히", "이는", "이를", "그러나", "하지만", "한편"}:
        hit("must" if n >= 6 else "fix", f"{n} sentences start with '{w}'", "")

# English in parentheses again and again
paren = Counter(re.findall(r"\(([A-Za-z][A-Za-z .\-]{2,})\)", " ".join(blocks)))
for w, n in paren.items():
    if n > 1:
        hit("fix", f"'({w})' repeated {n} times: once is enough", "")

if bold > max(6, len(blocks) // 4):
    hit("fix", f"{bold} bold spans: bold only what the reader must not miss", "")

must = [h for h in hits if h[0] == "must"]
fix = [h for h in hits if h[0] == "fix"]
seen = set()
for level, rule, where in must + fix:
    key = (rule, where)
    if key in seen:
        continue
    seen.add(key)
    print(f"[{level}] {rule}" + (f"\n        {where}" if where else ""))
print(f"\n{len(sentences)} sentences · {len(must)} must · {len(fix)} fix")
# done when nothing must change and the habits are rare
sys.exit(1 if must or len(fix) > max(6, len(sentences) // 8) else 0)
