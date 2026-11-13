// What can be done with a Mac in Settings › 연결, the same words wherever it's offered (the
// settings rows, the Mac bar): 연결 끊기 is for now and asks nothing; 제거 forgets it and asks first.
import { disconnectHost, hostName, reconnect, removeHost } from "../engine/hosts";
import { forgetDevice, remote } from "../engine/remote";
import { jobsFrom } from "../engine/remoteRules";
import { state } from "../state/store";
import { toast } from "../state/ui";
import { confirmAsk, type MenuItem } from "./taskMenu";
import { t } from "../i18n";

/** a Mac this one works on: 연결 끊기, or 다시 연결 when it's disconnected */
export function hostConnectItem(id: string): MenuItem {
  return state.settings.hosts?.find((h) => h.id === id)?.off
    ? { id: "reconnect", label: t("다시 연결"), icon: "refresh", run: () => reconnect(id) }
    : { id: "disconnect", label: t("연결 끊기"), icon: "unplug", run: () => disconnectHost(id) };
}

/** 제거 a Mac this one works on: its projects and jobs go from here, and it forgets this Mac */
export function askRemoveHost(id: string) {
  const name = hostName(id);
  confirmAsk({
    title: t("{name}을(를) 제거할까요?", { name }),
    body: t("그 Mac의 프로젝트와 작업이 여기서 사라지고, 그 Mac에서도 이 Mac이 빠져요"),
    action: t("제거"),
    danger: true,
    run: () => {
      removeHost(id);
      toast(t("{name}을(를) 제거했어요", { name }));
    },
  });
}

/** 제거 a Mac allowed in: it can't come in anymore; the jobs it asked for here keep running */
export function askForgetDevice(id: string) {
  const name = remote().devices.find((d) => d.id === id)?.name ?? "Mac";
  const n = jobsFrom(state.tasks, id).length;
  confirmAsk({
    title: t("{name}을(를) 제거할까요?", { name }),
    body: n ? t("그 Mac에서 이 Mac을 더 쓸 수 없어요 · 그 Mac에서 시킨 작업 {n}개는 계속 돌아요", { n }) : t("그 Mac에서 이 Mac을 더 쓸 수 없어요"),
    action: t("제거"),
    danger: true,
    run: () => void forgetDevice(id),
  });
}
