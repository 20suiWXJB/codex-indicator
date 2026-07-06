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
  assert.equal(settings.sessionRunningTtlSeconds, 120);
  assert.equal(settings.showInstanceList, true);
  assert.equal(settings.eventInstancePrefix, true);
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
    sessionRunningTtlSeconds: 1801,
    showDoneSettleMs: 50,
    showInstanceList: "yes",
    eventInstancePrefix: 1,
  });

  assert.equal(settings.language, "zh-CN");
  assert.equal(settings.theme, "system");
  assert.equal(settings.alwaysOnTop, true);
  assert.equal(settings.panelExpandedHeight, 620);
  assert.equal(settings.stateDirMode, "auto");
  assert.equal(settings.stateDir, "C:\\tmp\\indicator-state");
  assert.equal(settings.pollIntervalMs, 250);
  assert.equal(settings.sessionRunningTtlSeconds, 1800);
  assert.equal(settings.showDoneSettleMs, 500);
  assert.equal(settings.showInstanceList, true);
  assert.equal(settings.eventInstancePrefix, true);
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

test("effect settings have correct defaults", () => {
  const { DEFAULT_SETTINGS } = loadSettingsModel();
  assert.equal(DEFAULT_SETTINGS.runningBreathEnabled, true);
  assert.equal(DEFAULT_SETTINGS.runningBreathPeriodMs, 2400);
  assert.equal(DEFAULT_SETTINGS.statusBlinkEnabled, true);
  assert.equal(DEFAULT_SETTINGS.statusBlinkCount, 3);
});

test("instance active window setting has default and visible metadata", () => {
  const { DEFAULT_SETTINGS, SETTING_SECTIONS, formatSettingValue } = loadSettingsModel();
  const item = SETTING_SECTIONS.flatMap((section) => section.items)
    .find((candidate) => candidate.key === "instanceActiveWindowMinutes");
  const instancesSection = SETTING_SECTIONS.find((section) => section.id === "instances");
  const sourcesSection = SETTING_SECTIONS.find((section) => section.id === "sources");

  assert.equal(DEFAULT_SETTINGS.instanceActiveWindowMinutes, 10);
  assert.ok(instancesSection, "instances section should exist");
  assert.ok(item, "instanceActiveWindowMinutes should be visible in settings");
  assert.ok(instancesSection.items.some((candidate) => candidate.key === "instanceActiveWindowMinutes"));
  assert.ok(!sourcesSection.items.some((candidate) => candidate.key === "instanceActiveWindowMinutes"));
  assert.equal(item.min, 1);
  assert.equal(item.max, 60);
  assert.equal(formatSettingValue("instanceActiveWindowMinutes", DEFAULT_SETTINGS), "10分钟");
});

test("instance active window setting is clamped to 1-60 minutes", () => {
  const { normalizeSettings } = loadSettingsModel();

  assert.equal(normalizeSettings({ instanceActiveWindowMinutes: 0 }).instanceActiveWindowMinutes, 1);
  assert.equal(normalizeSettings({ instanceActiveWindowMinutes: 90 }).instanceActiveWindowMinutes, 60);
  assert.equal(normalizeSettings({ instanceActiveWindowMinutes: "18" }).instanceActiveWindowMinutes, 18);
});

test("multi-instance settings have defaults, metadata, and formatting", () => {
  const { DEFAULT_SETTINGS, SETTING_SECTIONS, formatSettingValue } = loadSettingsModel();
  const instancesSection = SETTING_SECTIONS.find((section) => section.id === "instances");
  const keys = [...instancesSection.items.map((item) => item.key)];
  const runningTtl = instancesSection.items.find((item) => item.key === "sessionRunningTtlSeconds");

  assert.equal(DEFAULT_SETTINGS.sessionRunningTtlSeconds, 120);
  assert.equal(DEFAULT_SETTINGS.showInstanceList, true);
  assert.equal(DEFAULT_SETTINGS.eventInstancePrefix, true);
  assert.deepEqual(keys, [
    "instanceActiveWindowMinutes",
    "sessionRunningTtlSeconds",
    "showInstanceList",
    "eventInstancePrefix",
  ]);
  assert.equal(runningTtl.min, 30);
  assert.equal(runningTtl.max, 1800);
  assert.equal(runningTtl.step, 30);
  assert.equal(runningTtl.unit, "秒");
  assert.equal(formatSettingValue("sessionRunningTtlSeconds", DEFAULT_SETTINGS), "120秒");
  assert.equal(formatSettingValue("showInstanceList", DEFAULT_SETTINGS), "开启");
  assert.equal(formatSettingValue("eventInstancePrefix", DEFAULT_SETTINGS), "开启");
});

test("session running ttl is clamped and invalid values fall back", () => {
  const { normalizeSettings } = loadSettingsModel();

  assert.equal(normalizeSettings({ sessionRunningTtlSeconds: 29 }).sessionRunningTtlSeconds, 30);
  assert.equal(normalizeSettings({ sessionRunningTtlSeconds: 1801 }).sessionRunningTtlSeconds, 1800);
  assert.equal(normalizeSettings({ sessionRunningTtlSeconds: "90" }).sessionRunningTtlSeconds, 90);
  assert.equal(normalizeSettings({ sessionRunningTtlSeconds: "slow" }).sessionRunningTtlSeconds, 120);
});

test("effect settings are clamped on out-of-range values", () => {
  const { normalizeSettings } = loadSettingsModel();

  // breath period 越界
  const tooFast = normalizeSettings({ runningBreathPeriodMs: 200 });
  assert.equal(tooFast.runningBreathPeriodMs, 800);

  const tooSlow = normalizeSettings({ runningBreathPeriodMs: 99999 });
  assert.equal(tooSlow.runningBreathPeriodMs, 6000);

  // blink count 越界
  const zeroBlink = normalizeSettings({ statusBlinkCount: 0 });
  assert.equal(zeroBlink.statusBlinkCount, 1);

  const tooMany = normalizeSettings({ statusBlinkCount: 999 });
  assert.equal(tooMany.statusBlinkCount, 10);
});

test("effect settings fall back to defaults on invalid types", () => {
  const { normalizeSettings } = loadSettingsModel();

  const broken = normalizeSettings({
    runningBreathEnabled: "yes",
    runningBreathPeriodMs: "slow",
    statusBlinkEnabled: 1,
    statusBlinkCount: "many",
  });

  assert.equal(broken.runningBreathEnabled, true);
  assert.equal(broken.runningBreathPeriodMs, 2400);
  assert.equal(broken.statusBlinkEnabled, true);
  assert.equal(broken.statusBlinkCount, 3);
});

test("formatSettingValue handles effect fields", () => {
  const { formatSettingValue, DEFAULT_SETTINGS } = loadSettingsModel();

  // 默认值格式化
  assert.equal(formatSettingValue("runningBreathPeriodMs", DEFAULT_SETTINGS), "2400ms");
  assert.equal(formatSettingValue("statusBlinkCount", DEFAULT_SETTINGS), "3次");

  // boolean 字段走 default 分支
  assert.equal(formatSettingValue("runningBreathEnabled", DEFAULT_SETTINGS), "开启");
  assert.equal(formatSettingValue("statusBlinkEnabled", DEFAULT_SETTINGS), "开启");
});
