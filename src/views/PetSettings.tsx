// Settings › 펫: the pets on the screen (on or off, which ones, how big each one is), each pet's name and
// throwing one away, sharing one as a file (and taking one in), and a new pet made by a job from a character's
// name (skills/pet-maker).
import { createResource, createSignal, For, Show } from "solid-js";
import { fileSrc, petDelete, petExport, petImport, petList, pickFiles, revealPath, revealLabel } from "../lib/native";
import { PET_SIZE, petConfig, pickPet, wearPet } from "../engine/pet";
import { BUILTIN, parseSpec, type PetSpec } from "../pet/spec";
import { setState, state } from "../state/store";
import { goMain, toast } from "../state/ui";
import { fillDraft } from "../ui/Composer";
import { chatKey } from "../engine/captain";
import { confirmAsk, ctxFor, openMenuAt } from "../ui/taskMenu";
import { Icon } from "../ui/Icon";
import { t } from "../i18n";
import { GroupTitle, PageHead, Row, Switch_ } from "./Settings";

/** "make a pet" the way a skill is asked for: the main chat's input gets the pet skill and words to send, the
 *  words picked so a character's name typed replaces them (sent as is, it makes one that suits the user) */
const PET_SKILL = "/skill:pet-maker ";
export const petWords = () => t("나에 대해 아는 걸 바탕으로 어울리는 펫을 만들어서 화면에 띄워 줘");
function draftPet() {
  const words = petWords();
  goMain();
  fillDraft(`main:${chatKey(state.space)}`, PET_SKILL + words, [PET_SKILL.length, PET_SKILL.length + words.length]);
}

/** a pet's name: the one the user gave it, else its own */
const petName = (p: PetSpec) => state.settings.pet?.names?.[p.id] || p.name;

