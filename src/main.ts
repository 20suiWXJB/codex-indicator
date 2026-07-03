import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderMainPanel } from "./mainPanel";
import { renderSettingsPage } from "./settingsPage";
import { resolveWindowKind } from "./settingsModel";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

let label: string | undefined;
try {
  label = getCurrentWindow().label;
} catch {
  label = undefined;
}

if (resolveWindowKind(window.location.search, label) === "settings") {
  renderSettingsPage(app);
} else {
  renderMainPanel(app);
}
