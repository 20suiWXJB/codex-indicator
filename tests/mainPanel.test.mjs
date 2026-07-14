import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const SETTINGS_CHANGED = "indicator-settings-changed";
const OPEN_EVENTS = "indicator-open-events";

test("main panel hides instance list after settings change without status change", async () => {
  const settingsModel = loadSettingsModel();
  let currentSettings = settingsModel.DEFAULT_SETTINGS;
  const listeners = new Map();
  const { document, window, app } = createMainPanelDom();
  const invoke = createInvoke({
    getSettings: () => currentSettings,
    statuses: {
      aggregate: runningPayload(),
      instances: [runningInstance()],
    },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  const instances = app.querySelector(".instances");
  assert.equal(instances.hidden, false);
  assert.equal(instances.children.length, 1);

  currentSettings = {
    ...settingsModel.DEFAULT_SETTINGS,
    showInstanceList: false,
  };
  await listeners.get(SETTINGS_CHANGED)();
  await flushAsyncWork();

  assert.equal(instances.hidden, true);
  assert.equal(instances.children.length, 0);
});

test("main panel omits event instance prefix when setting is disabled", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app } = createMainPanelDom();
  const invoke = createInvoke({
    getSettings: () => ({
      ...settingsModel.DEFAULT_SETTINGS,
      eventInstancePrefix: false,
    }),
    statuses: {
      aggregate: runningPayload(),
      instances: [runningInstance()],
    },
    events: [
      {
        status: "waiting",
        source: "codex",
        event: "PermissionRequest",
        summary: "needs approval",
        detail: "",
        createdAt: "2026-07-04T08:00:00.000Z",
        label: "indicator",
        cwd: "D:\\Code\\Tauri\\indicator",
      },
    ],
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  app.querySelector(".status-button").click();
  await flushAsyncWork();

  const eventBody = app.querySelector(".events").children[0].children[1];
  assert.equal(eventBody.textContent, "needs approval");
});

test("settings refresh keeps current dock peek state instead of restoring hidden", async () => {
  const settingsModel = loadSettingsModel();
  let currentSettings = settingsModel.DEFAULT_SETTINGS;
  const listeners = new Map();
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => currentSettings,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;

  currentSettings = {
    ...settingsModel.DEFAULT_SETTINGS,
    showInstanceList: false,
  };
  await listeners.get(SETTINGS_CHANGED)();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(calls.some((call) => call.command === "get_dock_state"), false);
  assert.equal(calls.some((call) => call.command === "set_dock_mode"), false);
});

test("dragging an expanded normal panel closes native height before dock check misses", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: null,
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  app.querySelector(".status-button").click();
  await flushAsyncWork();
  assert.equal(calls.some((call) => call.command === "set_panel_open" && call.args.open === true), true);
  calls.length = 0;

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_panel_open" || call.command === "dock_check")
      .map((call) => ({ command: call.command, open: call.args?.open })),
    [
      { command: "set_panel_open", open: false },
      { command: "dock_check", open: undefined },
    ],
  );
});

test("window focus loss hides dock peek after configured delay", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let focusHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const timeoutDelays = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = (handler, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(handler, delay);
  };
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    onFocusChanged: async (handler) => {
      focusHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(typeof focusHandler, "function");
  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;

  focusHandler({ payload: false });
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    timeoutDelays[timeoutDelays.length - 1],
    settingsModel.DEFAULT_SETTINGS.dockHideDelayMs,
  );

  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_dock_mode")
      .map((call) => ({ command: call.command, mode: call.args?.mode })),
    [{ command: "set_dock_mode", mode: "hidden" }],
  );
});

