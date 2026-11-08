// GitHub issues of the project's repo, after gitsu: quick filters, GitHub search,
// and a way to hand an issue to a job. GitHub stays the record; nothing here edits it.
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { Task } from "../state/types";
import { projectById, projectsIn, spaceById, state } from "../state/store";
import { createTask } from "../engine/tasks";
import { expand } from "../engine/rpc";
import { ghIssue, ghIssues, openUrl, spaceEnv } from "../lib/native";
import { openTask, toast, view } from "../state/ui";
import { ago } from "./bits";
import { Fold } from "./Fold";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

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
  { id: "open", label: "열린 것", q: "is:open" },
  { id: "mine", label: "내 것", q: "is:open assignee:@me" },
  { id: "authored", label: "내가 쓴 것", q: "is:open author:@me" },
  { id: "working", label: "일 중", q: "" },
  { id: "recent", label: "최근", q: "sort:updated-desc" },
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
  return (
    <div class="iss">
      <div class="iss-filters">
        <For each={FILTERS}>
          {(f) => (
            <button class="iss-pill" classList={{ on: filter() === f.id && !typed().trim() }} onClick={() => (setTyped(""), setFilter(f.id))}>
              {f.label}
            </button>
          )}
        </For>
      </div>
      <div class="ft-search iss-search">
        <Icon name="search" size={13} />
        <input
          placeholder="필터  is:open label:bug"
          value={typed()}
          onChange={(e) => setTyped(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") setTyped(e.currentTarget.value);
          }}
        />
        <button class="icon-btn sm" title="새로고침" onClick={() => refetch()}><Icon name="refresh" size={13} /></button>
      </div>
      <Show when={where()} fallback={<div class="pane-empty">프로젝트를 고르면 이슈가 보여요</div>}>
        <Show
          when={!list.error}
          fallback={<div class="pane-empty">이슈를 못 불러왔어요<button class="btn sm" onClick={() => refetch()}>다시 하기</button></div>}
        >
          <Show when={list()} fallback={<div class="pane-empty"><span class="spin" /></div>}>
            <Show
              when={shown().length}
              fallback={<div class="pane-empty">{filter() === "working" && !typed().trim() ? "맡긴 이슈가 없어요" : "이슈가 없어요"}</div>}
            >
              <div class="iss-list">
                <For each={shown()}>
                  {(i) => <Row i={i} where={where()!} open={open() === i.number} toggle={() => setOpen(open() === i.number ? null : i.number)} />}
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
    toast(`#${i.number}을 일로 맡겼어요`, "info", { label: "열기", run: () => openTask(id) });
  };
  return (
    <div class="iss-item" classList={{ open: props.open }}>
      <div class="iss-row" role="button" tabindex="0" onClick={props.toggle} onKeyDown={(e) => e.key === "Enter" && props.toggle()}>
        <span class="iss-st" classList={{ closed: props.i.state !== "OPEN", working: !!job() }} />
        <span class="iss-n">#{props.i.number}</span>
        <span class="iss-title">{props.i.title}</span>
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
      </div>
      <Fold open={props.open}>
        <div class="iss-body">
          <div class="iss-acts">
            <Show
              when={job()}
              fallback={<button class="btn sm primary" onClick={() => void hand()}>일로 맡기기</button>}
            >
              {(j) => <button class="btn sm" onClick={() => openTask(j().id)}>맡긴 일 보기</button>}
            </Show>
            <button class="btn sm ghost" onClick={() => openUrl(props.i.url)}><Icon name="external" size={13} />GitHub</button>
            <span class="iss-by">{props.i.author?.login}</span>
          </div>
          <Show when={full()} fallback={<div class="iss-loading"><span class="spin" /></div>}>
            {(f) => (
              <>
                <Show when={f().body?.trim()} fallback={<p class="iss-empty">본문 없음</p>}>
                  <Markdown class="iss-md" text={f().body!} />
                </Show>
                <Show when={f().comments?.length}>
                  <div class="iss-comments">댓글 {f().comments!.length}개</div>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Fold>
    </div>
  );
}
