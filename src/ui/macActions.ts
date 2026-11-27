// What can be done with a device in Settings › 연결, the same words wherever it's offered (the
// settings rows, the Mac bar): 연결 끊기 is for now and asks nothing; 제거 forgets it, both ways, and asks first.
import { disconnectHost, reconnect } from "../engine/hosts";
import { dropDevice, removeDevice, remote } from "../engine/remote";
import { jobsFrom } from "../engine/remoteRules";
import { state } from "../state/store";
import { confirmAsk, type MenuItem } from "./taskMenu";
import { t } from "../i18n";

/** 연결 끊기 (both ways, for now), or 다시 연결 when it's disconnected */
export function hostConnectItem(id: string): MenuItem {
  return state.settings.hosts?.find((h) => h.id === id)?.off
    ? { id: "reconnect", label: t("다시 연결"), icon: "refresh", run: () => reconnect(id) }
    : { id: "disconnect", label: t("연결 끊기"), icon: "unplug", run: () => (disconnectHost(id), dropDevice(id)) };
}

/** 제거 a device: both ways. Its projects and jobs go from here, it can't use this one anymore, and it
 *  forgets this one too; the jobs it asked for here keep running */
export function askRemoveDevice(id: string) {
  const name = state.settings.hosts?.find((h) => h.id === id)?.name ?? remote().devices.find((d) => d.id === id)?.name ?? t("기기");
  const n = jobsFrom(state.tasks, id).length;
  const body = t("두 기기 모두 서로를 더 쓸 수 없어요");
  confirmAsk({
    title: t("{name}을(를) 제거할까요?", { name }),
    body: n ? `${body} · ${t("그 기기에서 시킨 작업 {n}개는 계속 돌아요", { n })}` : body,
    action: t("제거"),
    danger: true,
    run: () => void removeDevice(id),
  });
}
