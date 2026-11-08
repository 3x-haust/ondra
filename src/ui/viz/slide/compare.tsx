// Comparison and status: feature table, pros and cons, Harvey balls,
// scorecard, pricing tiers, persona, a big quote or number, agenda, section
// divider, team grid, key points and an equation (A + B = C).
import { For, Index, Show } from "solid-js";
import { num, withUnit } from "../kit";
import { t } from "../../../i18n";
import { defineViz } from "../registry";
import { Card, Harvey, Mark, StatusMark, initials } from "./common";
import { arr, cell, item, items, quarters, statusOf, statusWord, str, texts, toNum, type Status } from "./util";

/* ───────────── feature comparison ───────────── */

interface FeatB { label?: string; cols?: unknown[]; rows?: unknown[]; em?: unknown }
defineViz<FeatB>({
  type: "features",
  family: "slide",
  title: "기능 비교표",
  when: "제품(안)마다 어떤 기능을 지원하고, 어디서 차이가 나나",
  render: (b) => {
    const cols = () => texts(b.cols).slice(0, 8);
    const emCol = () => (typeof b.em === "number" ? b.em : cols().indexOf(str(b.em)));
    const rows = () => arr(b.rows).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      return it ? { ...it, v: arr(o.v ?? o.cells ?? o.values), group: str(o.group) } : undefined;
    }).filter((r): r is NonNullable<typeof r> => !!r);
    return (
      <Card label={b.label} class="sl-feat">
        <div class="sl-scroll">
          <table class="sl-table">
            <thead><tr><th /><Index each={cols()}>{(c, i) => <th class="c" classList={{ hi: i === emCol() }}>{c()}</th>}</Index></tr></thead>
            <tbody>
              <For each={rows()}>
                {(r, ri) => (
                  <>
                    <Show when={r.group && r.group !== rows()[ri() - 1]?.group}><tr class="grp"><th colSpan={cols().length + 1}>{r.group}</th></tr></Show>
                    <tr classList={{ em: !!r.em }}>
                      <th>{r.label}<Show when={r.note}><span class="sl-note">{r.note}</span></Show></th>
                      <Index each={cols()}>
                        {(_, i) => {
                          const c = cell(r.v[i]);
                          return <td class="c" classList={{ hi: i === emCol() }}><Show when={c.k === "text"} fallback={<Show when={c.k !== "none"}><Mark k={c.k as "yes" | "no" | "part"} /></Show>}><span class="sl-cellt">{c.t}</span></Show></td>;
                        }}
                      </Index>
                    </tr>
                  </>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "협업툴 기능 비교",
      cols: ["우리 제품", "노션", "컨플루언스", "잔디"],
      em: 0,
      rows: [
        { label: "실시간 공동 편집", v: [true, true, true, false], group: "문서" },
        { label: "버전 기록", v: [true, "30일", true, "partial"], group: "문서" },
        { label: "온프레미스 설치", v: [true, false, true, true], group: "보안", em: true },
        { label: "SSO", v: [true, "partial", true, "partial"], group: "보안" },
        { label: "사용자당 월 요금", v: ["8,000원", "$10", "$6.05", "5,000원"], group: "가격" },
      ],
    },
  ],
});

/* ───────────── pros and cons ───────────── */

