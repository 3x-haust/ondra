# Figures, the way a good paper draws them

A paper's best figure lets you understand the method before reading a line:
numbered stages, parts as boxes colored by what they are, arrows for what
moves, a dashed loop for what comes back, and a caption that says what to see.
Draw the report's pictures the same way, in plain words.

## Pick the figure by the question

| The question | The figure | In `report.html` |
|---|---|---|
| How does it work? What happens in what order? | method diagram: 2–4 numbered stages | `.flow` |
| Which option fits me? | decision grid, the pick marked | `table.grid` |
| How much? Which is biggest? | bars on one scale from zero, ≤ 6 | bar `svg` |
| How does it change with size or time? | a few bars per size, or a small line | bar `svg` |
| When did what happen? | timeline | timeline `svg` |
| What did the paper itself show? | the paper's own figure | `<img>` |

Most research questions with a "how" in them deserve one method diagram. A
report with only bars and tables is usually missing it.

## The method diagram (`.flow`)

- **Stages** numbered 1, 2, 3, named with a short verb phrase in the user's
  words ("일하면서 쌓이는 것", not "Augmented state rollout").
- **Boxes**: a bold name of a few words, then at most one short line under it.
  At most 4 boxes in a stage. No formulas, symbols or variable names: say what
  the thing is.
- **Color by role**, the same meaning everywhere in the report: `c1` what comes
  in (data, the user, a request), `c2` what is stored (memory, a database),
  `c3` the step that changes things (a trigger, a process), `c4` what is
  learned, trained or decided. Plain grey for the rest; `.dash` for something
  optional or produced on the way. A short state on a box (`고정`, `학습`,
  `유료`) with `.state`.
- **Arrows**: `.go` between stages, `.down` between boxes in a stage. A `.loop`
  line only when something really goes back (a model updated and reused, a
  cycle that repeats); say what goes back.
- Read it left to right like a sentence. If it takes more than 15 seconds to
  follow, cut boxes.

## Captions

Every figure has one: `<b>그림 N.</b>` + what the figure shows in one plain
sentence + where it came from ("출처 [2]의 Figure 3을 다시 그림", "출처 [1]").
The text refers to it ("그림 1처럼 …"). Units in the caption for numbers.

## A source's own figure

When a cited paper or report has a figure that answers the question exactly
(an architecture, a results plot), use it instead of guessing:

1. Find the image: arXiv papers have an HTML version
   (`https://arxiv.org/html/<id>`) whose figures are image files; other pages:
   the `<img>` near "Figure N".
2. Download it into `$R`, shrink it (`sips -Z 1400 fig.png`), and embed it as a
   data URI so the report stays one file:
   `base64 -i "$R/fig.png" | tr -d '\n'` into `src="data:image/png;base64,…"`.
3. Caption: what to look at in it, in Korean, and "(출처: [n]의 Figure k)".
   An English figure gets the key labels explained in the caption.

Never change what a source figure says. When it shows far more than the
question needs, redraw just the needed part as a `.flow` and say "다시 그림".

## Never

- A picture with nothing behind it in the sources: every number and every
  box comes from them.
- Decoration: icons, gradients, 3D, shadows, emoji.
- A legend the reader has to decode: put labels on the bars and boxes.
- Two pictures that say the same thing.
