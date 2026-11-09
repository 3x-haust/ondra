// GitHub issues of the project's repo, after gitsu: quick filters, GitHub search,
// and a way to hand an issue to a job. GitHub stays the record; nothing here edits it.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { Task } from "../state/types";
import { projectById, projectsIn, spaceById, state } from "../state/store";
import { createTask } from "../engine/tasks";
import { expand } from "../engine/rpc";
import { ghIssue, ghIssues, spaceEnv } from "../lib/native";
import { linkMenu, openLink } from "./links";
import { openTask, toast, view } from "../state/ui";
import { ago } from "./bits";
import { Fold } from "./Fold";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { t } from "../i18n";

type Label = { name: string; color?: string };
type Issue = {
  number: number;
  title: string;
  state: string;
  labels: Label[];
  assignees: { login: string }[];
  author?: { login: string };
  updatedAt?: string;
  url: string;
};
type Full = Issue & { body?: string; comments?: { author?: { login: string }; body: string; createdAt?: string }[] };

const FILTERS = [
  { id: "open", label: "열림", icon: "issue", q: "is:open" },
  { id: "mine", label: "내 이슈", icon: "at", q: "is:open assignee:@me" },
  { id: "authored", label: "내가 작성", icon: "pencil", q: "is:open author:@me" },
  { id: "working", label: "작업 중|issue", icon: "play", q: "" },
  { id: "recent", label: "최근", icon: "clock", q: "sort:updated-desc" },
] as const;

/** the folder whose repo we show: the open job's, else the project in view, else the space's first */
function folderOf(t?: Task): { dir: string; space: Task["space"]; project?: string } | undefined {
  if (t) return { dir: expand(t.cwd), space: t.space, project: t.project };
  const v = view();
  const p = (v.name === "main" && v.project ? projectById(v.project, state.space) : undefined) ?? projectsIn(state.space)[0];
  if (p) return { dir: expand(p.folder), space: p.space, project: p.id };
  const sp = spaceById(state.space);
  return sp?.folder ? { dir: expand(sp.folder), space: sp.id } : undefined;
}

/** jobs started from an issue, by issue url */
const jobsByIssue = createMemo(() => {
  const m = new Map<string, Task>();
  for (const t of state.tasks) if (t.issue && !t.archived) m.set(t.issue.url, t);
  return m;
});