interface PCB { label?: string; pros?: unknown[]; cons?: unknown[]; verdict?: string }
defineViz<PCB>({
  type: "prosCons",
  family: "slide",
  title: "장단점",
  when: "이 선택의 좋은 점과 나쁜 점은 무엇이고, 어느 쪽이 무거운가",
  render: (b) => {
    const read = (x: unknown) => arr(x).map((y) => {
      const it = item(y);
      return it ? { ...it, w: toNum((y as Record<string, unknown>)?.weight) } : undefined;
    }).filter((y): y is NonNullable<typeof y> => !!y);
    const pros = () => read(b.pros), cons = () => read(b.cons);
    const sum = (l: { w?: number }[]) => l.reduce((s, x) => s + (x.w ?? 0), 0);
    const weighted = () => pros().some((p) => p.w) || cons().some((c) => c.w);
    const Side = (p: { kind: "pro" | "con"; list: ReturnType<typeof pros> }) => (
      <div class={`sl-pc-col ${p.kind}`}>
        <div class="sl-pc-head"><Mark k={p.kind === "pro" ? "yes" : "no"} /><b>{p.kind === "pro" ? t("장점") : t("단점")}</b><Show when={weighted()}><span class="sl-note">{t("{n}점", { n: sum(p.list), v: num(sum(p.list)) })}</span></Show></div>
        <ul>
          <For each={p.list}>
            {(x) => (
              <li classList={{ em: !!x.em }}>
                <span class="sl-pc-t"><b>{x.label}</b><Show when={x.note}><span class="sl-note">{x.note}</span></Show></span>
                <Show when={x.w}><span class="sl-pc-w" title={t("{n}점", { n: x.w!, v: num(x.w!) })}><Index each={Array.from({ length: Math.min(5, Math.round(x.w!)) })}>{() => <i />}</Index></span></Show>
              </li>
            )}
          </For>
        </ul>
      </div>
    );
    return (
      <Card label={b.label} class="sl-pc">
        <Show when={weighted() && sum(pros()) + sum(cons()) > 0}>
          <div class="sl-pc-bal" role="img" aria-label={t("장점 {a}점, 단점 {b}점", { a: sum(pros()), b: sum(cons()) })}>
            <i class="pro" style={{ "flex-grow": sum(pros()) }} /><i class="con" style={{ "flex-grow": sum(cons()) }} />
          </div>
        </Show>
        <div class="sl-pc-cols"><Side kind="pro" list={pros()} /><Side kind="con" list={cons()} /></div>
        <Show when={b.verdict}><p class="sl-verdict">{b.verdict}</p></Show>
      </Card>
    );
  },
  examples: [
    {
      label: "모노레포 전환",
      pros: [{ label: "공통 코드 한곳에서 수정", weight: 5 }, { label: "의존성 버전 통일", weight: 3 }, { label: "원자적 커밋", note: "API와 앱 동시 변경", weight: 3 }],
      cons: [{ label: "CI 시간 증가", note: "캐시 없으면 +12분", weight: 4 }, { label: "권한 분리 어려움", weight: 2 }],
      verdict: "CI 캐시를 먼저 갖추고 2분기에 전환",
    },
  ],
});

/* ───────────── Harvey balls ───────────── */

interface HarveyB { label?: string; cols?: unknown[]; rows?: unknown[] }
defineViz<HarveyB>({
  type: "harvey",
  family: "slide",
  title: "하비 볼 표",
  when: "선택지마다 기준별로 얼마나 충족하나 (0–4 단계)",
  render: (b) => {
    const cols = () => texts(b.cols).slice(0, 8);
    const rows = () => arr(b.rows).map((x) => {
      const it = item(x);
      return it ? { ...it, v: arr((x as Record<string, unknown>).v ?? (x as Record<string, unknown>).values) } : undefined;
    }).filter((r): r is NonNullable<typeof r> => !!r);
    const WORD = ["없음", "낮음", "보통", "높음", "매우 높음|level"];
    return (
      <Card label={b.label} class="sl-harveyt">
        <div class="sl-scroll">
          <table class="sl-table">
            <thead><tr><th /><For each={cols()}>{(c) => <th class="c">{c}</th>}</For></tr></thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr classList={{ em: !!r.em }}>
                    <th>{r.label}</th>
                    <Index each={cols()}>{(_, i) => { const q = quarters(r.v[i]); return <td class="c" title={q === undefined ? "" : t(WORD[q])}><Show when={q !== undefined}><Harvey q={q!} /></Show></td>; }}</Index>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "벡터 DB 후보 평가",
      cols: ["성능", "운영 편의", "비용", "생태계"],
      rows: [{ label: "pgvector", v: [2, 4, 4, 3], em: true }, { label: "Pinecone", v: [4, 4, 1, 3] }, { label: "Milvus", v: [4, 1, 3, 2] }, { label: "Qdrant", v: [3, 3, 3, 2] }],
    },
  ],
});

