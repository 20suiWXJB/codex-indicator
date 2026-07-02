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

  assert.equal(copy.label, "等待批准");
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
