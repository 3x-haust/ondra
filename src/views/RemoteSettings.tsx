// Settings › 원격 제어: turn it on, add a phone with a QR, see and cut off devices.
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { inTauri, remoteHostName, remoteLanIp } from "../lib/native";
import { state } from "../state/store";
import { newPairing, remote, revokeDevice, setRemoteOn, stopPairing } from "../engine/remote";
import { ago } from "../ui/bits";
import { Icon } from "../ui/Icon";
import { Row, Switch_ } from "./Settings";
import { t } from "../i18n";

/** Where the phone's page lives: the page served on this Wi-Fi in a dev build, else the published one. */
async function webBase(): Promise<string> {
  const set = import.meta.env.VITE_REMOTE_WEB as string | undefined;
  if (set && set !== "lan") return set;
  if (set === "lan" || import.meta.env.DEV) {
    const ip = await remoteLanIp();
    return `http://${ip ?? "localhost"}:4740/`;
  }
  return "https://3x-haust.github.io/ondra/remote/";
}

function Pairing() {
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));
  const [mac] = createResource(remoteHostName);
  const [base] = createResource(webBase);
  const link = () => {
    const r = remote();
    if (!r.id || !r.pair || !base()) return undefined;
    return `${base()}#m=${r.id}&p=${r.pair.code}&n=${encodeURIComponent(mac() ?? "Mac")}`;
  };
  const [qr] = createResource(link, (l) => (inTauri ? invoke<string>("remote_qr", { text: l }) : Promise.resolve("")));
  const left = () => Math.max(0, (remote().pair?.until ?? 0) - now());
  createEffect(() => remote().pair && left() === 0 && newPairing());
  const mmss = () => {
    const s = Math.ceil(left() / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <div class="rc-pair">
      <div class="rc-qr" aria-label={t("연결 QR")}>
        <Show when={remote().id && qr()} fallback={<div class="rc-qr-wait"><span class="spin" />{t("연결 준비 중")}</div>}>
          <div class="rc-qr-code" innerHTML={qr()} />
        </Show>
      </div>
      <div class="rc-steps">
        <b>{t("폰 추가")}</b>
        <ol>
          <li>{t("폰 카메라로 QR을 찍어요")}</li>
          <li>{t("열린 페이지에서 연결을 눌러요")}</li>
          <li>{t("여기서 허용을 눌러요")}</li>
        </ol>
        <div class="rc-pair-foot">
          <span class="muted">{t("{t} 뒤 만료", { t: mmss() })}</span>
          <button class="link-btn" onClick={newPairing}>{t("새 코드")}</button>
          <button class="link-btn" onClick={() => link() && void navigator.clipboard.writeText(link()!)}>{t("링크 복사")}</button>
          <button class="link-btn" onClick={stopPairing}>{t("닫기")}</button>
        </div>
      </div>
    </div>
  );
}

export function RemoteSettings() {
  const live = (id: string) => Object.values(remote().live).some((d) => d.id === id);
  return (
    <>
      <h2>{t("원격 제어")}</h2>
      <p class="lead">{t("폰에서 작업을 보고, 지시하고, 멈춰요. 허용한 기기만 들어오고, 오가는 내용은 끝까지 암호화돼요.")}</p>
      <div class="set-group">
        <Row title={t("원격 제어 켜기")}>
          <Switch_ on={!!state.settings.remote} set={(v) => void setRemoteOn(v)} label={t("원격 제어 켜기")} />
        </Row>
      </div>
      <Show when={state.settings.remote}>
        <Show when={remote().pair} fallback={
          <div class="set-group">
            <Row title={t("폰 추가")}>
              <button class="btn sm" onClick={newPairing}><Icon name="plus" size={13} />{t("QR 보기")}</button>
            </Row>
          </div>
        }>
          <div class="set-group"><Pairing /></div>
        </Show>
        <div class="set-group-title">{t("기기")}</div>
        <div class="set-group">
          <Show when={remote().devices.length} fallback={<div class="set-row"><span class="muted">{t("아직 연결한 기기가 없어요")}</span></div>}>
            <For each={remote().devices}>
              {(d) => (
                <div class="set-row rc-device">
                  <div class="set-label">
                    <Icon name="phone" size={15} class="muted" />
                    <b>{d.name}</b>
                    <span class="muted">{live(d.id) ? t("연결됨") : t("{ago} 접속", { ago: ago(d.lastSeen) })}</span>
                  </div>
                  <div class="set-value">
                    <Show when={live(d.id)}><span class="rc-live" aria-hidden="true" /></Show>
                    <button class="btn sm ghost" onClick={() => revokeDevice(d.id)}>{t("연결 끊기")}</button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </>
  );
}

/** A phone asking to be let in: asked wherever the user is, until they say yes or no. */
export function PairAskDialog() {
  const ask = () => remote().asks[0];
  return (
    <Show when={ask()}>
      {(a) => (
        <div class="rc-ask" role="alertdialog" aria-label={t("기기 연결 요청")}>
          <Icon name="phone" size={18} />
          <div class="rc-ask-main">
            <b>{t("{name}에서 연결을 요청했어요", { name: a().device.name })}</b>
            <span class="muted">{t("허용하면 이 기기에서 작업을 보고 지시할 수 있어요")}</span>
          </div>
          <button class="btn sm ghost" onClick={() => void import("../engine/remote").then((m) => m.answerPair(a().conn, false))}>{t("거절")}</button>
          <button class="btn sm primary" onClick={() => void import("../engine/remote").then((m) => m.answerPair(a().conn, true))}>{t("허용")}</button>
        </div>
      )}
    </Show>
  );
}