test("window focus gain cancels pending dock hide", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let focusHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    onFocusChanged: async (handler) => {
      focusHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(typeof focusHandler, "function");

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;

  focusHandler({ payload: false });
  focusHandler({ payload: true });
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("repeated window focus loss keeps a single cancellable dock hide timer", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let focusHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const timeoutDelays = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = (handler, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(handler, delay);
  };
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    onFocusChanged: async (handler) => {
      focusHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(typeof focusHandler, "function");

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;
  timeoutDelays.length = 0;

  focusHandler({ payload: false });
  focusHandler({ payload: false });
  assert.equal(
    timeoutDelays.filter((delay) => delay === settingsModel.DEFAULT_SETTINGS.dockHideDelayMs)
      .length,
    1,
  );
  focusHandler({ payload: true });
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("document mouseleave hides dock peek after configured delay", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const timeoutDelays = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = (handler, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(handler, delay);
  };
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;
  timeoutDelays.length = 0;

  document.documentElement.fire("mouseleave");
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    timeoutDelays[timeoutDelays.length - 1],
    settingsModel.DEFAULT_SETTINGS.dockHideDelayMs,
  );

  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_dock_mode")
      .map((call) => ({ command: call.command, mode: call.args?.mode })),
    [{ command: "set_dock_mode", mode: "hidden" }],
  );
});

test("document mouseenter cancels pending dock hide after mouseleave", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const timeoutDelays = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = (handler, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(handler, delay);
  };
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;
  timeoutDelays.length = 0;

  document.documentElement.fire("mouseleave");
  assert.equal(
    timeoutDelays.filter((delay) => delay === settingsModel.DEFAULT_SETTINGS.dockHideDelayMs)
      .length,
    1,
  );
  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("repeated document mouseleave keeps a single cancellable dock hide timer", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const timeoutDelays = [];
  const setTimeout = window.setTimeout;
  window.setTimeout = (handler, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(handler, delay);
  };
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;
  timeoutDelays.length = 0;

  document.documentElement.fire("mouseleave");
  document.documentElement.fire("mouseleave");
  assert.equal(
    timeoutDelays.filter((delay) => delay === settingsModel.DEFAULT_SETTINGS.dockHideDelayMs)
      .length,
    1,
  );
  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("document mouseenter cancels pending dock hide after window focus loss", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let focusHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    onFocusChanged: async (handler) => {
      focusHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(typeof focusHandler, "function");

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  calls.length = 0;

  focusHandler({ payload: false });
  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("global cursor polling hides dock peek after configured delay", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts, runIntervals, activeIntervalCount } =
    createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    outerPosition: async () => ({ x: 1700, y: 100 }),
    outerSize: async () => ({ width: 220, height: 72 }),
  };
  const cursorPosition = async () => ({ x: 1600, y: 120 });
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
    cursorPosition,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(activeIntervalCount(100), 1);
  calls.length = 0;

  await runIntervals(100);
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );

  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.equal(activeIntervalCount(100), 0);
});

test("global cursor polling cancels pending hide while cursor is inside window", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts, runIntervals } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    outerPosition: async () => ({ x: 1700, y: 100 }),
    outerSize: async () => ({ width: 220, height: 72 }),
  };
  const cursorPosition = async () => ({ x: 1800, y: 120 });
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
    cursorPosition,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();
  document.documentElement.fire("mouseleave");

  await runIntervals(100);
  await flushAsyncWork();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.equal(
    calls.some(
      (call) => call.command === "set_dock_mode" && call.args?.mode === "hidden",
    ),
    false,
  );
});

test("dock cursor polling keeps one interval and stops after leaving peek", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts, activeIntervalCount } = createMainPanelDom();
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    outerPosition: async () => ({ x: 1700, y: 100 }),
    outerSize: async () => ({ width: 220, height: 72 }),
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
    async () => ({ x: 1600, y: 120 }),
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();
  document.documentElement.fire("mouseenter");

  assert.equal(activeIntervalCount(100), 1);

  document.documentElement.fire("mouseleave");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.equal(activeIntervalCount(100), 0);
});

test("starting a drag stops dock cursor polling", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app, runTimeouts, activeIntervalCount } = createMainPanelDom();
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    outerPosition: async () => ({ x: 1700, y: 100 }),
    outerSize: async () => ({ width: 220, height: 72 }),
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
    async () => ({ x: 1800, y: 120 }),
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(activeIntervalCount(100), 1);

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  await flushAsyncWork();

  assert.equal(activeIntervalCount(100), 0);
});

test("disabling edge docking stops cursor polling and undocks peek", async () => {
  const settingsModel = loadSettingsModel();
  let currentSettings = settingsModel.DEFAULT_SETTINGS;
  const listeners = new Map();
  const { document, window, app, runTimeouts, activeIntervalCount } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => currentSettings,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async () => () => {},
    outerPosition: async () => ({ x: 1700, y: 100 }),
    outerSize: async () => ({ width: 220, height: 72 }),
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
    async () => ({ x: 1800, y: 120 }),
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  document.documentElement.fire("mouseenter");
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(activeIntervalCount(100), 1);
  calls.length = 0;
  currentSettings = {
    ...settingsModel.DEFAULT_SETTINGS,
    edgeDockEnabled: false,
  };

  listeners.get(SETTINGS_CHANGED)();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "none");
  assert.equal(activeIntervalCount(100), 0);
  assert.equal(calls.some((call) => call.command === "undock_window"), true);
});