export function PetSettings() {
  // read again when a pet was made (or made again)
  const [pets, { refetch }] = createResource(() => state.settings.pet?.v ?? 0, async () => {
    const list = await petList().catch(() => []);
    return [BUILTIN, ...list.map((p) => parseSpec(p.id, p.json, (f) => `${fileSrc(`${p.dir}/${f}`)}?v=${state.settings.pet?.v ?? 0}`)).filter((p) => !!p)];
  });
  const [renaming, setRenaming] = createSignal<string | null>(null);
  // each pet its own height (a big character and a small one side by side); one never set: the shared size
  const sizeOf = (id: string) => state.settings.pet?.sizes?.[id] ?? state.settings.pet?.size ?? PET_SIZE;
  const resize = (id: string, n: number) => setState("settings", "pet", { ...petConfig(), sizes: { ...(state.settings.pet?.sizes ?? {}), [id]: n } });
  const set = (patch: Partial<{ on: boolean }>) => setState("settings", "pet", { ...petConfig(), names: state.settings.pet?.names, ...patch });
  const rename = (id: string, name: string) => {
    if (renaming() !== id) return;
    const names = { ...(state.settings.pet?.names ?? {}) };
    if (name.trim()) names[id] = name.trim().slice(0, 40);
    else delete names[id];
    setState("settings", "pet", { ...petConfig(), names });
    setRenaming(null);
  };
  // a pet as one file (<name>.ondrapet in Downloads) to send; one sent taken in and put on screen
  const share = async (p: PetSpec) => {
    try {
      const path = await petExport(p.id);
      toast(t("다운로드 폴더에 저장했어요: {file}", { file: path.split("/").pop() ?? path }), "info", { label: revealLabel(), run: () => void revealPath(path) });
    } catch (e) {
      toast(String(e), "bad");
    }
  };
  const take = async () => {
    const files = await pickFiles(t("가져올 펫 파일(.ondrapet)을 골라 주세요"));
    let got = 0;
    for (const f of files) {
      try {
        wearPet(await petImport(f));
        got++;
      } catch (e) {
        toast(`${f.split("/").pop()}: ${String(e)}`, "bad");
      }
    }
    if (got) {
      toast(t("펫 {n}마리를 가져와서 화면에 띄웠어요", { n: got }));
      void refetch();
    }
  };
  const remove = (p: PetSpec) =>
    confirmAsk({
      title: t("이 펫을 삭제할까요?"),
      body: t("{name}의 그림이 지워져요", { name: petName(p) }),
      action: t("삭제"),
      danger: true,
      run: async () => {
        try {
          await petDelete(p.id);
        } catch (e) {
          return toast(String(e), "bad");
        }
        const ids = petConfig().ids.filter((x) => x !== p.id);
        const names = { ...(state.settings.pet?.names ?? {}) };
        const sizes = { ...(state.settings.pet?.sizes ?? {}) };
        delete names[p.id];
        delete sizes[p.id];
        setState("settings", "pet", { ...petConfig(), ids: ids.length ? ids : ["default"], names, sizes });
        void refetch();
      },
    });

  return (
    <>
      <PageHead tab="pet" />
      <div class="set-group">
        <Row title={t("화면에 펫 띄우기")} desc={t("화면 위를 돌아다니다가, 작업이 끝나거나 물어볼 게 생기면 알려 줘요")}>
          <Switch_ label={t("화면에 펫 띄우기")} on={!!state.settings.pet?.on} set={(v) => set({ on: v })} />
        </Row>
        <For each={petConfig().ids}>
          {(id) => {
            const name = () => {
              const p = (pets() ?? [BUILTIN]).find((x) => x.id === id);
              return p ? petName(p) : id;
            };
            const title = () => (petConfig().ids.length > 1 ? t("{name} 크기", { name: name() }) : t("펫 크기"));
            return (
              <Row title={title()}>
                <div class="set-volume">
                  <input type="range" min={48} max={160} step={4} aria-label={title()} value={sizeOf(id)} onInput={(e) => resize(id, Number(e.currentTarget.value))} />
                  <span class="set-volume-n">{sizeOf(id)}</span>
                </div>
              </Row>
            );
          }}
        </For>
      </div>

      <GroupTitle title={t("펫 고르기")} />
      <div class="pet-list" role="group" aria-label={t("펫 고르기")}>
        <For each={pets() ?? [BUILTIN]}>
          {(p) => {
            const on = () => petConfig().ids.includes(p.id);
            const menu = (e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              openMenuAt(
                `pet:${p.id}`,
                () => [
                  { id: "rename", label: t("이름 바꾸기"), icon: "pencil", run: () => setRenaming(p.id) },
                  ...(p.id === "default"
                    ? []
                    : [
                        { id: "share", label: t("파일로 내보내기"), icon: "download", run: () => void share(p) },
                        { id: "delete", label: t("삭제"), icon: "trash", danger: true, run: () => remove(p) },
                      ]),
                ],
                e.type === "contextmenu" ? e : (e.currentTarget as HTMLElement).getBoundingClientRect(),
              );
            };
            return (
              <div class="pet-card" classList={{ on: on(), ctx: ctxFor() === `pet:${p.id}` }} onContextMenu={menu}>
                <button class="pet-card-pick" aria-pressed={on()} title={on() ? t("화면에서 내리기") : t("화면에 띄우기")} onClick={() => pickPet(p.id)}>
                  <img src={p.actions.idle} alt="" draggable={false} />
                  <Show when={on()}>
                    <span class="pet-card-on" aria-hidden="true">
                      <Icon name="check" size={12} />
                    </span>
                  </Show>
                </button>
                <div class="pet-card-foot">
                  <Show
                    when={renaming() === p.id}
                    fallback={
                      <span class="pet-card-name" title={petName(p)} onDblClick={() => setRenaming(p.id)}>
                        {petName(p)}
                      </span>
                    }
                  >
                    <input
                      class="input pet-card-input"
                      aria-label={t("이름 바꾸기")}
                      value={petName(p)}
                      ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
                      onKeyDown={(e) => {
                        if (e.isComposing) return;
                        if (e.key === "Enter") rename(p.id, e.currentTarget.value);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(e) => rename(p.id, e.currentTarget.value)}
                    />
                  </Show>
                  <button class="pet-card-more" aria-label={t("{name} 메뉴", { name: petName(p) })} onClick={menu}>
                    <Icon name="more" size={14} />
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </div>

      <GroupTitle title={t("새 펫 만들기")} />
      <div class="set-group">
        <Row title={t("새 펫 만들기")} desc={t("입력창에 펫 만들기 스킬과 할 말이 채워져요. 캐릭터 이름으로 바꿔 보내면 작업이 그림을 찾아 펫으로 만들어요 (픽셀로도 돼요)")}>
          <button class="btn sm" onClick={draftPet}>
            <Icon name="pet" size={14} />
            {t("만들기")}
          </button>
        </Row>
        <Row title={t("파일에서 가져오기")} desc={t("다른 사람이 보낸 펫 파일(.ondrapet)을 펫으로 추가해요. 펫은 ⋯ 메뉴의 「파일로 내보내기」로 보낼 수 있어요")}>
          <button class="btn sm" onClick={() => void take()}>
            <Icon name="open" size={14} />
            {t("가져오기")}
          </button>
        </Row>
      </div>
    </>
  );
}
