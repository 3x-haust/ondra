# Writing the report so the user gets it in one read

The reader is the user: smart, busy, not an expert in this topic, and about to
decide something. A report they can't follow is a failed report, however
right it is. Write for them, then take the AI out of it.

## Shape

1. **The answer and what to do now, first.** The title is the answer in one
   plain sentence. Under it, "지금 할 일": a few actions, each a verb the user
   can do this week ("가상 회사로 첫 버전을 만들어요"). Then a few takeaways.
2. **Each section answers one question, in its heading** ("실제 주가를 쓰면
   얼마가 드나요?"), then the answer in the first sentence, then why.
3. **Caveats once.** A caveat in a section earns its place when it changes
   what the user should do; the rest reads better gathered under "확실하지
   않은 것" than tacked onto every paragraph.
4. **Cut what the user didn't ask.** Background, method, "the landscape" and
   outlook usually go, unless they change the decision.

## Sentences

- Mostly one idea per sentence, so it reads in one pass; mix in a longer one
  now and then so it doesn't read choppy.
- 해요체 by default, the way you'd explain it to a friend across the table
  ("~예요", "~해요"), in one register throughout.
- Words the user would use. A term the user didn't use (효과크기, 재배포,
  상용 이용권, MVP, 현실 전이) is replaced with plain words, or explained the
  first time in a few words: "효과크기 0.4(보통 수준의 차이)".
- Numbers with a unit and something to hold them against: "한 달 13~29만원
  (커피 구독 하나 값 정도)" only when the comparison is true and helps;
  otherwise the plain number and what it covers.
- Name who says so: "금융위원회는 상업적 이용을 막아 둬요[2]", not "~로 확인돼요".
- One hedge is enough ("~일 수 있을 것으로 보여요" stacks three); or say it straight.

## Tables and pictures

- Tables work for short facts: names, numbers, yes/no, a few words. When the
  cells turn into sentences, sentences or a picture usually read better.
- Every picture answers one question, and its title is that question in plain
  words ("사용자 수별 한 달 비용"). Labels on the bars read faster than a legend.
- Draw them the way a good paper does (`figures.md`). How something works →
  a method diagram with numbered stages; which option → the decision grid;
  how much → bars; when → the timeline; a cited paper's own figure when it
  answers the question exactly.
- Use a picture wherever the answer can be seen; skip one that only restates
  a sentence. A "그림 N." caption lets the text point to it.

## Take the AI out (after the draft)

Run the checker for a second pair of eyes (it sits in the deep-research
folder, one level above this file):

```bash
python3 "<this skill's folder>/check-writing.py" "$R/report.html"
python3 "<this skill's folder>/check-writing.py" "$R/summary.html"
```

It prints hints about the mechanical tells (long sentences, prose in table
cells, translationese, stock phrases, hedges, repeated openers, many dashes).
Read them and fix what helps the reader; a hint you disagree with can stay.
`ko-ai-tells.md` (Korean) and `en-ai-tells.md` (English) are references of
tells, not checklists: skim them when a passage still sounds off. Keep every
fact, number, name and source number when rewriting; change the wording,
never the claim.

Last, read the top of the report as the user would, for 30 seconds: could
they say what the answer is and what to do next? If not, rewrite the top.
