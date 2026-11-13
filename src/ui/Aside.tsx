// btw card (above the input) and the side chat (a panel tab).
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { state, taskById } from "../state/store";
import { skillsIn } from "../engine/memory";
import type { SpaceId } from "../state/types";
import { askBtw, btw, btwIndex, btwList, clearSide, closeBtw, continueInSide, sendSide, showBtw, sideOf, sideRunning } from "../engine/aside";
import { agoIn, midTrim } from "./bits";
import { throwThought } from "../engine/captain";
import { NO_ACCOUNT, tell } from "../engine/tasks";
import { goMain, openPanel, toast } from "../state/ui";
import { addProject, projectsIn } from "../state/store";
import { fileSrc, pickFolder } from "../lib/native";
import { ignoredKey, noModifiers, shortcutHint, shortcutOverlay } from "../lib/shortcuts";
import { menuSkills } from "../engine/skillMenu";
import { tilde } from "../engine/rpc";
import { isImage, withFiles, type PlusItem } from "./Composer";
import { openImage } from "./Lightbox";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { lineOf } from "../views/SkillsTab";
import { t } from "../i18n";

/** The btw card: the one being looked at, with ‹ › through earlier ones. */
/** What went wrong with an aside question. No account reads as everywhere else; the notice over
 *  the input has the one 계정 추가 button. */
function ErrLine(props: { text?: string }) {
  const none = () => !!props.text && (props.text === NO_ACCOUNT || props.text === t(NO_ACCOUNT));
  return <span class="btw-err">{none() ? t("계정 없음|notice") : props.text}</span>;
}