test("native move while dock hidden does not run dock check", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
    dockCheckResult: "right",
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(typeof movedHandler, "function");
  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  calls.length = 0;

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.equal(calls.some((call) => call.command === "dock_check"), false);
});

test("hidden dock move after settled leave does not rebound to peek", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    const settingsModel = loadSettingsModel();
    const listeners = new Map();
    let movedHandler;
    const { document, window, app, runTimeouts } = createMainPanelDom();
    const calls = [];
    const invoke = createInvoke({
      getSettings: () => settingsModel.DEFAULT_SETTINGS,
      statuses: {
        aggregate: runningPayload(),
        instances: [],
      },
      calls,
      dockState: { edge: "right" },
      dockCheckResult: "right",
    });
    const windowApi = {
      startDragging: async () => {},
      onMoved: async (handler) => {
        movedHandler = handler;
        return () => {};
      },
    };
    const { renderMainPanel } = loadMainPanel(
      settingsModel,
      invoke,
      listeners,
      document,
      window,
      windowApi,
    );

    renderMainPanel(app);
    await flushAsyncWork();
    await flushAsyncWork();

    document.documentElement.fire("mouseenter");
    await runTimeouts();
    await flushAsyncWork();

    assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
    calls.length = 0;

    document.documentElement.fire("mouseleave");
    await runTimeouts();
    await flushAsyncWork();

    assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
    now += 1_000;
    movedHandler();
    await runTimeouts();
    await flushAsyncWork();

    assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
    assert.deepEqual(
      calls
        .filter((call) => call.command === "set_dock_mode")
        .map((call) => ({ command: call.command, mode: call.args?.mode })),
      [{ command: "set_dock_mode", mode: "hidden" }],
    );
    assert.equal(calls.some((call) => call.command === "dock_check"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("native move while dock peek waits for explicit drag before dock check", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;

  try {
    const settingsModel = loadSettingsModel();
    const listeners = new Map();
    let movedHandler;
    const { document, window, app, runTimeouts } = createMainPanelDom();
    const calls = [];
    const invoke = createInvoke({
      getSettings: () => settingsModel.DEFAULT_SETTINGS,
      statuses: {
        aggregate: runningPayload(),
        instances: [],
      },
      calls,
      dockState: { edge: "right" },
      dockCheckResult: null,
    });
    const windowApi = {
      startDragging: async () => {},
      onMoved: async (handler) => {
        movedHandler = handler;
        return () => {};
      },
    };
    const { renderMainPanel } = loadMainPanel(
      settingsModel,
      invoke,
      listeners,
      document,
      window,
      windowApi,
    );

    renderMainPanel(app);
    await flushAsyncWork();
    await flushAsyncWork();

    document.documentElement.fire("mouseenter");
    await runTimeouts();
    await flushAsyncWork();

    assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
    calls.length = 0;
    now += 1_000;

    movedHandler();
    await runTimeouts();
    await flushAsyncWork();

    assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
    assert.equal(calls.some((call) => call.command === "dock_check"), false);
    assert.equal(calls.some((call) => call.command === "undock_window"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("native drag runs dock check after move events settle", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: "right",
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  calls.length = 0;

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  movedHandler();
  movedHandler();
  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), true);
  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.notEqual(app.querySelector(".dock-bead"), null);
  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_dock_mode")
      .map((call) => ({ command: call.command, mode: call.args?.mode })),
    [{ command: "set_dock_mode", mode: "hidden" }],
  );

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.filter((call) => call.command === "dock_check").length, 1);
});

test("native drag release runs one dock check and ignores move events while waiting", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  let releaseDrag;
  const releasePromise = new Promise((resolve) => {
    releaseDrag = resolve;
  });
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: "right",
    nativeReleaseSupported: true,
    waitForNativeDragRelease: () => releasePromise,
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  calls.length = 0;

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  movedHandler();
  await flushAsyncWork();
  await flushAsyncWork();

  movedHandler();
  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  releaseDrag();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(calls.filter((call) => call.command === "dock_check").length, 1);
  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  assert.notEqual(app.querySelector(".dock-bead"), null);
  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_dock_mode")
      .map((call) => ({ command: call.command, mode: call.args?.mode })),
    [{ command: "set_dock_mode", mode: "hidden" }],
  );

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.filter((call) => call.command === "dock_check").length, 1);
});

