// The app's display name comes from one place: productName in tauri.conf.json.
import { createSignal } from "solid-js";
import { getName } from "@tauri-apps/api/app";
import { inTauri } from "./native";

const [name, setName] = createSignal("Ondra");
export const appName = name;
if (inTauri) {
  getName()
    .then((n) => {
      setName(n);
      document.title = n;
    })
    .catch(() => {});
}
