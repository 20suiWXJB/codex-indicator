import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  describeStatus,
  EventPayload,
  formatEventTime,
  idleStatus,
  resolveDisplayStatus,
  StatusPayload,
  trimText,
} from "./statusPresenter";
import "./style.css";

const POLL_MS = 500;
const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app container");
}

app.innerHTML = `
  <main class="shell" data-panel-open="false">
    <section class="pill" title="AI 状态" aria-live="polite">
      <button class="status-button" type="button" aria-label="切换最近事件">
        <span class="lamp" aria-hidden="true"></span>
        <span class="copy">
          <span class="label">空闲</span>
          <span class="summary">无活动</span>
        </span>
      </button>
      <div class="actions" aria-label="窗口操作">
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
const pinButton = app.querySelector<HTMLButtonElement>(".pin")!;
const closeButton = app.querySelector<HTMLButtonElement>(".close")!;
const openStateButton = app.querySelector<HTMLButtonElement>(".open-state")!;
const openLogsButton = app.querySelector<HTMLButtonElement>(".open-logs")!;
const lamp = app.querySelector<HTMLElement>(".lamp")!;
const label = app.querySelector<HTMLElement>(".label")!;
const summary = app.querySelector<HTMLElement>(".summary")!;
const eventsList = app.querySelector<HTMLOListElement>(".events")!;

let lastStatus = idleStatus();
let panelOpen = false;
let alwaysOnTop = true;

function setPanelOpen(open: boolean) {
  panelOpen = open;
  shell.dataset.panelOpen = String(open);
  if (open) {
    void refreshEvents();
  }
}

function renderStatus(payload: StatusPayload) {
  const displayStatus = resolveDisplayStatus(payload);
  const displayPayload = { ...payload, status: displayStatus };
  const copy = describeStatus(displayPayload);

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

async function refreshStatus() {
  try {
    lastStatus = await invoke<StatusPayload>("get_status");
  } catch (error) {
    lastStatus = idleStatus(error instanceof Error ? error.message : "状态读取失败");
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
    await invoke("set_panel_open", { open });
  } catch {
    // The panel can still render in dev browsers outside Tauri.
  }
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
pinButton.addEventListener("click", async () => {
  alwaysOnTop = !alwaysOnTop;
  await invoke("set_always_on_top", { enabled: alwaysOnTop });
  pinButton.classList.toggle("active", alwaysOnTop);
});
closeButton.addEventListener("click", () => invoke("hide_window"));
openStateButton.addEventListener("click", () => invoke("open_state_dir"));
openLogsButton.addEventListener("click", () => invoke("open_logs_dir"));

void listen("indicator-open-events", () => {
  setPanelOpen(true);
  void resizePanelWindow(true);
});
pinButton.classList.add("active");
void refreshStatus();
window.setInterval(refreshStatus, POLL_MS);