test("native drag release command failure falls back to move debounce", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: "right",
    nativeReleaseSupported: true,
    waitForNativeDragRelease: async () => {
      throw new Error("native wait failed");
    },
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  calls.length = 0;

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  await flushAsyncWork();
  await flushAsyncWork();

  movedHandler();
  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.filter((call) => call.command === "dock_check").length, 1);
});

test("native drag move settling skips dock check when edge docking is disabled", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => ({
      ...settingsModel.DEFAULT_SETTINGS,
      edgeDockEnabled: false,
    }),
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: "right",
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();
  calls.length = 0;

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  await flushAsyncWork();

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), false);
});

test("native drag move settling closes expanded panel before dock check", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: null,
    dockCheckResult: null,
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  app.querySelector(".status-button").click();
  await flushAsyncWork();
  calls.length = 0;

  app.querySelector(".pill").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".pill"),
  });
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_panel_open" || call.command === "dock_check")
      .map((call) => ({ command: call.command, open: call.args?.open })),
    [
      { command: "set_panel_open", open: false },
      { command: "dock_check", open: undefined },
    ],
  );
});

test("short native drag from hidden dock bead can undock during move suppression", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  let movedHandler;
  const { document, window, app, runTimeouts } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
    dockCheckResult: null,
  });
  const windowApi = {
    startDragging: async () => {},
    onMoved: async (handler) => {
      movedHandler = handler;
      return () => {};
    },
  };
  const { renderMainPanel } = loadMainPanel(
    settingsModel,
    invoke,
    listeners,
    document,
    window,
    windowApi,
  );

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  calls.length = 0;

  app.querySelector(".dock-bead").fire("pointerdown", {
    button: 0,
    target: app.querySelector(".dock-bead"),
  });
  await flushAsyncWork();

  assert.equal(calls.some((call) => call.command === "dock_check"), false);

  movedHandler();
  await runTimeouts();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "none");
  assert.deepEqual(
    calls
      .filter((call) => call.command === "dock_check" || call.command === "undock_window")
      .map((call) => ({ command: call.command })),
    [{ command: "dock_check" }, { command: "undock_window" }],
  );
});

test("open event peeks hidden dock before expanding the panel", async () => {
  const settingsModel = loadSettingsModel();
  const listeners = new Map();
  const { document, window, app } = createMainPanelDom();
  const calls = [];
  const invoke = createInvoke({
    getSettings: () => settingsModel.DEFAULT_SETTINGS,
    statuses: {
      aggregate: runningPayload(),
      instances: [],
    },
    calls,
    dockState: { edge: "right" },
  });
  const { renderMainPanel } = loadMainPanel(settingsModel, invoke, listeners, document, window);

  renderMainPanel(app);
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "hidden");
  calls.length = 0;

  listeners.get(OPEN_EVENTS)();
  await flushAsyncWork();
  await flushAsyncWork();

  assert.equal(app.querySelector(".shell").dataset.dockMode, "peek");
  assert.deepEqual(
    calls
      .filter((call) => call.command === "set_dock_mode" || call.command === "set_panel_open")
      .map((call) => ({ command: call.command, mode: call.args?.mode, open: call.args?.open })),
    [
      { command: "set_dock_mode", mode: "peek", open: undefined },
      { command: "set_panel_open", mode: undefined, open: true },
    ],
  );
});


function loadSettingsModel() {
  return loadModule("src/settingsModel.ts", require);
}

function loadStatusPresenter() {
  return loadModule("src/statusPresenter.ts", require);
}

function loadMainPanel(
  settingsModel,
  invoke,
  listeners,
  document,
  window,
  windowApi,
  cursorPosition = async () => ({ x: 0, y: 0 }),
) {
  const statusPresenter = loadStatusPresenter();
  const dockModel = loadModule("src/dockModel.ts", require);
  return loadModule(
    "src/mainPanel.ts",
    (specifier) => {
      if (specifier === "@tauri-apps/api/core") {
        return { invoke };
      }
      if (specifier === "@tauri-apps/api/event") {
        return {
          listen: async (event, handler) => {
            listeners.set(event, handler);
            return () => {};
          },
        };
      }
      if (specifier === "@tauri-apps/api/window") {
        return {
          cursorPosition,
          getCurrentWindow: () =>
            windowApi ?? {
              startDragging: async () => {},
              onMoved: async () => () => {},
              outerPosition: async () => ({ x: 0, y: 0 }),
              outerSize: async () => ({ width: 220, height: 72 }),
            },
        };
      }
      if (specifier === "./settingsModel") {
        return settingsModel;
      }
      if (specifier === "./statusPresenter") {
        return statusPresenter;
      }
      if (specifier === "./dockModel") {
        return dockModel;
      }
      return require(specifier);
    },
    {
      document,
      window,
      console: { log: () => {}, error: () => {}, warn: () => {} },
      Element: FakeElement,
    },
  );
}

