# Writing the report so the user gets it in one read

The reader is the user: smart, busy, not an expert in this topic, and about to
decide something. A report they can't follow is a failed report, however
right it is. Write for them, then take the AI out of it.

## Shape

1. **The answer and what to do now, first.** The title is the answer in one
   plain sentence. Under it, "지금 할 일": 1–3 actions, each a verb the user can
   do this week ("가상 회사로 첫 버전을 만들어요"). Then 3 takeaways.
2. **Each section answers one question, in its heading** ("실제 주가를 쓰면
   얼마가 드나요?"), then the answer in the first sentence, then why.
3. **Caveats once.** At most one short caveat line per section, and only when
   it changes what the user should do. Everything else goes under "확실하지
   않은 것". Never close a paragraph with "이는 ~이 아니라 ~입니다" style
   disclaimers.
4. **Cut what the user didn't ask.** Background, method, "the landscape",
   outlook: out, unless it changes the decision.

## Sentences

- One idea per sentence. Most sentences under ~50 characters; break any over
  ~80. Mix in a longer one now and then so it doesn't read choppy.
- 해요체, the way you'd explain it to a friend across the table ("~예요",
  "~해요"). Same register everywhere.
- Words the user would use. A term the user didn't use (효과크기, 재배포,
  상용 이용권, MVP, 현실 전이) is replaced with plain words, or explained the
  first time in a few words: "효과크기 0.4(보통 수준의 차이)".
- Numbers with a unit and something to hold them against: "한 달 13~29만원
  (커피 구독 하나 값 정도)" only when the comparison is true and helps;
  otherwise the plain number and what it covers.
- Name who says so: "금융위원회는 상업적 이용을 막아 둬요[2]", not "~로 확인돼요".
- No stacked hedges ("~일 수 있을 것으로 보여요"): one, or say it straight.

## Tables and pictures

- A table only for short facts: names, numbers, yes/no, a few words. Cells over
  ~25 characters mean it should be sentences or a picture, not a table.
- Every picture answers one question, and its title is that question in plain
  words ("사용자 수별 한 달 비용"). Labels sit on the bars; no legend to decode.
- Draw them the way a good paper does: read `figures.md` before the first
  picture. How something works → a method diagram with numbered stages; which
  option → the decision grid; how much → bars; when → the timeline; a cited
  paper's own figure when it answers the question exactly.
- 1–4 pictures in the whole report, each with a "그림 N." caption. No picture
  that only restates a sentence.

## Take the AI out (after the draft)

Run the checker, fix every hit, run it again until it is clean:

```bash
python3 "<this skill's folder>/check-writing.py" "$R/report.html"
python3 "<this skill's folder>/check-writing.py" "$R/summary.html"
```

It catches the mechanical tells (long sentences, prose in table cells,
translationese, AI phrases, hedges, repeated openers, dashes). It can't catch
everything: then read `ko-ai-tells.md` (Korean) or `en-ai-tells.md` (English)
once and fix what's left by hand. Keep every fact, number, name and source
number when rewriting; change the wording, never the claim.

Last, read the top of the report as the user would, for 30 seconds: could
they say what the answer is and what to do next? If not, rewrite the top.
