// Asking for a macOS permission: the system's own prompt (accessibility), its privacy list
// opened, and a small panel over that list holding Ondra's tile to drag in.
import { openPrivacySettings, permissionGuide, requestAccessibility } from "./native";
import { t } from "../i18n";

export async function askPermission(pane: "accessibility" | "screen") {
  if (pane === "accessibility") await requestAccessibility();
  await openPrivacySettings(pane);
  const list = pane === "accessibility" ? t("손쉬운 사용") : t("화면 기록");
  await permissionGuide(pane, t("Ondra를 {list} 목록에 끌어다 놓으세요", { list }), t("그다음 스위치를 켜세요"));
}
