import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  connectingStatus,
  describeStatus,
  EventPayload,
  formatEventTime,
  idleStatus,
  resolveDisplayStatus,
  StatusPayload,
  trimText,
} from "./statusPresenter";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
} from "./settingsModel";
import type { SettingsSnapshot } from "./settingsModel";

const OPEN_EVENTS = "indicator-open-events";
const SETTINGS_CHANGED = "indicator-settings-changed";

export function renderMainPanel(app: HTMLDivElement) {
  // 视图标记同时挂载到 html 和 body，保持与设置视图一致的挂载点
  document.documentElement.dataset.view = "main";
  document.body.dataset.view = "main";
  app.innerHTML = `
    <main class="shell" data-panel-open="false">
      <section class="pill" title="AI 状态" aria-live="polite">
        <button class="status-button" type="button" aria-label="切换最近事件">
          <span class="lamp" aria-hidden="true"></span>
          <span class="copy">
            <span class="label">连接中</span>
            <span class="summary">正在初始化...</span>
          </span>
        </button>
        <div class="actions" aria-label="窗口操作">
          <button class="icon-button settings" type="button" title="打开设置" aria-label="打开设置">⚙</button>
          <button class="icon-button pin" type="button" title="切换置顶" aria-label="切换置顶">T</button>
          <button class="icon-button close" type="button" title="隐藏窗口" aria-label="隐藏窗口">-</button>
        </div>
      </section>
      <section class="panel" aria-label="最近事件">
        <div class="panel-head">
          <span>最近事件</span>
          <button class="text-button open-state" type="button">状态目录</button>
          <button class="text-button open-logs" type="button">日志目录</button>
        </div>
        <ol class="events"></ol>
      </section>
    </main>
  `;

  const shell = app.querySelector<HTMLElement>(".shell")!;
  const pill = app.querySelector<HTMLElement>(".pill")!;
  const statusButton = app.querySelector<HTMLButtonElement>(".status-button")!;
  const settingsButton = app.querySelector<HTMLButtonElement>(".settings")!;
  const pinButton = app.querySelector<HTMLButtonElement>(".pin")!;
  const closeButton = app.querySelector<HTMLButtonElement>(".close")!;
  const openStateButton = app.querySelector<HTMLButtonElement>(".open-state")!;
  const openLogsButton = app.querySelector<HTMLButtonElement>(".open-logs")!;
  const lamp = app.querySelector<HTMLElement>(".lamp")!;
  const label = app.querySelector<HTMLElement>(".label")!;
  const summary = app.querySelector<HTMLElement>(".summary")!;
  const eventsList = app.querySelector<HTMLOListElement>(".events")!;

  let lastStatus = connectingStatus();
  let panelOpen = false;
  let settings = DEFAULT_SETTINGS;
  let pollTimer: number | undefined;
  let isFirstLoad = true;
  // 上次真正写入 DOM 的内容指纹，用于跳过无变化的渲染
  let lastRenderKey = "";

  function setPanelOpen(open: boolean) {
    panelOpen = open;
    shell.dataset.panelOpen = String(open);
    if (open) {
      void refreshEvents();
    }
  }

  function renderStatus(payload: StatusPayload) {
    const displayStatus = resolveDisplayStatus(payload, Date.now(), settings.showDoneSettleMs);
    const displayPayload = { ...payload, status: displayStatus };
    const copy = describeStatus(displayPayload);

    // 本函数每个轮询周期都会执行；内容没变时跳过 DOM 写入，让 webview 保持空闲
    const renderKey = JSON.stringify([displayStatus, copy.label, copy.title, copy.detail]);
    if (renderKey === lastRenderKey) {
      return;
    }
    lastRenderKey = renderKey;

    shell.dataset.status = displayStatus;
    lamp.dataset.status = displayStatus;
    label.textContent = copy.label;
    summary.textContent = trimText(copy.title, 42);
    statusButton.title = [copy.title, copy.detail].filter(Boolean).join("\n");
  }

  function renderEvents(events: EventPayload[]) {
    eventsList.replaceChildren(
      ...events.map((event) => {
        const item = document.createElement("li");
        item.className = `event event-${event.status}`;

        const time = document.createElement("time");
        time.dateTime = event.createdAt;
        time.textContent = formatEventTime(event.createdAt);

        const body = document.createElement("span");
        body.className = "event-body";
        body.textContent = trimText(event.summary || event.event || event.source, 96);
        body.title = [event.summary, event.detail].filter(Boolean).join("\n");

        item.append(time, body);
        return item;
      }),
    );

    if (events.length === 0) {
      const item = document.createElement("li");
      item.className = "empty";
      item.textContent = "暂无事件";
      eventsList.append(item);
    }
  }

  async function loadSettings() {
    try {
      const snapshot = await invoke<SettingsSnapshot>("get_settings");
      settings = normalizeSettings(snapshot.settings);
    } catch {
      settings = DEFAULT_SETTINGS;
    }

    pinButton.classList.toggle("active", settings.alwaysOnTop);
    await applyAlwaysOnTop(settings.alwaysOnTop);
    scheduleStatusPolling();
    if (panelOpen) {
      void resizePanelWindow(true);
    }
  }

  async function applyAlwaysOnTop(enabled: boolean) {
    try {
      await invoke("set_always_on_top", { enabled });
    } catch {
      // The setting still remains visible in browsers outside Tauri.
    }
  }

  async function refreshStatus() {
    try {
      lastStatus = await invoke<StatusPayload>("get_status");

      if (isFirstLoad) {
        console.log("✓ 状态加载成功:", lastStatus.status, lastStatus.summary);
        isFirstLoad = false;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "状态读取失败";
      console.error("✗ 状态读取失败:", errorMsg);
      lastStatus = idleStatus(errorMsg);
    }
    renderStatus(lastStatus);
  }

  async function refreshEvents() {
    try {
      const events = await invoke<EventPayload[]>("get_recent_events", { limit: 20 });
      renderEvents(events);
    } catch (error) {
      renderEvents([
        {
          status: "error",
          source: "indicator",
          event: "get_recent_events",
          summary: "事件读取失败",
          detail: error instanceof Error ? error.message : String(error),
          createdAt: new Date().toISOString(),
        },
      ]);
    }
  }

  async function resizePanelWindow(open: boolean) {
    try {
      await invoke("set_panel_open", {
        open,
        panelExpandedHeight: settings.panelExpandedHeight,
      });
    } catch {
      // The panel can still render in dev browsers outside Tauri.
    }
  }

  function scheduleStatusPolling() {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
    }
    pollTimer = window.setInterval(refreshStatus, settings.pollIntervalMs);
  }

  pill.addEventListener("pointerdown", async (event) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }

    try {
      await getCurrentWindow().startDragging();
    } catch {
      // Dragging is only available inside the Tauri runtime.
    }
  });

  statusButton.addEventListener("click", () => {
    setPanelOpen(!panelOpen);
    void resizePanelWindow(panelOpen);
  });
  statusButton.addEventListener("dblclick", () => {
    setPanelOpen(true);
    void resizePanelWindow(true);
  });
  settingsButton.addEventListener("click", () => invoke("open_settings_window"));
  pinButton.addEventListener("click", async () => {
    settings = { ...settings, alwaysOnTop: !settings.alwaysOnTop };
    await invoke("set_always_on_top", { enabled: settings.alwaysOnTop });
    pinButton.classList.toggle("active", settings.alwaysOnTop);
  });
  closeButton.addEventListener("click", () => {
    void invoke(settings.minimizeToTray ? "hide_window" : "quit_app");
  });
  openStateButton.addEventListener("click", () => invoke("open_state_dir"));
  openLogsButton.addEventListener("click", () => invoke("open_logs_dir"));

  void listen(OPEN_EVENTS, () => {
    setPanelOpen(true);
    void resizePanelWindow(true);
  });
  void listen(SETTINGS_CHANGED, () => {
    void loadSettings();
  });

  renderStatus(connectingStatus());
  console.log("⟳ 正在连接 Codex...");
  void loadSettings().then(refreshStatus);
}
