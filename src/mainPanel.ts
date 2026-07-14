import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
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
import { reduceDock } from "./dockModel";
import type { DockCommand, DockEdge, DockUiState } from "./dockModel";

const OPEN_EVENTS = "indicator-open-events";
const SETTINGS_CHANGED = "indicator-settings-changed";
const MOVE_DEBOUNCE_MS = 400;
const PEEK_DELAY_MS = 120;
const MOVED_SUPPRESS_MS = 500;
const DOCK_CURSOR_POLL_MS = 100;

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
      <div class="dock-bead" aria-hidden="true" title="AI 状态"><span class="dock-bead-core"></span></div>
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
  const dockBead = app.querySelector<HTMLElement>(".dock-bead")!;
  const dockBeadCore = app.querySelector<HTMLElement>(".dock-bead-core")!;
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
  let dockUi: DockUiState = { mode: "none", edge: null };
  let moveDebounceTimer: number | undefined;
  let peekTimer: number | undefined;
  let hideTimer: number | undefined;
  let shouldHideWhenSettled = false;
  let suppressMovedUntil = 0;
  let dockStateRestored = false;
  let isNativeDragging = false;
  let nativeDragReleaseSupported: boolean | undefined;
  let nativeDragReleaseWaiting = false;
  let dockCursorPollTimer: number | undefined;
  let dockCursorPollGeneration = 0;
  let dockCursorPollInFlight = false;
  let cursorReadErrorReported = false;
  let geometryReadErrorReported = false;

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
      dockBeadCore.classList.remove("status-blink");
      void lamp.offsetWidth;
      void dockBeadCore.offsetWidth;
      lamp.classList.add("status-blink");
      dockBeadCore.classList.add("status-blink");
    }
    prevDisplayStatus = displayStatus;

    shell.dataset.status = displayStatus;
    lamp.dataset.status = displayStatus;
    label.textContent = copy.label;
    summary.textContent = trimText(aggregateSubtitle, 42);
    dockBead.title = copy.title;
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
    dockBeadCore.style.setProperty("--breath-period", `${settings.runningBreathPeriodMs}ms`);
    dockBeadCore.style.setProperty("--blink-count", String(settings.statusBlinkCount));

    pinButton.classList.toggle("active", settings.alwaysOnTop);
    await applyAlwaysOnTop(settings.alwaysOnTop);
    if (settings.edgeDockEnabled === false) {
      isNativeDragging = false;
      if (moveDebounceTimer !== undefined) {
        window.clearTimeout(moveDebounceTimer);
        moveDebounceTimer = undefined;
      }
      await dispatchDock({ kind: "dockDisabled" });
      dockStateRestored = true;
    } else if (!dockStateRestored || dockUi.mode === "none") {
      await restoreDockState();
    }
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

  function updateDockDataset() {
    shell.dataset.dockMode = dockUi.mode;
    if (dockUi.edge) {
      shell.dataset.dockEdge = dockUi.edge;
    } else {
      delete shell.dataset.dockEdge;
    }
  }

  async function restoreDockState() {
    try {
      const state = await invoke<{ edge: DockEdge } | null>("get_dock_state");
      await dispatchDock({ kind: "restored", state });
    } catch {
      await dispatchDock({ kind: "restored", state: null });
    }
    dockStateRestored = true;
  }

  async function dispatchDock(event: Parameters<typeof reduceDock>[1]) {
    const result = reduceDock(dockUi, event);
    dockUi = result.state;
    updateDockDataset();
    syncDockCursorPolling();

    for (const command of result.commands) {
      await executeDockCommand(command);
    }
  }

  async function executeDockCommand(command: DockCommand) {
    if (command.kind === "closePanel") {
      setPanelOpen(false);
      return;
    }

    suppressMovedUntil = Date.now() + MOVED_SUPPRESS_MS;
    try {
      if (command.kind === "setMode") {
        await invoke("set_dock_mode", {
          mode: command.mode,
          panelExpandedHeight: panelOpen ? settings.panelExpandedHeight : undefined,
        });
      } else if (command.kind === "undock") {
        await invoke("undock_window");
      }
    } catch (error) {
      reportDockError(`dock command ${command.kind} failed`, error);
      dockUi = { mode: "none", edge: null };
      updateDockDataset();
      syncDockCursorPolling();
    }
  }

  async function runDockCheck(options: { allowDocked?: boolean } = {}) {
    if (settings.edgeDockEnabled === false) {
      return;
    }
    if (dockUi.mode !== "none" && options.allowDocked !== true) {
      return;
    }

    suppressMovedUntil = Date.now() + MOVED_SUPPRESS_MS;
    try {
      if (panelOpen) {
        setPanelOpen(false);
        await resizePanelWindow(false);
      }
      const edge = await invoke<DockEdge | null>("dock_check", {
        panelExpandedHeight: undefined,
      });
      await dispatchDock({ kind: "dockCheckResult", edge });
    } catch (error) {
      reportDockError("dock_check failed", error);
      await dispatchDock({ kind: "dockCheckResult", edge: null });
    }
  }

  async function handleDragPointerDown(event: PointerEvent) {
    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof Element && target.closest("button")) {
      return;
    }

    isNativeDragging = true;
    nativeDragReleaseWaiting = true;
    stopDockCursorPolling();
    cancelDockTimers();
    if (moveDebounceTimer !== undefined) {
      window.clearTimeout(moveDebounceTimer);
      moveDebounceTimer = undefined;
    }

    if (panelOpen) {
      setPanelOpen(false);
      await resizePanelWindow(false);
    }

    let releasePromise: Promise<boolean> | undefined;
    if (await supportsNativeDragRelease()) {
      releasePromise = invoke<void>("wait_for_native_drag_release").then(
        () => true,
        (error) => {
          reportDockError("native drag release wait failed", error);
          return false;
        },
      ).finally(() => {
        nativeDragReleaseWaiting = false;
      });
    } else {
      nativeDragReleaseWaiting = false;
    }

    let dragStarted = false;
    try {
      await getCurrentWindow().startDragging();
      dragStarted = true;
    } catch (error) {
      isNativeDragging = false;
      reportDockError("native drag start failed", error);
      syncDockCursorPolling();
      // Dragging is only available inside the Tauri runtime.
    }

    if (!releasePromise) {
      return;
    }

    const released = await releasePromise;
    if (!dragStarted) {
      return;
    }
    if (!released) {
      return;
    }

    isNativeDragging = false;
    await runDockCheck({ allowDocked: true });
  }

  async function supportsNativeDragRelease() {
    if (nativeDragReleaseSupported !== undefined) {
      return nativeDragReleaseSupported;
    }
    try {
      nativeDragReleaseSupported = await invoke<boolean>("is_native_drag_release_supported");
    } catch (error) {
      nativeDragReleaseSupported = false;
      reportDockError("native drag release capability check failed", error);
    }
    return nativeDragReleaseSupported;
  }

  function cancelDockTimers() {
    clearPeekTimer();
    cancelDockHide();
  }

  function clearPeekTimer() {
    if (peekTimer !== undefined) {
      window.clearTimeout(peekTimer);
      peekTimer = undefined;
    }
  }

  function cancelDockHide() {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
    shouldHideWhenSettled = false;
  }

  function scheduleDockHide() {
    if (dockUi.mode !== "peek" || !shouldHideWhenSettled || hideTimer !== undefined) {
      return;
    }
    hideTimer = window.setTimeout(() => {
      hideTimer = undefined;
      if (!shouldHideWhenSettled) {
        return;
      }
      shouldHideWhenSettled = false;
      void dispatchDock({ kind: "pointerLeaveSettled" });
    }, settings.dockHideDelayMs);
  }

  function syncDockCursorPolling() {
    if (!shouldPollDockCursor()) {
      stopDockCursorPolling();
      return;
    }
    if (dockCursorPollTimer !== undefined) {
      return;
    }

    cursorReadErrorReported = false;
    geometryReadErrorReported = false;
    const generation = ++dockCursorPollGeneration;
    dockCursorPollTimer = window.setInterval(() => {
      void pollDockCursor(generation);
    }, DOCK_CURSOR_POLL_MS);
  }

  function stopDockCursorPolling() {
    dockCursorPollGeneration += 1;
    if (dockCursorPollTimer !== undefined) {
      window.clearInterval(dockCursorPollTimer);
      dockCursorPollTimer = undefined;
    }
    dockCursorPollInFlight = false;
  }

  async function pollDockCursor(generation: number) {
    if (
      dockCursorPollInFlight ||
      generation !== dockCursorPollGeneration ||
      !shouldPollDockCursor()
    ) {
      return;
    }

    dockCursorPollInFlight = true;
    try {
      let cursor;
      try {
        cursor = await cursorPosition();
      } catch (error) {
        if (!cursorReadErrorReported) {
          cursorReadErrorReported = true;
          reportDockError("dock cursor position read failed", error);
        }
        return;
      }

      let position;
      let size;
      try {
        const currentWindow = getCurrentWindow();
        [position, size] = await Promise.all([
          currentWindow.outerPosition(),
          currentWindow.outerSize(),
        ]);
      } catch (error) {
        if (!geometryReadErrorReported) {
          geometryReadErrorReported = true;
          reportDockError("dock window geometry read failed", error);
        }
        return;
      }

      if (
        generation !== dockCursorPollGeneration ||
        !shouldPollDockCursor()
      ) {
        return;
      }

      const inside =
        cursor.x >= position.x &&
        cursor.x < position.x + size.width &&
        cursor.y >= position.y &&
        cursor.y < position.y + size.height;
      if (inside) {
        cancelDockHide();
      } else {
        clearPeekTimer();
        shouldHideWhenSettled = true;
        scheduleDockHide();
      }
    } finally {
      if (generation === dockCursorPollGeneration) {
        dockCursorPollInFlight = false;
      }
    }
  }

  function shouldPollDockCursor() {
    return dockUi.mode === "peek" && settings.edgeDockEnabled !== false && !isNativeDragging;
  }

  function reportDockError(message: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`${message}:`, error);
    void invoke("report_dock_error", { message: `${message}: ${detail}` }).catch(() => {});
  }

  pill.addEventListener("pointerdown", handleDragPointerDown);
  dockBead.addEventListener("pointerdown", handleDragPointerDown);

  document.documentElement.addEventListener("mouseenter", () => {
    cancelDockHide();
    if (dockUi.mode === "hidden") {
      peekTimer = window.setTimeout(() => {
        peekTimer = undefined;
        void dispatchDock({ kind: "pointerEnter" });
      }, PEEK_DELAY_MS);
    }
  });

  document.documentElement.addEventListener("mouseleave", () => {
    clearPeekTimer();
    shouldHideWhenSettled = true;
    scheduleDockHide();
  });

  try {
    const currentWindow = getCurrentWindow() as ReturnType<typeof getCurrentWindow> & {
      onFocusChanged?: (handler: (event: { payload: boolean }) => void) => Promise<unknown>;
    };
    if (typeof currentWindow.onFocusChanged === "function") {
      void currentWindow.onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          clearPeekTimer();
          shouldHideWhenSettled = true;
          scheduleDockHide();
        } else {
          cancelDockHide();
        }
      }).catch((error) => {
        console.warn("window focus listener registration failed:", error);
      });
    }
  } catch (error) {
    console.warn("window focus listener registration failed:", error);
  }

  try {
    void getCurrentWindow().onMoved(() => {
      if (settings.edgeDockEnabled === false) {
        isNativeDragging = false;
        nativeDragReleaseWaiting = false;
        stopDockCursorPolling();
        return;
      }

      if (isNativeDragging) {
        if (nativeDragReleaseWaiting) {
          return;
        }
        if (moveDebounceTimer !== undefined) {
          window.clearTimeout(moveDebounceTimer);
        }
        moveDebounceTimer = window.setTimeout(async () => {
          moveDebounceTimer = undefined;
          if (
            !isNativeDragging ||
            nativeDragReleaseWaiting ||
            settings.edgeDockEnabled === false
          ) {
            return;
          }
          isNativeDragging = false;
          await runDockCheck({ allowDocked: true });
        }, MOVE_DEBOUNCE_MS);
        return;
      }

      if (dockUi.mode !== "none" || Date.now() < suppressMovedUntil) {
        return;
      }
      if (moveDebounceTimer !== undefined) {
        window.clearTimeout(moveDebounceTimer);
      }
      moveDebounceTimer = window.setTimeout(async () => {
        moveDebounceTimer = undefined;
        if (
          dockUi.mode !== "none" ||
          Date.now() < suppressMovedUntil ||
          settings.edgeDockEnabled === false
        ) {
          return;
        }
        await runDockCheck();
      }, MOVE_DEBOUNCE_MS);
    }).catch((error) => {
      console.warn("window move listener registration failed:", error);
    });
  } catch (error) {
    console.warn("window move listener registration failed:", error);
    // Window move events are only available inside the Tauri runtime.
  }

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
      dockBeadCore.classList.remove("status-blink");
    }
  });

  void listen(OPEN_EVENTS, () => {
    void (async () => {
      await dispatchDock({ kind: "pointerEnter" });
      setPanelOpen(true);
      await resizePanelWindow(true);
    })();
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