/* ───────────── scorecard ───────────── */

interface ScoreB { label?: string; unit?: string; items?: unknown[] }
defineViz<ScoreB>({
  type: "scorecard",
  family: "slide",
  title: "스코어카드",
  when: "지표마다 목표 대비 실적은 얼마이고 상태는 어떤가",
  render: (b) => {
    const rows = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      if (!it) return undefined;
      const t = toNum(o.target), a = toNum(o.actual ?? o.value);
      const better = o.better === "down" ? "down" : "up";
      const st: Status | undefined = statusWord(o.status) ?? (t !== undefined && a !== undefined ? statusOf(a, t, better) : undefined);
      const ratio = t !== undefined && a !== undefined && t !== 0 ? (better === "up" ? a / t : t / a) : undefined;
      return { ...it, t, a, st, ratio, unit: str(o.unit) || b.unit };
    }).filter((r): r is NonNullable<typeof r> => !!r);
    const f = (v: number | undefined, u?: string) => (v === undefined ? "–" : withUnit(num(v), u));
    return (
      <Card label={b.label} class="sl-score">
        <div class="sl-scroll">
          <table class="sl-table">
            <thead><tr><th>{t("지표")}</th><th class="r">{t("목표")}</th><th class="r">{t("실적")}</th><th class="sl-bar">{t("달성률")}</th><th>{t("상태")}</th></tr></thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr classList={{ em: !!r.em }}>
                    <th>{r.label}<Show when={r.note}><span class="sl-note">{r.note}</span></Show></th>
                    <td class="r num">{f(r.t, r.unit)}</td>
                    <td class="r num strong">{f(r.a, r.unit)}</td>
                    <td class="sl-bar">
                      <Show when={r.ratio !== undefined}>
                        <span class="sl-meter target"><i class={`s-${r.st}`} style={{ width: `${Math.min(1, r.ratio!) * 100}%` }} /></span>
                        <span class="sl-ratio num">{Math.round(r.ratio! * 100)}%</span>
                      </Show>
                    </td>
                    <td><Show when={r.st}><StatusMark s={r.st!} /></Show></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "3분기 운영 지표",
      items: [
        { label: "월 매출", target: 12, actual: 12.8, unit: "억" }, { label: "신규 고객", target: 1500, actual: 1380, unit: "명" },
        { label: "이탈률", target: 3, actual: 4.1, unit: "%", better: "down", em: true }, { label: "응답 시간 p95", target: 300, actual: 270, unit: "ms", better: "down" },
        { label: "NPS", target: 40, actual: 31 },
      ],
    },
  ],
});

/* ───────────── pricing tiers ───────────── */

interface PriceB { label?: string; unit?: string; items?: unknown[] }
defineViz<PriceB>({
  type: "pricing",
  family: "slide",
  title: "요금제 비교",
  when: "요금제마다 가격과 포함 내용은 어떻게 다른가",
  render: (b) => {
    const tiers = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      if (!it) return undefined;
      const p = o.price;
      return { ...it, price: typeof p === "number" ? (p === 0 ? t("무료") : t("{v}원", { v: num(p) })) : str(p), per: str(o.per) || (typeof p === "number" && p > 0 ? b.unit ?? "" : ""), features: texts(o.features ?? o.items), plus: str(o.plus) };
    }).filter((t): t is NonNullable<typeof t> => !!t).slice(0, 5);
    return (
      <Card label={b.label} class="sl-price">
        <div class="sl-price-grid" style={{ "--n": tiers().length }}>
          <For each={tiers()}>
            {(tier) => (
              <div class="sl-tier" classList={{ em: !!tier.em }}>
                <div class="sl-tier-head"><b>{tier.label}</b><Show when={tier.em}><span class="sl-tag t-new">{t("추천")}</span></Show></div>
                <div class="sl-tier-price"><span>{tier.price}</span><Show when={tier.per}><em>/{tier.per}</em></Show></div>
                <Show when={tier.note}><p class="sl-note">{tier.note}</p></Show>
                <Show when={tier.plus}><p class="sl-tier-plus">{tier.plus}</p></Show>
                <ul><For each={tier.features}>{(f) => <li><Mark k="yes" />{f}</li>}</For></ul>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "B2B 요금제 (사용자당)",
      unit: "월",
      items: [
        { label: "스타터", price: 0, note: "5명까지", features: ["프로젝트 3개", "기본 보고서"] },
        { label: "팀", price: 9000, note: "50명까지", em: true, plus: "스타터의 모든 기능, 그리고", features: ["무제한 프로젝트", "권한 관리", "API 연동"] },
        { label: "엔터프라이즈", price: "문의", note: "인원 무제한", plus: "팀의 모든 기능, 그리고", features: ["SSO·감사 로그", "전담 매니저", "SLA 99.9%"] },
      ],
    },
  ],
});

