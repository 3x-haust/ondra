// A settings tab of this device as another device's Settings shows it, when that device picked this
// one (engine/remote.ts settingsPage): read here, written in that device's language, seen there and
// changed here. Names only where a value is kept away (secrets, the services' keys).
import { fsRead, hooksLoad, petList, secretList, skillList, toolStatus } from "../lib/native";
import { ownSpaces, state } from "../state/store";
import { emails } from "../state/limits";
import { inLang, t, type Lang } from "../i18n";
import { accountName, service } from "../ui/AccountPicker";
import { hostState } from "../ui/ComputerPicker";
import { ago } from "../ui/bits";
import { remote } from "../engine/remote";
import { readServers, type Server } from "../engine/services";
import { routineLine } from "../engine/routines";
import { describeWhen } from "../engine/routineTime";
import { petConfig, PET_SIZE } from "../engine/pet";
import { BUILTIN, parseSpec } from "../pet/spec";
import { changed } from "../lib/keybindings";
import { overrides } from "../lib/shortcuts";
import { menuHidden } from "../engine/skillMenu";
import { loadWorkerTools } from "./contextData";
import { groupsOf, toolOn } from "./Tools";
import { EVENTS, type Hook } from "./Hooks";
import { FROM, KIND_LABEL, lineOf, parseSkill } from "./SkillsTab";
import { keyRows } from "./Settings";
import { keyText } from "./ShortcutSheet";
import type { SettingsTab } from "../state/ui";

/** one line of the page: its name, a line under it, what it is set to at the right; dimmed when off */
export interface FarRow { title: string; sub?: string; value?: string; off?: boolean }
/** a tab as another device shows it: its groups, or the one line said when there is nothing to show */
export interface FarPage { groups: { title?: string; rows: FarRow[] }[]; empty?: string }

const onOff = (on: boolean) => (on ? t("켜짐") : t("꺼짐"));
const spaceLabel = (id: string) => t(ownSpaces().find((s) => s.id === id)?.label ?? id);
/** per workspace of this device's own, the ones with rows; one workspace: no titles */
const bySpace = (rows: (space: string) => FarRow[]): FarPage["groups"] => {
  const out = ownSpaces().map((s) => ({ title: t(s.label), rows: rows(s.id) })).filter((g) => g.rows.length);
  return ownSpaces().length > 1 ? out : out.map((g) => ({ rows: g.rows }));
};
const page = (groups: FarPage["groups"], empty: string): FarPage => (groups.some((g) => g.rows.length) ? { groups } : { groups: [], empty });

/** what each tab reads (`load`, may wait) and how it reads as lines (`rows`, in that device's language) */
interface Builder<D> { load: () => Promise<D>; rows: (d: D) => FarPage }
const builder = <D,>(b: Builder<D>) => b as Builder<unknown>;
const none = async () => undefined;

