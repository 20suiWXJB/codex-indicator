import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

test("default capability allows closing the settings window", () => {
  const capability = JSON.parse(fs.readFileSync("src-tauri/capabilities/default.json", "utf8"));

  assert.ok(capability.permissions.includes("core:window:allow-close"));
});

test("settings page mounts data-view on both html and body for scroll unlock", () => {
  const source = fs.readFileSync("src/settingsPage.ts", "utf8");

  assert.match(source, /document\.documentElement\.dataset\.view\s*=\s*"settings"/);
  assert.match(source, /document\.body\.dataset\.view\s*=\s*"settings"/);
});

test("CSS unlocks overflow on html[data-view=settings] to restore viewport scroll", () => {
  const css = fs.readFileSync("src/style.css", "utf8");

  assert.match(css, /html\[data-view="settings"\]/);
  assert.match(css, /overflow\s*:\s*visible/);
});

test("settings page saves effect controls from the rendered form", async () => {
  const settingsModel = loadSettingsModel();
  const { document, app } = createSettingsDom();
  let savedSettings;
  const invoke = async (command, args) => {
    if (command === "get_settings") {
      return { settings: settingsModel.DEFAULT_SETTINGS };
    }
    if (command === "save_settings") {
      savedSettings = args.settings;
      return { settings: args.settings };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const { renderSettingsPage } = loadSettingsPage(settingsModel, invoke, document);
  renderSettingsPage(app);
  await flushAsyncWork();

  app.querySelector('input[name="runningBreathEnabled"]').checked = false;
  app.querySelector('[name="runningBreathPeriodMs"]').value = "1800";
  app.querySelector('input[name="statusBlinkEnabled"]').checked = false;
  app.querySelector('[name="statusBlinkCount"]').value = "5";
  app.querySelector('[name="instanceActiveWindowMinutes"]').value = "15";
  app.querySelector(".settings-save").click();
  await flushAsyncWork();

  assert.equal(savedSettings.runningBreathEnabled, false);
  assert.equal(savedSettings.runningBreathPeriodMs, 1800);
  assert.equal(savedSettings.statusBlinkEnabled, false);
  assert.equal(savedSettings.statusBlinkCount, 5);
  assert.equal(savedSettings.instanceActiveWindowMinutes, 15);
});

test("settings page renders and saves multi-instance controls", async () => {
  const settingsModel = loadSettingsModel();
  const { document, app } = createSettingsDom();
  let savedSettings;
  const invoke = async (command, args) => {
    if (command === "get_settings") {
      return { settings: settingsModel.DEFAULT_SETTINGS };
    }
    if (command === "save_settings") {
      savedSettings = args.settings;
      return { settings: args.settings };
    }
    throw new Error(`Unexpected command: ${command}`);
  };

  const { renderSettingsPage } = loadSettingsPage(settingsModel, invoke, document);
  renderSettingsPage(app);
  await flushAsyncWork();

  const form = app.querySelector(".settings-form");
  const nav = app.querySelector(".settings-nav");

  assert.match(nav.innerHTML, /#instances/);
  assert.match(form.innerHTML, /id="instances"/);
  assert.ok(form.querySelector('[name="sessionRunningTtlSeconds"]'));
  assert.ok(form.querySelector('input[name="showInstanceList"]'));
  assert.ok(form.querySelector('input[name="eventInstancePrefix"]'));

  form.querySelector('[name="sessionRunningTtlSeconds"]').value = "300";
  form.querySelector('input[name="showInstanceList"]').checked = false;
  form.querySelector('input[name="eventInstancePrefix"]').checked = false;
  app.querySelector(".settings-save").click();
  await flushAsyncWork();

  assert.equal(savedSettings.sessionRunningTtlSeconds, 300);
  assert.equal(savedSettings.showInstanceList, false);
  assert.equal(savedSettings.eventInstancePrefix, false);
});

function loadSettingsModel() {
  return loadModule("src/settingsModel.ts", require);
}

function loadSettingsPage(settingsModel, invoke, document) {
  return loadModule("src/settingsPage.ts", (specifier) => {
    if (specifier === "@tauri-apps/api/core") {
      return { invoke };
    }
    if (specifier === "@tauri-apps/api/window") {
      return { getCurrentWindow: () => ({ close: async () => {} }) };
    }
    if (specifier === "./settingsModel") {
      return settingsModel;
    }
    return require(specifier);
  }, {
    document,
    window: { close: () => {} },
  });
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
    URLSearchParams,
    ...globals,
  });
  vm.runInContext(compiled, context, { filename: sourcePath });
  return module.exports;
}

function createSettingsDom() {
  const app = new FakeElement("app");
  const document = {
    body: new FakeElement("body"),
    documentElement: new FakeElement("html"),
  };
  return { document, app };
}

class FakeElement {
  constructor(kind = "element") {
    this.kind = kind;
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.listeners = new Map();
    this.byClass = new Map();
    this.controls = new Map();
    this.currents = new Map();
    this.actions = [];
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (this.kind === "app") {
      this.byClass = new Map([
        ["settings-nav", new FakeElement("nav")],
        ["settings-form", new FakeElement("form")],
        ["settings-alert", new FakeElement("alert")],
        ["settings-diagnostics", new FakeElement("pre")],
        ["settings-status", new FakeElement("status")],
        ["settings-save", new FakeElement("button")],
        ["settings-close", new FakeElement("button")],
      ]);
    } else if (this.kind === "form") {
      this.parseForm(value);
    }
  }

  get innerHTML() {
    return this._innerHTML ?? "";
  }

  querySelector(selector) {
    if (selector.startsWith(".")) {
      return this.byClass.get(selector.slice(1)) ?? null;
    }
    const controlName = selector.match(/(?:input)?\[name="([^"]+)"\]/)?.[1];
    if (controlName) {
      const control = this.controls.get(controlName) ?? this.findInChildren(selector);
      return selector.startsWith("input") && control?.tag !== "input" ? null : control;
    }
    const currentFor = selector.match(/\[data-current-for="([^"]+)"\]/)?.[1];
    if (currentFor) {
      return this.currents.get(currentFor) ?? this.findInChildren(selector);
    }
    return this.findInChildren(selector);
  }

  querySelectorAll(selector) {
    if (selector === "input, select") {
      return [...this.controls.values()].filter((control) => control.tag === "input" || control.tag === "select");
    }
    if (selector === "[data-action]") {
      return this.actions;
    }
    return [];
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

  parseForm(html) {
    this.controls = new Map();
    this.currents = new Map();
    this.actions = [];

    for (const match of html.matchAll(/<select name="([^"]+)">([\s\S]*?)<\/select>/g)) {
      const selected = match[2].match(/<option value="([^"]+)" selected>/) ?? match[2].match(/<option value="([^"]+)"/);
      this.controls.set(match[1], new FakeControl("select", match[1], selected?.[1] ?? ""));
    }

    for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
      const attrs = match[1];
      const name = attrs.match(/\bname="([^"]+)"/)?.[1];
      if (!name) {
        continue;
      }
      const type = attrs.match(/\btype="([^"]+)"/)?.[1] ?? "text";
      const value = unescapeHtml(attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? "");
      const control = new FakeControl("input", name, value);
      control.type = type;
      control.checked = /\bchecked\b/.test(attrs);
      this.controls.set(name, control);
    }

    for (const match of html.matchAll(/<span data-current-for="([^"]+)">([\s\S]*?)<\/span>/g)) {
      const current = new FakeElement("span");
      current.textContent = unescapeHtml(match[2]);
      this.currents.set(match[1], current);
    }

    for (const match of html.matchAll(/<button\b[^>]*data-action="([^"]+)"[^>]*>/g)) {
      const action = new FakeElement("button");
      action.dataset.action = match[1];
      this.actions.push(action);
    }
  }

  findInChildren(selector) {
    for (const child of this.byClass.values()) {
      const found = child.querySelector(selector);
      if (found) {
        return found;
      }
    }
    return null;
  }
}

class FakeControl extends FakeElement {
  constructor(tag, name, value) {
    super(tag);
    this.tag = tag;
    this.name = name;
    this.value = value;
    this.checked = false;
  }
}

function unescapeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}
