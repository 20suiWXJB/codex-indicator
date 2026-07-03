import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadSettingsModel() {
  const sourcePath = path.resolve("src/settingsModel.ts");
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
    require,
    URLSearchParams,
  });
  vm.runInContext(compiled, context, { filename: sourcePath });
  return module.exports;
}

test("missing setting fields are completed from defaults", () => {
  const { completeSettings } = loadSettingsModel();

  const settings = completeSettings({
    theme: "dark",
    notifyOnError: false,
    pollIntervalMs: 1000,
  });

  assert.equal(settings.language, "zh-CN");
  assert.equal(settings.theme, "dark");
  assert.equal(settings.notifyOnError, false);
  assert.equal(settings.pollIntervalMs, 1000);
  assert.equal(settings.alwaysOnTop, true);
  assert.equal(settings.stateDir, "");
});

test("invalid setting values are normalized before save", () => {
  const { normalizeSettings } = loadSettingsModel();

  const settings = normalizeSettings({
    language: "fr-FR",
    theme: "neon",
    alwaysOnTop: "yes",
    panelExpandedHeight: 900,
    stateDirMode: "manual",
    stateDir: "  C:\\tmp\\indicator-state  ",
    pollIntervalMs: 10,
    showDoneSettleMs: 50,
  });

  assert.equal(settings.language, "zh-CN");
  assert.equal(settings.theme, "system");
  assert.equal(settings.alwaysOnTop, true);
  assert.equal(settings.panelExpandedHeight, 620);
  assert.equal(settings.stateDirMode, "auto");
  assert.equal(settings.stateDir, "C:\\tmp\\indicator-state");
  assert.equal(settings.pollIntervalMs, 250);
  assert.equal(settings.showDoneSettleMs, 500);
});

test("every persisted setting has visible explanatory copy", () => {
  const { DEFAULT_SETTINGS, SETTING_SECTIONS } = loadSettingsModel();

  const coveredKeys = new Set();
  for (const section of SETTING_SECTIONS) {
    assert.ok(section.title.trim(), `section ${section.id} should have a title`);
    for (const item of section.items) {
      assert.ok(item.title.trim(), `item in ${section.id} should have a title`);
      assert.ok(item.description.trim(), `${item.title} should explain the setting`);
      if (item.key) {
        coveredKeys.add(item.key);
      }
    }
  }

  assert.deepEqual(
    [...coveredKeys].sort(),
    Object.keys(DEFAULT_SETTINGS).sort(),
  );
});

test("window kind resolves settings and main entry points", () => {
  const { resolveWindowKind } = loadSettingsModel();

  assert.equal(resolveWindowKind("?window=settings", "main"), "settings");
  assert.equal(resolveWindowKind("", "settings"), "settings");
  assert.equal(resolveWindowKind("?window=main", "settings"), "main");
  assert.equal(resolveWindowKind("", "main"), "main");
});