const PAGES: Partial<Record<SettingsTab, Builder<unknown>>> = {
  accounts: builder({
    load: none,
    rows: () =>
      page(
        bySpace((space) =>
          state.accounts
            .filter((a) => a.space === space)
            .map((a) => ({
              title: accountName(a, true),
              sub: [...new Set(a.providers.map(service))].concat(emails[a.id] ? [emails[a.id]] : []).join(" · ") || undefined,
              value: a.providers.length ? a.model || t("자동") : t("로그인 필요"),
              off: !a.providers.length,
            })),
        ),
        t("연결한 계정이 없어요"),
      ),
  }),
  remote: builder({
    load: none,
    rows: () => {
      const hosts = state.settings.hosts ?? [];
      const live = new Set(Object.values(remote().live).map((d) => d.id));
      const rows: FarRow[] = [
        ...hosts.map((h) => ({ title: h.name, value: hostState(h.id) })),
        ...remote()
          .devices.filter((d) => !hosts.some((h) => h.id === d.id))
          .map((d) => ({ title: d.name, value: live.has(d.id) ? t("연결됨") : t("{ago} 접속", { ago: ago(d.lastSeen) }) })),
      ];
      return { groups: [{ title: t("연결된 기기"), rows }, { rows: [{ title: t("잠자기 방지"), value: onOff(!!state.settings.remoteAwake) }] }].filter((g) => g.rows.length) };
    },
  }),
  pet: builder({
    load: () => petList().catch(() => []),
    rows: (list: { id: string; json: string }[]) => {
      const cfg = petConfig();
      const pets = [BUILTIN, ...list.map((p) => parseSpec(p.id, p.json, (f) => f)).filter((p) => !!p)];
      return {
        groups: [
          { rows: [{ title: t("화면에 펫 띄우기"), value: onOff(cfg.on) }] },
          {
            title: t("펫 고르기"),
            rows: pets.map((p) => {
              const on = cfg.ids.includes(p.id);
              return { title: cfg.names?.[p.id] || p.name, value: on ? t("크기 {n}", { n: cfg.sizes?.[p.id] ?? cfg.size ?? PET_SIZE }) : undefined, off: !on };
            }),
          },
        ],
      };
    },
  }),
  "agent-tools": builder({
    load: () => loadWorkerTools(),
    rows: (c: Awaited<ReturnType<typeof loadWorkerTools>>) => ({
      groups: groupsOf(c).map((g) => ({
        title: t(g.title),
        rows: g.rows.map((r) => ({ title: r.name, sub: r.line || undefined, value: r.tool ? (r.optional || r.mcp ? onOff(toolOn(r)) : t("항상 켜짐")) : undefined, off: !toolOn(r) })),
      })),
    }),
  }),
  services: builder({
    load: async () => Object.fromEntries(await Promise.all(ownSpaces().map(async (s) => [s.id, await readServers(s.id)] as const))),
    // the name and whether it is on: its address, keys and command stay here
    rows: (all: Record<string, Record<string, Server>>) =>
      page(bySpace((space) => Object.entries(all[space] ?? {}).map(([name, s]) => ({ title: name, value: onOff(s?.enabled !== false), off: s?.enabled === false }))), t("연결한 서비스가 없어요")),
  }),
  skills: builder({
    load: async () => {
      const files = await skillList().catch(() => []);
      return Promise.all(files.map(async (f) => ({ f, text: (await fsRead(f.path).catch(() => ({ text: "" }))).text ?? "" })));
    },
    rows: (files: { f: { name: string; overridden: boolean }; text: string }[]) => {
      const bundled = files.map(({ f, text }) => {
        const kind = f.overridden ? ("changed" as const) : ("bundled" as const);
        return { title: f.name, sub: lineOf({ name: f.name, description: parseSkill(text).description ?? "", kind }) || undefined, value: f.overridden ? t(KIND_LABEL.changed) : undefined, auto: menuHidden(text) };
      });
      const mine = state.skills.map((s) => ({ title: s.name, sub: lineOf({ name: s.name, description: s.description, kind: "mine" }) || undefined, value: s.source === "ondra" ? undefined : (FROM[s.source] ?? s.source) }));
      return {
        groups: [
          { title: t("내 스킬"), rows: mine },
          { title: t("기본"), rows: bundled.filter((b) => !b.auto).map(({ auto: _, ...r }) => r) },
          { title: t("기본 · 알아서 써요"), rows: bundled.filter((b) => b.auto).map(({ auto: _, ...r }) => r) },
        ].filter((g) => g.rows.length),
      };
    },
  }),
  hooks: builder({
    load: async () => {
      const v = JSON.parse(await hooksLoad().catch(() => "[]"));
      return (Array.isArray(v) ? v : []) as Hook[];
    },
    rows: (list: Hook[]) =>
      page(
        [
          {
            rows: list.map((h) => ({
              title: [t(EVENTS.find((e) => e.id === h.event)?.label ?? h.event), h.matcher].filter(Boolean).join(" · "),
              sub: h.command || undefined,
              value: h.space ? spaceLabel(h.space) : t("모든 워크스페이스"),
              off: !h.enabled,
            })),
          },
        ],
        t("훅 없음"),
      ),
  }),
  routines: builder({
    load: none,
    rows: () =>
      page(
        bySpace((space) =>
          (state.routines ?? [])
            .filter((r) => r.space === space && !r.agent && !r.draft)
            .map((r) => ({ title: r.title, sub: describeWhen(r.when), value: routineLine(r), off: !r.enabled })),
        ),
        t("루틴 없음"),
      ),
  }),
  // names only: a value never leaves this device
  secrets: builder({
    load: () => secretList(),
    rows: (s: Awaited<ReturnType<typeof secretList>>) =>
      page(
        [
          { title: t("모든 작업"), rows: s.global.map((n) => ({ title: n })) },
          ...Object.entries(s.projects).map(([id, names]) => ({ title: (state.projects ?? []).find((p) => p.id === id)?.name ?? t("지운 프로젝트"), rows: names.map((n) => ({ title: n })) })),
        ].filter((g) => g.rows.length),
        t("저장한 시크릿이 없어요"),
      ),
  }),
  tools: builder({
    load: () => (/Macintosh/.test(navigator.userAgent) ? toolStatus() : Promise.resolve(undefined)),
    rows: (s: Awaited<ReturnType<typeof toolStatus>> | undefined) => {
      if (!s) return { groups: [], empty: t("이 기기에는 macOS 권한이 없어요") };
      const perm = (on: boolean | undefined) => (on ? t("허용됨") : t("허용 필요"));
      return { groups: [{ rows: [{ title: t("손쉬운 사용"), value: perm(s.accessibility) }, { title: t("화면 기록"), value: perm(s.screenRecording) }] }] };
    },
  }),
  import: builder({ load: none, rows: () => ({ groups: [], empty: t("가져오기는 그 기기에서 해요") }) }),
  // the keys changed from the default, as this device's keyboard writes them
  shortcuts: builder({
    load: none,
    rows: () => {
      const o = overrides();
      return page([{ rows: keyRows().filter((r) => changed(o, r.id)).map((r) => ({ title: r.label, sub: r.section, value: keyText(r.id) })) }], t("기본 단축키 그대로예요"));
    },
  }),
};

/** a tab of this device's settings, for another device, in its language `l` */
export async function farPage(tab: string, l: Lang): Promise<FarPage> {
  const b = PAGES[tab as SettingsTab];
  if (!b) throw new Error("bad request");
  const data = await b.load();
  return inLang(l, () => b.rows(data));
}