export function BtwCard(props: { scope: string }) {
  // Esc closes the card first, before it blurs the input or closes the panel
  // (an open "/" or "@" list in the input still closes before it)
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || ignoredKey(e) || !noModifiers(e) || !btw() || shortcutOverlay()) return;
    e.preventDefault();
    e.stopPropagation();
    closeBtw();
  };
  window.addEventListener("keydown", esc, true);
  onCleanup(() => window.removeEventListener("keydown", esc, true));
  const forward = () => {
    const x = btw();
    if (!x) return;
    const said = withFiles(x.question, x.files ?? []);
    if (props.scope.startsWith("task:")) void tell(props.scope.slice(5), said);
    else {
      const [space, project] = props.scope.slice(5).split("~");
      throwThought(said, space as SpaceId, { project });
    }
    closeBtw();
  };
  // go on talking about it in the side chat, with the question and answer carried over
  const toSide = () => {
    const x = btw();
    if (!x) return;
    const space = (x.scope.startsWith("task:") ? taskById(x.scope.slice(5))?.space : x.scope.slice(5).split("~")[0]) ?? state.space;
    continueInSide(space as SpaceId, withFiles(x.question, x.files ?? []), x.answer);
    closeBtw();
    openPanel("side");
    setTimeout(() => document.getElementById("side-input")?.focus(), 60);
  };
  // copied: the button says so for a moment, in place of a toast
  const [copied, setCopied] = createSignal(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        clearTimeout(copyTimer);
        copyTimer = setTimeout(() => setCopied(false), 1400);
      },
      () => toast(t("복사하지 못했어요"), "bad"),
    );
  };
  onCleanup(() => clearTimeout(copyTimer));
  const where = (scope: string) => {
    if (scope.startsWith("task:")) return taskById(scope.slice(5))?.title ?? t("작업");
    const p = scope.slice(5).split("~")[1];
    return p ? (projectsIn(state.space).find((x) => x.id === p)?.name ?? p) : t("메인");
  };
  return (
    <Show when={btw()}>
      {(x) => (
        <div class="btw-card" role="status">
          <div class="btw-head">
            <span class="btw-tag" title={t("짧은 질문")}>btw</span>
            <span class="btw-q" title={x().question}>{x().question}</span>
            <Show when={btwList().length > 1}>
              <span class="btw-nav">
                <button class="icon-btn sm" title={t("이전")} disabled={btwIndex() === 0} onClick={() => showBtw((btwIndex() ?? 0) - 1)}>
                  <Icon name="back" size={13} />
                </button>
                <span class="btw-n">{(btwIndex() ?? 0) + 1}/{btwList().length}</span>
                <button class="icon-btn sm" title={t("다음")} disabled={btwIndex() === btwList().length - 1} onClick={() => showBtw((btwIndex() ?? 0) + 1)}>
                  <Icon name="arrow" size={13} />
                </button>
              </span>
            </Show>
            <button class="icon-btn sm" title={`${t("닫기")} (esc)`} onClick={closeBtw}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div class="btw-body">
            <Show when={x().files?.length}>
              <div class="btw-files">
                <For each={x().files}>
                  {(f) => (
                    <Show when={isImage(f)} fallback={<span class="btw-file" title={f}>{f.split("/").pop()}</span>}>
                      <img src={fileSrc(f)} alt={f.split("/").pop()} onClick={() => openImage(f, (x().files ?? []).filter(isImage))} />
                    </Show>
                  )}
                </For>
              </div>
            </Show>
            <Show when={x().answer} fallback={<Show when={x().pending} fallback={<ErrLine text={x().error} />}><span class="btw-wait"><span class="tk-run" />{t("보는 중")}</span></Show>}>
              <Markdown class="msg-text" text={x().answer} />
            </Show>
          </div>
          <Show when={!x().pending && x().answer}>
            <div class="btw-foot">
              <span class="btw-note" title={t("대화에는 남지 않아요")}>{where(x().scope)} · {agoIn(x().at)}</span>
              <span class="spacer" />
              <button class="btw-act" title={t("답 복사")} onClick={() => copy(x().answer)}>
                <Icon name={copied() ? "check" : "copy"} size={13} />
                {copied() ? t("복사했어요") : t("복사")}
              </button>
              <button class="btw-act" title={`${t("사이드 채팅으로 이어가기")} ${shortcutHint("side")}`} onClick={toSide}>
                <Icon name="message" size={13} />
                {t("사이드 채팅")}
              </button>
              <button class="btw-act main" onClick={forward}>
                <Icon name="handoff" size={13} />
                {props.scope.startsWith("task:") ? t("작업에 보내기") : t("메인에 보내기")}
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

/** "/btw <question>" in any composer. */
export const btwCommand = (scope: () => string) => ({
  name: "btw",
  get desc() {
    return t("짧은 질문");
  },
  icon: "bolt",
  files: true,
  run: (arg: string, _also?: string[], files: string[] = []) => {
    if (arg.trim() || files.length) void askBtw(scope(), arg, files);
    else if (!showBtw()) toast(t("btw 없음 · /btw 뒤에 질문을 적어요"));
  },
});

const SKILL_ASK = " 스킬로 해 줘 (일을 맡길 때 이 스킬을 쓰라고 적어 줘)";
/** A main request made with /skill:…: the skills it names and the user's own words (the instruction to main is not theirs to read). */
export function skillAsk(text: string): { skills: string[]; rest: string } {
  const m = text.match(/^((?:`[^`\n]+`(?:, )?)+) 스킬로 해 줘 \(일을 맡길 때 이 스킬을 쓰라고 적어 줘\)(?:: )?/);
  if (!m) return { skills: [], rest: text };
  return { skills: [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]), rest: text.slice(m[0].length) };
}

/** Menu skills as "/name" commands. In a job it runs there; in main it becomes a job that uses it. */
export const skillCommands = (target: () => { task?: string; space: SpaceId; project?: string }) =>
  menuSkills().map((sk) => ({
    name: `skill:${sk.name}`,
    // the same one line as Settings › 스킬 (ours, translated, for a bundled skill); no " · " when there is none
    get desc() {
      const line = lineOf({ name: sk.name, description: sk.description, kind: sk.from === "bundled" ? "bundled" : "mine" });
      return [sk.from === "bundled" ? t("기본 스킬") : t("스킬"), line].filter(Boolean).join(" · ");
    },
    icon: "skill",
    skill: true,
    run: (arg: string, also: string[] = []) => {
      const t = target();
      const names = [sk.name, ...also];
      if (t.task) void tell(t.task, `/skill:${sk.name} ${also.length ? `(also use the ${also.join(", ")} skill${also.length > 1 ? "s" : ""}) ` : ""}${arg}`.trim());
      else throwThought(`${names.map((n) => `\`${n}\``).join(", ")}${SKILL_ASK}${arg.trim() ? `: ${arg.trim()}` : ""}`, t.space, { project: t.project });
    },
  }));

/** After Whiteboard: ask a job to draw what it did, each part pointing at the code. */
export const DRAW_ASK =
  "방금까지 한 일을 그림 한 장으로 설명해 줘. 구조나 흐름이 보이는 그림(시퀀스·호출 흐름·바뀐 파일 관계 중 맞는 것)으로, 그림의 각 부분에 해당 파일:줄을 적고, 내가 정한 것과 네가 스스로 정한 것을 구분해서 표시해 줘. 결과물 폴더에 HTML 한 장으로 만들어 줘. 코드는 바꾸지 마.";
export const drawCommand = (task: () => string) => ({
  name: "draw",
  get desc() {
    return t("작업 흐름 그림");
  },
  icon: "canvas",
  run: () => void tell(task(), DRAW_ASK),
});

/** The + menu: projects (main only), skills, and the two side ways to talk. */
export function plusFor(where: { main?: boolean }): PlusItem[] {
  const out: PlusItem[] = [];
  if (where.main) {
    for (const p of projectsIn(state.space)) out.push({ section: t("프로젝트"), icon: "folder", label: p.name, desc: midTrim(tilde(p.folder), 24), run: () => goMain(p.id) });
    out.push({
      section: t("프로젝트"),
      icon: "plus",
      label: t("프로젝트 추가"),
      run: async () => {
        const dir = await pickFolder(t("프로젝트 폴더"));
        if (dir) goMain(addProject(state.space, dir));
      },
    });
  }
  for (const sk of skillsIn(state.space).filter((x) => x.menu))
    out.push({ section: t("스킬"), icon: "skill", label: sk.name, desc: lineOf({ name: sk.name, description: sk.description, kind: "mine" }) || undefined, run: ({ insert }) => insert(`/${sk.name} `) });
  out.push({ section: t("옆에서"), icon: "bolt", label: t("짧은 질문"), desc: "/btw", run: ({ insert }) => insert("/btw ") });
  out.push({ section: t("옆에서"), icon: "message", label: t("사이드 채팅"), keys: shortcutHint("side"), run: () => openPanel("side") });
  return out;
}

/** A second conversation, separate from the main one. */
export function SideChat() {
  const space = () => state.space;
  const msgs = () => sideOf(space());
  const [text, setText] = createSignal("");
  let box!: HTMLDivElement;
  let input!: HTMLTextAreaElement;
  createEffect(on(() => [msgs().length, msgs().slice(-1)[0]?.text], () => queueMicrotask(() => box && (box.scrollTop = box.scrollHeight))));
  const send = () => {
    const t = text().trim();
    if (!t || sideRunning(space())) return;
    setText("");
    input.style.height = "auto";
    void sendSide(space(), t);
  };
  return (
    <div class="side-chat">
      <Show when={msgs().length}>
        <div class="side-head">
          <span class="spacer" />
          <button class="link-btn" onClick={() => clearSide(space())}>{t("새 대화")}</button>
        </div>
      </Show>
      <div class="side-list" ref={box}>
        <Show when={!msgs().length}>
          <div class="side-empty">{t("작업과 상관없이 따로 묻는 대화예요")}</div>
        </Show>
        <For each={msgs()} >
          {(m) => (
            <Show
              when={m.from === "side"}
              fallback={<div class="side-me">{m.text}</div>}
            >
              <div class="side-reply">
                <Show when={m.text} fallback={<Show when={m.pending} fallback={<ErrLine text={m.error} />}><span class="btw-wait"><span class="tk-run" />{t("생각하는 중")}</span></Show>}>
                  <Markdown class="msg-text" text={m.text} />
                </Show>
                <Show when={!m.pending && m.text}>
                  <div class="side-acts">
                    <button class="link-btn" onClick={() => (void navigator.clipboard.writeText(m.text), toast(t("복사했어요")))}>{t("복사")}</button>
                    <button class="link-btn" onClick={() => (throwThought(`사이드챗에서 정리한 거예요. 이걸로 진행해 줘:\n\n${m.text}`, space()), toast(t("메인에 보냈어요")))}>{t("메인에 보내기")}</button>
                  </div>
                </Show>
              </div>
            </Show>
          )}
        </For>
      </div>
      <form
        class="side-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          id="side-input"
          placeholder={t("사이드 채팅에 묻기")}
          aria-label={t("사이드 채팅에 묻기")}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            e.currentTarget.style.height = "auto";
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (ignoredKey(e) || !noModifiers(e) || shortcutOverlay()) return;
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <button type="submit" class="send sm" disabled={!text().trim() || sideRunning(space())} aria-label={t("보내기")}>
          <Icon name="send" size={14} stroke={2.25} />
        </button>
      </form>
    </div>
  );
}
