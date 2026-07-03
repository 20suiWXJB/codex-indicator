import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  DEFAULT_SETTINGS,
  formatSettingValue,
  normalizeSettings,
  SETTING_SECTIONS,
} from "./settingsModel";
import type {
  AppSettings,
  SettingAction,
  SettingItem,
  SettingsDiagnostics,
  SettingsSnapshot,
} from "./settingsModel";

export function renderSettingsPage(app: HTMLDivElement) {
  // 视图标记同时挂载到 html 和 body：html 上的标记用于解除全局 overflow:hidden（视口滚动由根元素决定）
  document.documentElement.dataset.view = "settings";
  document.body.dataset.view = "settings";
  document.body.dataset.theme = DEFAULT_SETTINGS.theme;
  app.innerHTML = `
    <main class="settings-shell">
      <header class="settings-header">
        <div>
          <p class="settings-kicker">Indicator</p>
          <h1>设置</h1>
          <p class="settings-lede">集中管理状态来源、窗口行为、通知偏好和本地数据。</p>
        </div>
        <button class="settings-close" type="button" aria-label="关闭设置">关闭</button>
      </header>
      <div class="settings-alert" role="status" hidden></div>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="设置分组"></nav>
        <form class="settings-form"></form>
      </div>
      <pre class="settings-diagnostics" hidden></pre>
      <footer class="settings-footer">
        <span class="settings-status" role="status">正在加载设置...</span>
        <button class="settings-save" type="button">保存更改</button>
      </footer>
    </main>
  `;

  const nav = app.querySelector<HTMLElement>(".settings-nav")!;
  const form = app.querySelector<HTMLFormElement>(".settings-form")!;
  const alert = app.querySelector<HTMLElement>(".settings-alert")!;
  const diagnosticsBlock = app.querySelector<HTMLPreElement>(".settings-diagnostics")!;
  const status = app.querySelector<HTMLElement>(".settings-status")!;
  const saveButton = app.querySelector<HTMLButtonElement>(".settings-save")!;
  const closeButton = app.querySelector<HTMLButtonElement>(".settings-close")!;

  let settings = DEFAULT_SETTINGS;
  let diagnostics: SettingsDiagnostics | undefined;
  let diagnosticsVisible = false;

  function renderNavigation() {
    nav.innerHTML = SETTING_SECTIONS.map(
      (section) =>
        `<a class="settings-nav-link" href="#${section.id}">${escapeHtml(section.title)}</a>`,
    ).join("");
  }

  function renderForm(nextSettings: AppSettings) {
    settings = nextSettings;
    document.body.dataset.theme = settings.theme;
    form.innerHTML = SETTING_SECTIONS.map(
      (section) => `
        <section class="settings-section" id="${section.id}">
          <h2>${escapeHtml(section.title)}</h2>
          <div class="setting-list">
            ${section.items.map((item) => renderItem(item, settings)).join("")}
          </div>
        </section>
      `,
    ).join("");
    bindFormHandlers();
    updateCurrentValues();
    updatePathInputs();
    updateDiagnostics();
  }

  function renderItem(item: SettingItem, currentSettings: AppSettings): string {
    const currentValue = item.key
      ? formatSettingValue(item.key, currentSettings)
      : actionCurrentValue(item.action);
    return `
      <div class="setting-row">
        <div class="setting-copy">
          <div class="setting-title">${escapeHtml(item.title)}</div>
          <p class="setting-description">${escapeHtml(item.description)}</p>
          ${item.compatibility ? `<p class="setting-compat">${escapeHtml(item.compatibility)}</p>` : ""}
          <p class="setting-current">当前值：<span data-current-for="${item.key ?? item.action}">${escapeHtml(currentValue)}</span></p>
        </div>
        <div class="setting-control">
          ${item.key ? renderControl(item, currentSettings) : renderAction(item)}
        </div>
      </div>
    `;
  }

  function renderControl(item: SettingItem, currentSettings: AppSettings): string {
    const key = item.key!;
    const value = currentSettings[key];

    if (item.input === "toggle") {
      return `
        <label class="switch">
          <input type="checkbox" name="${key}" ${value ? "checked" : ""} />
          <span></span>
        </label>
      `;
    }

    if (item.input === "select") {
      return `
        <select name="${key}">
          ${(item.options ?? [])
            .map(
              (option) =>
                `<option value="${escapeHtml(option.value)}" ${option.value === value ? "selected" : ""}>${escapeHtml(option.label)}</option>`,
            )
            .join("")}
        </select>
      `;
    }

    if (item.input === "number") {
      return `
        <label class="number-field">
          <input type="number" name="${key}" value="${escapeHtml(String(value))}" min="${item.min ?? ""}" max="${item.max ?? ""}" step="${item.step ?? 1}" />
          <span>${escapeHtml(item.unit ?? "")}</span>
        </label>
      `;
    }

    return `<input class="path-field" type="text" name="${key}" value="${escapeHtml(String(value))}" placeholder="自动检测" />`;
  }

  function renderAction(item: SettingItem): string {
    return `<button class="setting-action" type="button" data-action="${item.action}">${escapeHtml(item.title)}</button>`;
  }

  function bindFormHandlers() {
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select").forEach((control) => {
      control.addEventListener("input", handleFormChange);
      control.addEventListener("change", handleFormChange);
    });
    form.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
      button.addEventListener("click", () => handleAction(button.dataset.action as SettingAction));
    });
  }

  function handleFormChange() {
    settings = readFormSettings();
    document.body.dataset.theme = settings.theme;
    updateCurrentValues();
    updatePathInputs();
    updateDiagnostics();
  }

  function readFormSettings(): AppSettings {
    const checkbox = (name: keyof AppSettings) =>
      form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.checked ?? false;
    const value = (name: keyof AppSettings) =>
      form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value;

    return normalizeSettings({
      language: value("language"),
      theme: value("theme"),
      showMainWindowOnLaunch: checkbox("showMainWindowOnLaunch"),
      alwaysOnTop: checkbox("alwaysOnTop"),
      rememberWindowState: checkbox("rememberWindowState"),
      minimizeToTray: checkbox("minimizeToTray"),
      panelExpandedHeight: value("panelExpandedHeight"),
      stateDirMode: value("stateDirMode"),
      stateDir: value("stateDir"),
      codexSessionsDirMode: value("codexSessionsDirMode"),
      codexSessionsDir: value("codexSessionsDir"),
      pollIntervalMs: value("pollIntervalMs"),
      notifyOnWaiting: checkbox("notifyOnWaiting"),
      notifyOnError: checkbox("notifyOnError"),
      showDoneSettleMs: value("showDoneSettleMs"),
    });
  }

  function updateCurrentValues() {
    for (const section of SETTING_SECTIONS) {
      for (const item of section.items) {
        const id = item.key ?? item.action;
        const target = id ? form.querySelector<HTMLElement>(`[data-current-for="${id}"]`) : null;
        if (!target) {
          continue;
        }
        target.textContent = item.key ? formatSettingValue(item.key, settings) : actionCurrentValue(item.action);
      }
    }
  }

  function updatePathInputs() {
    setPathDisabled("stateDir", settings.stateDirMode !== "custom");
    setPathDisabled("codexSessionsDir", settings.codexSessionsDirMode !== "custom");
  }

  function setPathDisabled(name: keyof AppSettings, disabled: boolean) {
    const input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (input) {
      input.disabled = disabled;
    }
  }

  async function loadSettings() {
    try {
      const snapshot = await invoke<SettingsSnapshot>("get_settings");
      settings = normalizeSettings(snapshot.settings);
      diagnostics = snapshot.diagnostics;
      alert.hidden = !snapshot.loadError;
      alert.textContent = snapshot.loadError ? `设置文件读取失败，已使用默认值：${snapshot.loadError}` : "";
      status.textContent = "设置已加载";
    } catch (error) {
      settings = DEFAULT_SETTINGS;
      diagnostics = undefined;
      alert.hidden = false;
      alert.textContent = `设置读取失败，已使用默认值：${errorMessage(error)}`;
      status.textContent = "设置读取失败";
    }

    renderForm(settings);
  }

  async function saveSettings() {
    saveButton.disabled = true;
    status.textContent = "正在保存...";
    try {
      const snapshot = await invoke<SettingsSnapshot>("save_settings", { settings: readFormSettings() });
      settings = normalizeSettings(snapshot.settings);
      diagnostics = snapshot.diagnostics;
      renderForm(settings);
      alert.hidden = true;
      status.textContent = "设置已保存";
    } catch (error) {
      status.textContent = `保存失败：${errorMessage(error)}`;
    } finally {
      saveButton.disabled = false;
    }
  }

  async function resetDefaults() {
    status.textContent = "正在恢复默认设置...";
    try {
      const snapshot = await invoke<SettingsSnapshot>("reset_settings");
      settings = normalizeSettings(snapshot.settings);
      diagnostics = snapshot.diagnostics;
      renderForm(settings);
      alert.hidden = true;
      status.textContent = "已恢复默认设置";
    } catch (error) {
      status.textContent = `恢复失败：${errorMessage(error)}`;
    }
  }

  async function handleAction(action: SettingAction) {
    try {
      if (action === "openStateDir") {
        await invoke("open_state_dir");
        status.textContent = "已请求打开状态目录";
      } else if (action === "openLogsDir") {
        await invoke("open_logs_dir");
        status.textContent = "已请求打开日志目录";
      } else if (action === "clearEvents") {
        await invoke("clear_recent_events");
        status.textContent = "本地事件记录已清理";
      } else if (action === "resetDefaults") {
        await resetDefaults();
      } else if (action === "toggleDiagnostics") {
        diagnosticsVisible = !diagnosticsVisible;
        updateDiagnostics();
        status.textContent = diagnosticsVisible ? "诊断信息已显示" : "诊断信息已隐藏";
      }
    } catch (error) {
      status.textContent = `操作失败：${errorMessage(error)}`;
    }
  }

  function updateDiagnostics() {
    diagnosticsBlock.hidden = !diagnosticsVisible;
    if (!diagnosticsVisible) {
      return;
    }

    const lines = [
      `设置文件: ${diagnostics?.settingsFile ?? "未知"}`,
      `状态目录: ${diagnostics?.stateDir ?? "未知"}`,
      `日志目录: ${diagnostics?.logsDir ?? "未知"}`,
      `Codex sessions: ${diagnostics?.codexSessionsDir ?? "未知"}`,
      "",
      "当前设置:",
      JSON.stringify(settings, null, 2),
    ];
    diagnosticsBlock.textContent = lines.join("\n");
  }

  closeButton.addEventListener("click", async () => {
    try {
      await getCurrentWindow().close();
    } catch {
      window.close();
    }
  });
  saveButton.addEventListener("click", () => {
    void saveSettings();
  });

  renderNavigation();
  renderForm(DEFAULT_SETTINGS);
  void loadSettings();
}

function actionCurrentValue(action?: SettingAction): string {
  if (action === "toggleDiagnostics") {
    return "未显示";
  }
  return "可执行操作";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
