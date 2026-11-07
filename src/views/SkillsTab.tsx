// Settings › 스킬: every skill jobs get. Click one to read its SKILL.md and change it.
// Bundled skills are never written over: a change becomes the user's copy, which
// workers get instead (원래대로 removes it). Skills made here live in the app's data
// folder and in state.skills (which passes them to jobs), like imported ones.
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { fsRead, skillList, skillRemove, skillSave, type SkillFile } from "../lib/native";
import { engine, tilde } from "../engine/rpc";
import { setState, state } from "../state/store";
import { toast } from "../state/ui";
import { Icon } from "../ui/Icon";
import { Sheet } from "../ui/Sheet";
import { Markdown } from "../ui/Markdown";

type Kind = "bundled" | "changed" | "mine" | "imported";
interface Entry {
  key: string;
  name: string;
  description: string;
  /** the SKILL.md */
  path: string;
  kind: Kind;
  /** for skills in state.skills: their entry's path (a folder or a SKILL.md) */
  statePath?: string;
  /** for imported skills: the tool it came from */
  from?: string;
}
const KIND_LABEL: Record<Kind, string> = { bundled: "기본", changed: "고침", mine: "내 스킬", imported: "가져옴" };
const FROM: Record<string, string> = { claude: "Claude Code", codex: "Codex", pi: "pi", "3xhaust": "3xhaustPi", omo: "OmO", cursor: "Cursor", opencode: "opencode" };
const mdOf = (p: string) => (/\.md$/i.test(p) ? p : `${p.replace(/\/$/, "")}/SKILL.md`);
const madeHere = (p: string) => !!engine.info.dataDir && p.startsWith(`${engine.info.dataDir}/skills/`);

/** name / description from a SKILL.md's front matter, and the body after it. */
export function parseSkill(text: string): { name?: string; description?: string; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: text };
  const field = (k: string) => {
    const lines = m[1].split(/\r?\n/);
    const i = lines.findIndex((l) => l.startsWith(`${k}:`));
    if (i < 0) return undefined;
    let v = lines[i].slice(k.length + 1).trim();
    // folded / literal block: the indented lines under it
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const rest: string[] = [];
      for (const l of lines.slice(i + 1)) {
        if (!/^\s+/.test(l)) break;
        rest.push(l.trim());
      }
      v = rest.join(" ");
    }
    return v.replace(/^["']|["']$/g, "");
  };
  return { name: field("name"), description: field("description"), body: text.slice(m[0].length) };
}

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

