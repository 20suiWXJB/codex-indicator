import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadPresenter() {
  const sourcePath = path.resolve("src/statusPresenter.ts");
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
  });
  vm.runInContext(compiled, context, { filename: sourcePath });
  return module.exports;
}

test("done status displays as idle after the local settle window", () => {
  const { resolveDisplayStatus } = loadPresenter();
  const payload = {
    status: "done",
    source: "codex",
    event: "Stop",
    summary: "Codex complete",
    detail: "",
    updatedAt: "2026-07-02T08:00:00.000Z",
    ttlMs: 0,
  };

  assert.equal(resolveDisplayStatus(payload, Date.parse(payload.updatedAt) + 3499), "done");
  assert.equal(resolveDisplayStatus(payload, Date.parse(payload.updatedAt) + 3500), "idle");
});

test("running status is not locally downgraded", () => {
  const { resolveDisplayStatus } = loadPresenter();
  const payload = {
    status: "running",
    source: "codex",
    event: "",
    summary: "Codex running",
    detail: "",
    updatedAt: "2026-07-02T08:00:00.000Z",
    ttlMs: 0,
  };

  assert.equal(resolveDisplayStatus(payload, Date.parse(payload.updatedAt) + 60_000), "running");
});

test("status copy labels running state in Chinese", () => {
  const { describeStatus } = loadPresenter();

  const copy = describeStatus({
      status: "running",
      source: "codex",
      event: "",
      summary: "Codex 运行中",
      detail: "",
      updatedAt: "2026-07-02T08:00:00.000Z",
      ttlMs: 0,
    });

  assert.equal(copy.label, "运行中");
  assert.equal(copy.title, "Codex 运行中");
});

test("aggregate subtitle summarizes active instance counts by status", () => {
  const { formatAggregateSubtitle } = loadPresenter();

  const subtitle = formatAggregateSubtitle([
    { id: "a", label: "api", cwd: "D:\\api", status: "running", summary: "", detail: "", updatedAt: "", ttlMs: 0 },
    { id: "b", label: "ui", cwd: "D:\\ui", status: "running", summary: "", detail: "", updatedAt: "", ttlMs: 0 },
    { id: "c", label: "docs", cwd: "D:\\docs", status: "waiting", summary: "", detail: "", updatedAt: "", ttlMs: 0 },
  ]);

  assert.equal(subtitle, "2运行 1等待");
});

test("instance status copy reuses status labels and cwd detail", () => {
  const { describeInstanceStatus } = loadPresenter();

  const copy = describeInstanceStatus({
    id: "a",
    label: "indicator",
    cwd: "D:\\Code\\Tauri\\indicator",
    status: "waiting",
    summary: "等待批准",
    detail: "powershell",
    updatedAt: "2026-07-04T08:00:00.000Z",
    ttlMs: 0,
  });

  assert.equal(copy.label, "等待输入");
  assert.equal(copy.title, "indicator");
  assert.equal(copy.detail, "D:\\Code\\Tauri\\indicator\npowershell");
});

test("status copy keeps unknown details out of the primary label", () => {
  const { describeStatus } = loadPresenter();

  const copy = describeStatus({
      status: "waiting",
      source: "codex",
      event: "PermissionRequest",
      summary: "Codex is waiting",
      detail: "powershell.exe ...",
      updatedAt: "2026-07-02T08:00:00.000Z",
      ttlMs: 0,
    });

  assert.equal(copy.label, "等待输入");
  assert.equal(copy.title, "Codex is waiting");
  assert.equal(copy.detail, "powershell.exe ...");
});

test("event formatting is compact and stable", () => {
  const { formatEventTime, trimText } = loadPresenter();
  const sampleDate = new Date("2026-07-02T08:09:10.000Z");
  const expectedTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(sampleDate);

  assert.equal(formatEventTime(sampleDate.toISOString()), expectedTime);
  assert.equal(trimText("a".repeat(90), 12), "aaaaaaaaa...");
});

test("shouldBlink returns false for identical states", () => {
  const { shouldBlink } = loadPresenter();
  assert.equal(shouldBlink("running", "running"), false);
  assert.equal(shouldBlink("idle", "idle"), false);
  assert.equal(shouldBlink("waiting", "waiting"), false);
});

test("shouldBlink returns false for connecting→any (initial load transition)", () => {
  const { shouldBlink } = loadPresenter();
  // 首次加载的 connecting 过渡不是真实状态变化
  assert.equal(shouldBlink("connecting", "running"), false);
  assert.equal(shouldBlink("connecting", "idle"), false);
  assert.equal(shouldBlink("connecting", "waiting"), false);
  assert.equal(shouldBlink("connecting", "error"), false);
  assert.equal(shouldBlink("connecting", "done"), false);
  assert.equal(shouldBlink("connecting", "interrupted"), false);
});

test("shouldBlink returns false for done→idle (automatic decay)", () => {
  const { shouldBlink } = loadPresenter();
  // done→idle 是"完成后停留"的自动衰减
  assert.equal(shouldBlink("done", "idle"), false);
});

test("shouldBlink returns true for normal status transitions", () => {
  const { shouldBlink } = loadPresenter();
  // 正常的业务状态切换应该闪烁
  assert.equal(shouldBlink("idle", "running"), true);
  assert.equal(shouldBlink("idle", "waiting"), true);
  assert.equal(shouldBlink("running", "done"), true);
  assert.equal(shouldBlink("running", "error"), true);
  assert.equal(shouldBlink("running", "waiting"), true);
  assert.equal(shouldBlink("waiting", "running"), true);
  assert.equal(shouldBlink("error", "idle"), true);
  assert.equal(shouldBlink("interrupted", "idle"), true);
  assert.equal(shouldBlink("idle", "error"), true);
});

test("shouldBlink returns true for idle→connecting", () => {
  const { shouldBlink } = loadPresenter();
  // idle→connecting 不是初始加载，是重连场景
  assert.equal(shouldBlink("idle", "connecting"), true);
});
