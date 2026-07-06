import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const SETTINGS_CHANGED = "indicator-settings-changed";

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

function loadSettingsModel() {
  return loadModule("src/settingsModel.ts", require);
}

function loadStatusPresenter() {
  return loadModule("src/statusPresenter.ts", require);
}

function loadMainPanel(settingsModel, invoke, listeners, document, window) {
  const statusPresenter = loadStatusPresenter();
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
        return { getCurrentWindow: () => ({ startDragging: async () => {} }) };
      }
      if (specifier === "./settingsModel") {
        return settingsModel;
      }
      if (specifier === "./statusPresenter") {
        return statusPresenter;
      }
      return require(specifier);
    },
    {
      document,
      window,
      console: { log: () => {}, error: () => {} },
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

function createInvoke({ getSettings, statuses, events = [] }) {
  return async (command) => {
    if (command === "get_settings") {
      return { settings: getSettings() };
    }
    if (command === "get_statuses") {
      return statuses;
    }
    if (command === "get_recent_events") {
      return events;
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
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
  };
  const window = {
    setInterval: () => 1,
    clearInterval: () => {},
  };
  return { document, window, app: new FakeElement("app") };
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
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}