const compose = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n${body.trim()}\n`;


function SkillSheet(props: { entry: Entry; onClose: () => void; onChanged: () => void }) {
  const [text, { mutate }] = createResource(() => props.entry.path, async (p) => (await fsRead(p)).text ?? "");
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const parsed = createMemo(() => parseSkill(text() ?? ""));
  const e = () => props.entry;

  const save = async () => {
    setBusy(true);
    try {
      const k = e().kind;
      if (k === "imported") {
        const name = slug(parsed().name || e().name) || "skill";
        const dir = await skillSave(name, draft(), false);
        setState("skills", (x) => x.path === e().statePath, (x) => ({ ...x, name, path: dir, source: "ondra" as const }));
        toast("Ondra 스킬로 옮겨 저장했어요. 원래 파일은 그대로예요");
        props.onChanged();
        props.onClose();
        return;
      }
      await skillSave(e().name, draft(), k === "bundled" || k === "changed");
      if (k === "mine") {
        const d = parseSkill(draft()).description;
        if (d) setState("skills", (x) => x.path === e().statePath, "description", d);
      }
      mutate(draft());
      setEditing(false);
      toast(k === "bundled" ? "내 사본으로 저장했어요. 이제 일에는 이 내용이 가요" : "저장했어요");
      props.onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const k = e().kind;
    if (k === "imported") {
      setState("skills", (l) => l.filter((s) => s.path !== e().statePath));
      toast("목록에서 뺐어요. 원래 파일은 그대로예요");
    } else if (k === "changed") {
      await skillRemove(e().name, true).catch((err) => toast(String(err), "bad"));
      toast("원래 내용으로 돌렸어요");
    } else {
      if (!sure()) return void setSure(true);
      await skillRemove(e().path.split("/").slice(-2, -1)[0] ?? e().name, false).catch((err) => toast(String(err), "bad"));
      setState("skills", (l) => l.filter((s) => s.path !== e().statePath));
      toast("지웠어요");
    }
    props.onChanged();
    props.onClose();
  };

  return (
    <Sheet
      title={e().name}
      onClose={props.onClose}
      foot={
        <>
          <Show when={e().kind === "changed"}><button class="btn sm ghost" onClick={remove}>원래대로</button></Show>
          <Show when={e().kind === "mine"}>
            <button class="btn sm ghost" classList={{ danger: sure() }} onClick={remove} onBlur={() => setSure(false)}><Icon name="trash" size={13} />{sure() ? "정말 지울까요?" : "지우기"}</button>
          </Show>
          <Show when={e().kind === "imported"}><button class="btn sm ghost" onClick={remove}>목록에서 빼기</button></Show>
          <span class="spacer" />
          <Show
            when={editing()}
            fallback={<button class="btn sm" disabled={text.loading} onClick={() => (setDraft(text() ?? ""), setEditing(true))}><Icon name="pencil" size={13} />고치기</button>}
          >
            <button class="btn sm ghost" onClick={() => setEditing(false)}>취소</button>
            <button class="btn sm primary" disabled={busy() || draft() === text()} onClick={save}>저장</button>
          </Show>
        </>
      }
    >
      <div class="sk-meta">
        <div><span class="pill">{KIND_LABEL[e().kind]}{e().from ? ` · ${FROM[e().from!] ?? e().from}` : ""}</span></div>
        <Show when={parsed().description || e().description}><p>{parsed().description || e().description}</p></Show>
        <span class="sk-path selectable">{tilde(e().path)}</span>
      </div>
      <Show when={!text.loading} fallback={<p class="muted">불러오는 중이에요</p>}>
        <Show when={editing()} fallback={<Markdown text={parsed().body} />}>
          <textarea class="sk-edit" spellcheck={false} value={draft()} onInput={(ev) => setDraft(ev.currentTarget.value)} />
        </Show>
      </Show>
    </Sheet>
  );
}

function NewSkill(props: { onClose: () => void; onChanged: () => void; taken: string[] }) {
  const [name, setName] = createSignal("");
  const [desc, setDesc] = createSignal("");
  const [body, setBody] = createSignal("");
  const [err, setErr] = createSignal("");
  const id = () => slug(name());
  const save = async () => {
    if (!id()) return setErr("이름을 영문으로 적어 주세요");
    if (props.taken.includes(id())) return setErr("같은 이름의 스킬이 있어요");
    if (!desc().trim()) return setErr("언제 쓰는 스킬인지 한 줄로 적어 주세요");
    try {
      const dir = await skillSave(id(), compose(id(), desc(), body()), false);
      setState("skills", (l) => [...l, { name: id(), path: dir, description: desc().trim(), source: "ondra" as const, enabled: true, menu: true }]);
      toast("스킬을 만들었어요");
      props.onChanged();
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Sheet
      title="새 스킬"
      onClose={props.onClose}
      foot={
        <>
          <Show when={err()}><p class="sk-err">{err()}</p></Show>
          <span class="spacer" />
          <button class="btn sm ghost" onClick={props.onClose}>취소</button>
          <button class="btn sm primary" onClick={save}>만들기</button>
        </>
      }
    >
      <div class="sk-form">
        <label>
          이름 <span class="muted">영문, 숫자, - 만{id() && id() !== name() ? ` · ${id()}` : ""}</span>
          <input class="input" placeholder="release-notes" value={name()} onInput={(e) => (setName(e.currentTarget.value), setErr(""))} />
        </label>
        <label>
          설명
          <input class="input" placeholder="릴리스 노트를 쓸 때. 바뀐 점을 사용자 말로 정리해요" value={desc()} onInput={(e) => (setDesc(e.currentTarget.value), setErr(""))} />
        </label>
        <label>
          본문
          <textarea class="sk-edit" spellcheck={false} placeholder={"# 릴리스 노트\n\n1. git log로 지난 태그 이후 커밋을 봐요\n2. ..."} value={body()} onInput={(e) => setBody(e.currentTarget.value)} />
        </label>
      </div>
    </Sheet>
  );
}

export function SkillsTab() {
  const [files, { refetch }] = createResource(async () => {
    const list = await skillList();
    // descriptions come from each SKILL.md
    return Promise.all(
      list.map(async (f: SkillFile) => {
        const t = await fsRead(f.path).catch(() => ({ text: "" }));
        return { f, description: parseSkill(t.text ?? "").description ?? "" };
      }),
    );
  });
  const [open, setOpen] = createSignal<Entry | null>(null);
  const [adding, setAdding] = createSignal(false);
  // every skill is always given to jobs and offered in the menu
  onMount(() => {
    if (state.skills.some((s) => !s.enabled || !s.menu)) setState("skills", () => true, (s) => ({ ...s, enabled: true, menu: true }));
  });
  const ondra = createMemo<Entry[]>(() =>
    (files() ?? []).map(({ f, description }) => ({
      key: `o:${f.name}`,
      name: f.name,
      description,
      path: f.path,
      kind: f.overridden ? "changed" : "bundled",
    })),
  );
  const mine = createMemo<Entry[]>(() =>
    state.skills.map((s) => ({
      key: `i:${s.path}`,
      name: s.name,
      description: s.description,
      path: mdOf(s.path),
      statePath: s.path,
      kind: madeHere(s.path) ? "mine" : "imported",
      from: madeHere(s.path) ? undefined : s.source,
    })),
  );
  const Row = (p: { e: Entry }) => (
    <div class="item-row sk-row" role="button" tabIndex={0} onClick={() => setOpen(p.e)} onKeyDown={(ev) => ev.key === "Enter" && setOpen(p.e)}>
      <Icon name="skill" size={15} class="muted" />
      <div class="item-main">
        <b>{p.e.name}</b>
        <Show when={p.e.description}><p title={p.e.description}>{p.e.description}</p></Show>
      </div>
      <Show when={p.e.kind === "changed" || p.e.kind === "imported"}><span class="pill">{p.e.kind === "imported" ? `${FROM[p.e.from ?? ""] ?? p.e.from ?? "가져옴"}에서` : KIND_LABEL[p.e.kind]}</span></Show>
      <Icon name="chevron" size={13} class="muted" />
    </div>
  );
  return (
    <>
      <h2>스킬</h2>
      <div class="set-group-title">기본 포함</div>
      <div class="set-group">
        <For each={ondra()} fallback={<div class="empty-line">{files.loading ? "불러오는 중이에요" : "스킬이 없어요"}</div>}>
          {(e) => <Row e={e} />}
        </For>
      </div>
      <div class="set-group-title" style={{ display: "flex", "align-items": "center" }}>
        내 스킬
        <span class="spacer" />
        <button class="btn ghost sm" onClick={() => setAdding(true)}><Icon name="plus" size={13} />새 스킬</button>
      </div>
      <div class="set-group">
        <For each={mine()} fallback={<div class="empty-line">없음</div>}>
          {(e) => <Row e={e} />}
        </For>
      </div>
      <Show when={open()}>
        {(e) => <SkillSheet entry={e()} onClose={() => setOpen(null)} onChanged={() => void refetch()} />}
      </Show>
      <Show when={adding()}>
        <NewSkill onClose={() => setAdding(false)} onChanged={() => void refetch()} taken={[...ondra(), ...mine()].map((e) => e.name)} />
      </Show>
    </>
  );
}