/* ───────────── persona ───────────── */

interface PersonaB { label?: string; name?: string; role?: string; quote?: string; tags?: unknown[]; goals?: unknown[]; pains?: unknown[]; traits?: unknown[] }
defineViz<PersonaB>({
  type: "persona",
  family: "slide",
  title: "페르소나",
  when: "우리가 만드는 대상은 어떤 사람이고, 무엇을 원하고 무엇에 막히나",
  render: (b) => {
    const traits = () => arr(b.traits).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const v = toNum(o.value);
      return { lo: str(o.lo) || str(o.label), hi: str(o.hi), v: v === undefined ? undefined : v > 1 ? v / 100 : v };
    }).filter((t) => t.lo && t.v !== undefined);
    const List = (p: { name: string; list: string[] }) => <Show when={p.list.length}><div class="sl-persona-sec"><b>{p.name}</b><ul class="sl-points"><For each={p.list}>{(x) => <li>{x}</li>}</For></ul></div></Show>;
    return (
      <Card label={b.label} class="sl-persona">
        <div class="sl-persona-body">
          <div class="sl-persona-id">
            <span class="sl-avatar lg">{initials(b.name ?? "")}</span>
            <div><b class="sl-persona-name">{b.name}</b><Show when={b.role}><span class="sl-note">{b.role}</span></Show></div>
            <Show when={texts(b.tags).length}><div class="sl-chips"><For each={texts(b.tags)}>{(t) => <span class="sl-chip">{t}</span>}</For></div></Show>
          </div>
          <div class="sl-persona-main">
            <Show when={b.quote}><blockquote class="sl-persona-q">{b.quote}</blockquote></Show>
            <div class="sl-persona-two"><List name={t("목표|goals")} list={texts(b.goals)} /><List name={t("불편")} list={texts(b.pains)} /></div>
            <Show when={traits().length}>
              <div class="sl-traits">
                <For each={traits()}>
                  {(t) => (
                    <div class="sl-trait">
                      <span>{t.lo}</span>
                      <span class="sl-trait-track"><i style={{ left: `${t.v! * 100}%` }} /></span>
                      <span>{t.hi}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Card>
    );
  },
  examples: [
    {
      name: "김하린",
      role: "34세 · 중견 제조사 구매 담당",
      tags: ["엑셀 상급", "모바일 결재"],
      quote: "견적 세 개 비교하는 데 반나절이 걸려요",
      goals: ["견적 비교를 30분 안에", "승인 이력 한곳에 남기기"],
      pains: ["공급사마다 견적서 양식이 다름", "결재가 메일로 오감"],
      traits: [{ lo: "직접 처리", hi: "위임", value: 0.25 }, { lo: "가격 우선", hi: "품질 우선", value: 0.6 }, { lo: "새 도구 경계", hi: "새 도구 환영", value: 0.7 }],
    },
  ],
});

/* ───────────── big quote / callout ───────────── */

