# Checking claims

Read this before step 3 of a deep run. `check-research.py` is in this
skill's folder.

## A note

One fact per line in `notes.jsonl` (subagents: `notes-<n>.jsonl`):

```json
{"q":2,"id":"q2-pro-price","claim":"Pro 플랜은 월 25달러부터예요","url":"https://supabase.com/pricing","title":"Pricing & Fees","publisher":"Supabase","published":"2026-04-21","quote":"Pro … From $25 per month","source":"primary","risk":"high","counter":"supabase pro plan price increase 2026"}
```

- `id`: the same fact seen on several pages shares one id (`q<n>-<few words>`).
  That is how agreement and disagreement are counted.
- `quote`: copied from the page, in the page's language, short (a line or
  two), with the number or name the claim depends on. `…` may join two parts of one passage.
  Never a paraphrase or a translation: the checker looks for it on the page.
- `published`: the page's own date, `YYYY-MM-DD`; `unknown` when it has none.
  An archived copy: the copy's date. Never the day you read it.
- `source`: `primary` when the owner of the fact says it (see `sources.md`).
- `risk: "high"` for the claims the answer stands on: prices, counts, shares,
  dates, versions, laws, "A causes B", anything in the title, the takeaways or
  the decision grid. Their number has to be in the quote. They're worth one
  search for evidence against them (a newer price, a correction, a critic);
  put that query in `counter`, and what it found in its own notes, under the
  same `id`.
- A claim you can settle by running something (a command works, a limit, a
  speed): run the smallest test in `$APP_SCRATCH_DIR`, save its output, and
  note it with `"url":"file://<output file>"`, `"source":"primary"`, the
  output line as the quote. Say in the report that you ran it, and when.

## The check

After merging the notes, before writing:

```bash
python3 "<this skill's folder>/check-research.py" "$R"
```

It checks every note's fields, looks for every quote in the page's snapshot
(fetching pages you read with `web_fetch` that have no snapshot yet), groups
notes by `id` and writes `$R/claims.json`:

| status | means | in the report |
|---|---|---|
| `verified` | quote on the page, and a primary source or 2+ independent organisations | say it plainly |
| `single` | only one secondary source | tag `확인 안 됨`, list in "확실하지 않은 것" |
| `conflict` | the sources' numbers differ | both sides with their dates, `출처 엇갈림` |
| `quote-missing` | no quote of it is on its page | fix the note or drop the claim |

`[error]` means a fact doesn't hold up yet: fix each one and run it again
until it exits 0. An error is never fixed by loosening the note: copy the
real passage, find a primary source, or move the claim to "확실하지 않은 것".
`[warn]` lines (date format, a missing `counter`, tags in the report) don't
block; fix the ones that matter.

Write the report from `claims.json`: the answer, the takeaways and the
decision grid use `verified` claims only. When the answer itself rests on a
`single` or `conflict` claim, say that in the answer.

After the report is written, run it once more: it then also checks that
every link in the report has a note and every `[n]` points to a source
(errors), and warns when a source shows no published date or conflicts and
unverified claims don't appear under "확실하지 않은 것".

## Numbers and dates

- A number comes with its unit, its date and what was measured (a vendor's
  own benchmark, a subset, an estimate). Recompute what can be recomputed
  (totals, per-month from per-year, growth rates) and say when you did.
- Prices and limits change: prefer the vendor's live page, and write the day
  you read it in the source list.
- A page's "updated" date is not its "published" date; when only "updated"
  exists, write that, as "업데이트".
- Vendor claims stay claims ("구글은 … 라고 밝혔어요").
