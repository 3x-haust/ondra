// Korean is the source; other languages read English.
const en: Record<string, string> = {
  "{mac}에 연결": "Connect to {mac}",
  "이 폰에서 {mac}의 작업을 보고 지시해요.": "See and steer {mac}'s jobs from this phone.",
  "연결": "Connect",
  "연결 중": "Connecting",
  "Mac에서 허용을 눌러주세요": "Press Allow on your Mac",
  "{mac} 화면에 연결 요청이 떠 있어요.": "A request is showing on {mac}.",
  "연결이 끊겼어요": "Connection lost",
  "{n}초 뒤 다시 연결해요": "Reconnecting in {n}s",
  "지금 연결": "Reconnect now",
  "거절됐어요": "Not allowed",
  "Mac에서 거절했어요. 다시 하려면 QR을 새로 찍어요.": "Your Mac said no. Scan a new QR to try again.",
  "이 기기는 연결이 끊겼어요. Ondra 설정 › 원격 제어에서 QR을 다시 찍어요.": "This device was removed. Scan the QR again in Ondra Settings › Remote control.",
  "연결하지 못했어요": "Couldn't connect",
  "다시 시도": "Try again",
  "Ondra 원격 제어": "Ondra remote",
  "Mac의 Ondra에서 설정 › 원격 제어를 열고 QR을 찍어요.": "On your Mac, open Ondra Settings › Remote control and scan the QR.",
  "작업": "Jobs",
  "진행 중": "Running",
  "답 기다림": "Waiting for you",
  "대기": "Queued",
  "완료": "Done",
  "일시정지": "Paused",
  "실패": "Failed",
  "새 작업": "New job",
  "무엇을 할까요": "What should it do?",
  "보내기": "Send",
  "멈추기": "Stop",
  "메시지": "Message",
  "아직 작업이 없어요": "No jobs yet",
  "이 기기 연결 해제": "Disconnect this device",
  "작업 목록": "Jobs",
  "생각 중": "Thinking",
  "다음에 보낼 메시지": "Up next",
  "{n}분 걸림": "Took {n} min",
  "{n}초 걸림": "Took {n}s",
  "방금": "now",
  "{n}분 전": "{n}m ago",
  "{n}시간 전": "{n}h ago",
  "{n}일 전": "{n}d ago",
  "프로젝트 없음": "No project",
  "다른 에이전트": "Another agent",
  "단계 {n}개": "{n} steps",
};

const isKo = (navigator.language || "ko").toLowerCase().startsWith("ko");
document.documentElement.lang = isKo ? "ko" : "en";

export function t(s: string, v: Record<string, string | number> = {}): string {
  const base = isKo ? s : (en[s] ?? s);
  return base.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
}

export function ago(at: number): string {
  const m = Math.floor((Date.now() - at) / 60_000);
  if (m < 1) return t("방금");
  if (m < 60) return t("{n}분 전", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{n}시간 전", { n: h });
  return t("{n}일 전", { n: Math.floor(h / 24) });
}