interface QuoteB { label?: string; text?: string; by?: string; role?: string; value?: string }
defineViz<QuoteB>({
  type: "quote",
  family: "slide",
  title: "인용·강조",
  when: "한 문장(또는 한 숫자)을 크게 보여 줄 때",
  render: (b) => (
    <div class="blk sl sl-quote" classList={{ stat: !!b.value }}>
      <Show when={b.label}><div class="blk-label">{b.label}</div></Show>
      <Show when={b.value}><div class="sl-quote-value">{b.value}</div></Show>
      <Show when={b.text}><blockquote classList={{ q: !b.value }}>{b.text}</blockquote></Show>
      <Show when={b.by}><div class="sl-quote-by"><b>{b.by}</b><Show when={b.role}><span>{b.role}</span></Show></div></Show>
    </div>
  ),
  examples: [
    { text: "설정 화면을 찾는 데만 10분이 걸렸어요. 정작 바꾸는 건 클릭 한 번이었는데요.", by: "사용성 테스트 참가자 P4", role: "인사팀 매니저" },
    { label: "이번 분기 핵심 숫자", value: "38%", text: "체험 사용자 중 첫 주에 팀원을 초대한 비율, 전 분기보다 11%p 올랐다" },
  ],
});

/* ───────────── agenda / section divider ───────────── */