function loadModule(sourceFile, moduleRequire, globals = {}) {
  const sourcePath = path.resolve(sourceFile);
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: moduleRequire,
    Date,
    Intl,
    ...globals,
  });
  vm.runInContext(compiled, context, { filename: sourcePath });
  return module.exports;
}

function createInvoke({
  getSettings,
  statuses,
  events = [],
  calls = [],
  dockState = null,
  dockCheckResult = null,
  nativeReleaseSupported = false,
  waitForNativeDragRelease = async () => {},
}) {
  return async (command, args = {}) => {
    calls.push({ command, args });
    if (command === "get_settings") {
      return { settings: getSettings() };
    }
    if (command === "get_statuses") {
      return statuses;
    }
    if (command === "get_recent_events") {
      return events;
    }
    if (command === "get_dock_state") {
      return dockState;
    }
    if (command === "dock_check") {
      return dockCheckResult;
    }
    if (command === "is_native_drag_release_supported") {
      return nativeReleaseSupported;
    }
    if (command === "wait_for_native_drag_release") {
      return waitForNativeDragRelease();
    }
    return undefined;
  };
}

function runningPayload() {
  return {
    status: "running",
    source: "codex",
    event: "",
    summary: "Codex running",
    detail: "",
    updatedAt: "2026-07-04T08:00:00.000Z",
    ttlMs: 0,
  };
}

function runningInstance() {
  return {
    id: "indicator",
    label: "indicator",
    cwd: "D:\\Code\\Tauri\\indicator",
    status: "running",
    summary: "Codex running",
    detail: "",
    updatedAt: "2026-07-04T08:00:00.000Z",
    ttlMs: 0,
  };
}

function createMainPanelDom() {
  let nextTimerId = 1;
  const timers = new Map();
  const intervals = new Map();
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
  };
  const window = {
    setInterval: (handler, delay) => {
      const id = nextTimerId++;
      intervals.set(id, { handler, delay });
      return id;
    },
    clearInterval: (id) => {
      intervals.delete(id);
    },
    setTimeout: (handler) => {
      const id = nextTimerId++;
      timers.set(id, handler);
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  const runTimeouts = async () => {
    const pending = [...timers.entries()];
    timers.clear();
    for (const [, handler] of pending) {
      await handler();
    }
  };
  const runIntervals = async (delay) => {
    for (const { handler, delay: intervalDelay } of [...intervals.values()]) {
      if (delay === undefined || delay === intervalDelay) {
        await handler();
      }
    }
  };
  const activeIntervalCount = (delay) =>
    [...intervals.values()].filter((interval) => delay === undefined || interval.delay === delay)
      .length;
  return {
    document,
    window,
    app: new FakeElement("app"),
    runTimeouts,
    runIntervals,
    activeIntervalCount,
  };
}

class FakeElement {
  constructor(kind = "element") {
    this.kind = kind;
    this.dataset = {};
    this.hidden = false;
    this.textContent = "";
    this.title = "";
    this.dateTime = "";
    this.children = [];
    this.listeners = new Map();
    this.byClass = new Map();
    this.style = { setProperty: () => {} };
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
    };
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (this.kind === "app") {
      this.byClass = new Map(
        [
          "shell",
          "pill",
          "dock-bead",
          "dock-bead-core",
          "status-button",
          "settings",
          "pin",
          "close",
          "open-state",
          "open-logs",
          "lamp",
          "label",
          "summary",
          "instances",
          "events",
        ].map((name) => [name, new FakeElement(name)]),
      );
    }
  }

  get innerHTML() {
    return this._innerHTML ?? "";
  }

  set className(value) {
    this._className = value;
  }

  get className() {
    return this._className ?? "";
  }

  get offsetWidth() {
    return 1;
  }

  querySelector(selector) {
    if (selector.startsWith(".")) {
      return this.byClass.get(selector.slice(1)) ?? null;
    }
    return null;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  fire(type, event = { type, target: this }) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }

  click() {
    for (const handler of this.listeners.get("click") ?? []) {
      handler({ type: "click", target: this });
    }
  }

  replaceChildren(...children) {
    this.children = children;
  }

  append(...children) {
    this.children.push(...children);
  }

  closest(selector) {
    if (selector === "button" && this.kind.includes("button")) {
      return this;
    }
    return null;
  }
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}