export function IssuesPane(props: { t?: Task }) {
  const where = () => folderOf(props.t);
  const [filter, setFilter] = createSignal<(typeof FILTERS)[number]["id"]>("open");
  const [typed, setTyped] = createSignal("");
  const [open, setOpen] = createSignal<number | null>(null);
  const [folded, setFolded] = createSignal<Set<string>>(new Set());
  const search = () => typed().trim() || FILTERS.find((f) => f.id === filter())!.q || "is:open";
  const [list, { refetch }] = createResource(
    () => (where() ? { ...where()!, q: search() } : false),
    async (w) => {
      const env = await spaceEnv(spaceById(w.space)).catch(() => []);
      return JSON.parse(await ghIssues(w.dir, w.q, env)) as Issue[];
    },
  );
  const shown = () => {
    const all = list() ?? [];
    return filter() === "working" && !typed().trim() ? all.filter((i) => jobsByIssue().has(i.url)) : all;
  };
  // grouped like gitsu's list: what an agent works on first, then open, then closed
  const groups = createMemo(() => {
    const g: { id: string; label: string; items: Issue[] }[] = [
      { id: "working", label: "작업 중|issue", items: [] },
      { id: "open", label: "열림", items: [] },
      { id: "closed", label: "닫힘", items: [] },
    ];
    for (const i of shown()) g[jobsByIssue().has(i.url) && i.state === "OPEN" ? 0 : i.state === "OPEN" ? 1 : 2].items.push(i);
    return g.filter((x) => x.items.length);
  });
  const fold = (id: string) =>
    setFolded((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  return (
    <div class="iss">
      <div class="iss-filters">
        <For each={FILTERS}>
          {(f) => (
            <button class="iss-pill" classList={{ on: filter() === f.id && !typed().trim() }} onClick={() => (setTyped(""), setFilter(f.id))}>
              <Icon name={f.icon} size={14} />
              {t(f.label)}
            </button>
          )}
        </For>
      </div>
      <div class="iss-search">
        <Icon name="search" size={14} />
        <input
          placeholder={t("필터")}
          title="is:open label:bug @me no:assignee"
          spellcheck={false}
          value={typed()}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") setTyped(e.currentTarget.value);
          }}
        />
        <button class="icon-btn sm" title={t("새로고침")} onClick={() => refetch()}><Icon name="refresh" size={14} /></button>
      </div>
      <Show when={where()} fallback={<div class="pane-empty">{t("프로젝트 없음")}</div>}>
        <Show
          when={!list.error}
          fallback={<div class="pane-empty">{t("이슈를 불러오지 못했어요")}<button class="btn sm" onClick={() => refetch()}>{t("다시 시도")}</button></div>}
        >
          <Show when={list()} fallback={<div class="pane-empty">{t("불러오는 중…")}</div>}>
            <Show
              when={shown().length}
              fallback={<div class="pane-empty">{filter() === "working" && !typed().trim() ? t("작업 중인 이슈 없음") : t("이슈 없음")}</div>}
            >
              <div class="iss-list">
                <For each={groups()}>
                  {(g) => (
                    <div class="iss-group">
                      <button class="iss-group-head" classList={{ folded: folded().has(g.id) }} onClick={() => fold(g.id)} aria-expanded={!folded().has(g.id)}>
                        <Icon name="chevron" size={12} class="iss-chev" />
                        <span>{t(g.label)}</span>
                        <span class="iss-count">{g.items.length}</span>
                      </button>
                      <Fold open={!folded().has(g.id)}>
                        <For each={g.items}>
                          {(i) => <Row i={i} where={where()!} open={open() === i.number} toggle={() => setOpen(open() === i.number ? null : i.number)} />}
                        </For>
                      </Fold>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function Row(props: { i: Issue; where: NonNullable<ReturnType<typeof folderOf>>; open: boolean; toggle: () => void }) {
  const job = () => jobsByIssue().get(props.i.url);
  const [full] = createResource(
    () => (props.open ? props.i.number : false),
    async (n) => {
      const env = await spaceEnv(spaceById(props.where.space)).catch(() => []);
      return JSON.parse(await ghIssue(props.where.dir, n, env)) as Full;
    },
  );
  const hand = async () => {
    const i = props.i;
    let body = full()?.body;
    if (body === undefined) {
      const env = await spaceEnv(spaceById(props.where.space)).catch(() => []);
      body = await ghIssue(props.where.dir, i.number, env).then((x) => (JSON.parse(x) as Full).body ?? "").catch(() => "");
    }
    const ask = [`GitHub 이슈 #${i.number} 해결: ${i.title}`, i.url, "", body?.trim() || "(본문 없음)"].join("\n");
    const id = createTask({
      space: props.where.space,
      title: i.title,
      topic: projectById(props.where.project)?.name ?? "",
      ask,
      cwd: props.where.dir,
      project: props.where.project,
      display: `#${i.number} ${i.title}`,
      isolate: state.settings.isolate,
      issue: { n: i.number, url: i.url, title: i.title },
    });
    toast(t("#{n} 작업을 만들었어요", { n: i.number }), "info", { label: t("열기"), run: () => openTask(id) });
  };
  const start = () => {
    const j = job();
    if (j) openTask(j.id);
    else void hand();
  };
  return (
    <div class="iss-item" classList={{ open: props.open }}>
      <div class="iss-row" role="button" tabindex="0" onClick={props.toggle} onKeyDown={(e) => e.key === "Enter" && props.toggle()}>
        <Show
          when={job() && props.i.state === "OPEN"}
          fallback={<span class="iss-st" classList={{ closed: props.i.state !== "OPEN" }}><Icon name={props.i.state === "OPEN" ? "issue" : "done"} size={14} /></span>}
        >
          <span class="iss-st working" title={t("작업 중|issue")}><span class="tk-run" /></span>
        </Show>
        <span class="iss-n">#{props.i.number}</span>
        <span class="iss-title" title={props.i.title}>{props.i.title}</span>
        <span class="iss-meta">
          <For each={props.i.labels.slice(0, 2)}>
            {(l) => (
              <span class="iss-label">
                <i style={{ background: l.color ? `#${l.color}` : "var(--ink-4)" }} />
                {l.name}
              </span>
            )}
          </For>
          <Show when={props.i.labels.length > 2}><span class="iss-more">+{props.i.labels.length - 2}</span></Show>
          <span class="iss-age">{props.i.updatedAt ? ago(Date.parse(props.i.updatedAt)) : ""}</span>
        </span>
        <span class="iss-acts" onClick={(e) => e.stopPropagation()}>
          <button class="btn sm" onClick={start}>{job() ? t("작업 보기") : t("작업 만들기")}</button>
          <button class="icon-btn sm" title={t("GitHub에서 열기")} onClick={(e) => void openLink(props.i.url, { event: e })} onContextMenu={linkMenu(props.i.url)}><Icon name="external" size={14} /></button>
        </span>
      </div>
      <Fold open={props.open}>
        <div class="iss-body">
          <div class="iss-by">
            <Show when={props.i.author?.login}>{(a) => <b>{a()}</b>}</Show>
            <Show when={full()?.comments?.length}>{(n) => <span>{t("댓글 {n}개", { n: n() })}</span>}</Show>
          </div>
          <Show when={full()} fallback={<p class="iss-empty">{t("불러오는 중…")}</p>}>
            {(f) => (
              <Show when={f().body?.trim()} fallback={<p class="iss-empty">{t("본문 없음")}</p>}>
                <Markdown class="iss-md" text={f().body!} />
              </Show>
            )}
          </Show>
        </div>
      </Fold>
    </div>
  );
}