interface AgendaB { label?: string; items?: unknown[]; now?: number }
defineViz<AgendaB>({
  type: "agenda",
  family: "slide",
  title: "목차·안건",
  when: "오늘 다룰 순서는 무엇이고 지금 어디쯤인가",
  render: (b) => {
    const list = () => arr(b.items).map((x) => {
      const it = item(x);
      return it ? { ...it, time: str((x as Record<string, unknown>)?.time) } : undefined;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    return (
      <Card label={b.label ?? t("목차|agenda")} class="sl-agenda">
        <ol>
          <For each={list()}>
            {(it, i) => (
              <li classList={{ now: b.now === i(), past: b.now !== undefined && i() < b.now }}>
                <span class="sl-agenda-no">{String(i() + 1).padStart(2, "0")}</span>
                <span class="sl-agenda-t"><b>{it.label}</b><Show when={it.note}><span class="sl-note">{it.note}</span></Show></span>
                <Show when={it.time}><span class="sl-agenda-time">{it.time}</span></Show>
              </li>
            )}
          </For>
        </ol>
      </Card>
    );
  },
  examples: [
    {
      label: "주간 제품 회의",
      now: 1,
      items: [{ label: "지난주 지표", time: "5분" }, { label: "결제 장애 회고", note: "원인과 재발 방지", time: "15분" }, { label: "다음 스프린트 범위", time: "20분" }, { label: "기타 안건", time: "5분" }],
    },
  ],
});
interface SectionB { no?: number | string; title?: string; label?: string; note?: string }
defineViz<SectionB>({
  type: "section",
  family: "slide",
  title: "섹션 구분",
  when: "발표나 보고서에서 새 장을 시작할 때",
  render: (b) => (
    <div class="blk sl sl-section">
      <Show when={b.no !== undefined}><span class="sl-section-no">{typeof b.no === "number" ? String(b.no).padStart(2, "0") : b.no}</span></Show>
      <div><b>{b.title ?? b.label}</b><Show when={b.note}><span class="sl-note">{b.note}</span></Show></div>
    </div>
  ),
  examples: [{ no: 2, title: "원인 분석", note: "결제 실패가 몰린 시간과 경로" }],
});

/* ───────────── team grid ───────────── */

interface TeamB { label?: string; items?: unknown[] }
defineViz<TeamB>({
  type: "team",
  family: "slide",
  title: "팀 소개",
  when: "누가 이 일을 맡고, 각자 역할은 무엇인가",
  render: (b) => {
    const people = () => arr(b.items ?? (b as Record<string, unknown>).people).map((x) => {
      const it = item(x);
      return it ? { ...it, role: str((x as Record<string, unknown>)?.role) } : undefined;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    return (
      <Card label={b.label} class="sl-team">
        <div class="sl-team-grid">
          <For each={people()}>
            {(p) => (
              <div class="sl-person" classList={{ em: !!p.em }}>
                <span class="sl-avatar">{initials(p.label)}</span>
                <div><b>{p.label}</b><Show when={p.role}><span class="sl-person-role">{p.role}</span></Show><Show when={p.note}><span class="sl-note">{p.note}</span></Show></div>
              </div>
            )}
          </For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "결제 개편 TF",
      items: [
        { label: "오지훈", role: "PM", note: "일정·범위", em: true }, { label: "서다은", role: "백엔드 리드", note: "결제 API" }, { label: "문태오", role: "iOS", note: "결제 화면" },
        { label: "윤채원", role: "QA", note: "회귀 테스트" }, { label: "Alex Kim", role: "보안", note: "PCI 점검" },
      ],
    },
  ],
});

/* ───────────── key points (block list) ───────────── */

interface PointsB { label?: string; items?: unknown[]; cols?: number }
defineViz<PointsB>({
  type: "points",
  family: "slide",
  title: "핵심 포인트",
  when: "꼭 기억할 몇 가지(요약·제안·결론)를 번호 카드로",
  render: (b) => {
    const list = () => items(b.items).slice(0, 9);
    return (
      <Card label={b.label} class="sl-pts">
        <ol class="sl-pts-grid" style={{ "--cols": b.cols ?? Math.min(3, list().length) }}>
          <For each={list()}>
            {(it, i) => (
              <li classList={{ em: !!it.em }}>
                <span class="sl-pts-no">{it.value !== undefined ? withUnit(num(it.value), it.unit) : String(i() + 1).padStart(2, "0")}</span>
                <b>{it.label}</b>
                <Show when={it.note}><p class="sl-note">{it.note}</p></Show>
              </li>
            )}
          </For>
        </ol>
      </Card>
    );
  },
  examples: [
    {
      label: "결론",
      items: [
        { label: "결제 실패의 70%는 재시도로 복구된다", note: "자동 재시도 큐를 먼저 붙인다", em: true },
        { label: "간편결제 비중이 절반을 넘었다", note: "카드 입력 화면은 뒤로 뺀다" },
        { label: "야간 장애는 배포와 겹쳤다", note: "22시 이후 배포 금지" },
      ],
    },
  ],
});

/* ───────────── equation: A + B = C ───────────── */

interface EqB { label?: string; items?: unknown[]; op?: string; result?: unknown }
defineViz<EqB>({
  type: "combine",
  family: "slide",
  title: "더하기 공식",
  when: "몇 가지가 합쳐져 어떤 결과가 되나 (A + B = C)",
  render: (b) => {
    const list = () => items(b.items).slice(0, 5);
    const res = () => item(b.result);
    const op = () => (["+", "×", "−", "→"].includes(str(b.op)) ? str(b.op) : "+");
    return (
      <Card label={b.label} class="sl-eq">
        <div class="sl-eq-row">
          <For each={list()}>
            {(it, i) => (
              <>
                <Show when={i()}><span class="sl-eq-op" aria-hidden="true">{op()}</span></Show>
                <div class="sl-eq-term"><b>{it.label}</b><Show when={it.note}><span class="sl-note">{it.note}</span></Show></div>
              </>
            )}
          </For>
          <Show when={res()}>
            <span class="sl-eq-op" aria-hidden="true">=</span>
            <div class="sl-eq-term res"><b>{res()!.label}</b><Show when={res()!.note}><span class="sl-note">{res()!.note}</span></Show></div>
          </Show>
        </div>
      </Card>
    );
  },
  examples: [
    { label: "재구매가 늘어난 이유", items: [{ label: "새벽배송", note: "도착 시간 확실" }, { label: "정기배송 할인", note: "10%" }, { label: "구매 주기 알림" }], result: { label: "재구매율 +14%p", note: "6개월 기준" } },
  ],
});
