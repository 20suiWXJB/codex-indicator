import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  connectingStatus,
  describeStatus,
  describeInstanceStatus,
  formatAggregateSubtitle,
  formatEventTime,
  idleStatus,
  resolveDisplayStatus,
  shouldBlink,
  trimText,
} from "./statusPresenter";
import type { EventPayload, IndicatorStatus, InstanceStatus, MultiStatusPayload, StatusPayload } from "./statusPresenter";
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
        <ol class="instances" aria-label="活跃实例"></ol>
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
  const instancesList = app.querySelector<HTMLOListElement>(".instances")!;
  const eventsList = app.querySelector<HTMLOListElement>(".events")!;

  let lastStatus = connectingStatus();
  let lastInstances: InstanceStatus[] = [];
  let panelOpen = false;
  let settings = DEFAULT_SETTINGS;
  let pollTimer: number | undefined;
  let isFirstLoad = true;
  // 上次真正写入 DOM 的内容指纹，用于跳过无变化的渲染
  let lastRenderKey = "";
  /** 上一次实际渲染的状态，用于判断是否需要触发切换闪烁 */
  let prevDisplayStatus: IndicatorStatus | null = null;

  function setPanelOpen(open: boolean) {
    panelOpen = open;
    shell.dataset.panelOpen = String(open);
    if (open) {
      void refreshEvents();
    }
  }

  function renderStatus(payload: StatusPayload, instances: InstanceStatus[] = lastInstances) {
    const displayStatus = resolveDisplayStatus(payload, Date.now(), settings.showDoneSettleMs);
    const displayPayload = { ...payload, status: displayStatus };
    const copy = describeStatus(displayPayload);
    const aggregateSubtitle = instances.length > 0 ? formatAggregateSubtitle(instances) : copy.title;

    // 本函数每个轮询周期都会执行；内容没变时跳过 DOM 写入，让 webview 保持空闲
    const renderKey = JSON.stringify([
      displayStatus,
      copy.label,
      aggregateSubtitle,
      copy.detail,
      settings.showInstanceList,
      settings.eventInstancePrefix,
      instances.map((instance) => [
        instance.id,
        instance.label,
        instance.cwd,
        instance.status,
        instance.summary,
        instance.detail,
      ]),
    ]);
    if (renderKey === lastRenderKey) {
      return;
    }
    lastRenderKey = renderKey;

    // 状态切换闪烁：仅在状态真正变化且设置开启时触发
    if (
      prevDisplayStatus !== null &&
      prevDisplayStatus !== displayStatus &&
      shouldBlink(prevDisplayStatus, displayStatus) &&
      settings.statusBlinkEnabled
    ) {
      // 动画重启技巧：先移除类 → 强制回流 → 重新添加
      lamp.classList.remove("status-blink");
      void lamp.offsetWidth;
      lamp.classList.add("status-blink");
    }
    prevDisplayStatus = displayStatus;

    shell.dataset.status = displayStatus;
    lamp.dataset.status = displayStatus;
    label.textContent = copy.label;
    summary.textContent = trimText(aggregateSubtitle, 42);
    statusButton.title = [copy.title, copy.detail, aggregateSubtitle].filter(Boolean).join("\n");
    renderInstances(instances);
  }

  function renderInstances(instances: InstanceStatus[]) {
    if (settings.showInstanceList === false) {
      instancesList.replaceChildren();
      instancesList.hidden = true;
      return;
    }

    instancesList.hidden = false;
    instancesList.replaceChildren(
      ...instances.map((instance) => {
        const copy = describeInstanceStatus(instance);
        const item = document.createElement("li");
        item.className = `instance instance-${instance.status}`;
        item.title = copy.detail;

        const dot = document.createElement("span");
        dot.className = "instance-dot";
        dot.dataset.status = instance.status;

        const name = document.createElement("span");
        name.className = "instance-name";
        name.textContent = trimText(copy.title, 26);

        const state = document.createElement("span");
        state.className = "instance-state";
        state.textContent = copy.label;

        item.append(dot, name, state);
        return item;
      }),
    );

    if (instances.length === 0) {
      const item = document.createElement("li");
      item.className = "empty instance-empty";
      item.textContent = "暂无活跃实例";
      instancesList.append(item);
    }
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
        const instanceLabel = settings.eventInstancePrefix ? eventInstanceLabel(event) : "";
        const eventText = event.summary || event.event || event.source;
        body.textContent = trimText(instanceLabel ? `${instanceLabel}: ${eventText}` : eventText, 96);
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

    // 将动效设置落到 DOM，CSS 通过变量和数据属性读取
    shell.dataset.breath = settings.runningBreathEnabled ? "on" : "off";
    lamp.style.setProperty("--breath-period", `${settings.runningBreathPeriodMs}ms`);
    lamp.style.setProperty("--blink-count", String(settings.statusBlinkCount));

    pinButton.classList.toggle("active", settings.alwaysOnTop);
    await applyAlwaysOnTop(settings.alwaysOnTop);
    scheduleStatusPolling();
    if (panelOpen) {
      void resizePanelWindow(true);
    }
    renderStatus(lastStatus, lastInstances);
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
      try {
        const payload = await invoke<MultiStatusPayload>("get_statuses");
        lastStatus = payload.aggregate;
        lastInstances = payload.instances ?? [];
      } catch {
        lastStatus = await invoke<StatusPayload>("get_status");
        lastInstances = [];
      }

      if (isFirstLoad) {
        console.log("✓ 状态加载成功:", lastStatus.status, lastStatus.summary);
        isFirstLoad = false;
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "状态读取失败";
      console.error("✗ 状态读取失败:", errorMsg);
      lastStatus = idleStatus(errorMsg);
      lastInstances = [];
    }
    renderStatus(lastStatus, lastInstances);
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

  // 闪烁动画结束后自动移除闪烁类，恢复正常状态动画
  lamp.addEventListener("animationend", (event) => {
    if (event.animationName === "lamp-blink") {
      lamp.classList.remove("status-blink");
    }
  });

  void listen(OPEN_EVENTS, () => {
    setPanelOpen(true);
    void resizePanelWindow(true);
  });
  void listen(SETTINGS_CHANGED, () => {
    void loadSettings();
  });

  renderStatus(connectingStatus(), []);
  console.log("⟳ 正在连接 Codex...");
  void loadSettings().then(refreshStatus);
}

function eventInstanceLabel(event: EventPayload): string {
  if (event.label) {
    return event.label;
  }
  if (event.cwd) {
    const parts = event.cwd.split(/[\\/]+/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : event.cwd;
  }
  return event.instance ?? "";
}
