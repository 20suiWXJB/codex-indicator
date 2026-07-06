import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("hooks/agent-status-bridge.ps1");
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

function tempProjectRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `indicator-bridge-${name}-`));
}

function runBridge(projectRoot, args = [], input = "") {
  const result = spawnSync(
    powershell,
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...args,
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, INDICATOR_PROJECT_ROOT: projectRoot },
      input,
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function readStatus(projectRoot) {
  return JSON.parse(
    fs.readFileSync(path.join(projectRoot, "state", "status.json"), "utf8"),
  );
}

function readInstanceStatuses(projectRoot) {
  const statusDir = path.join(projectRoot, "state", "status");
  return fs
    .readdirSync(statusDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      name,
      value: JSON.parse(fs.readFileSync(path.join(statusDir, name), "utf8")),
    }));
}

function readEvents(projectRoot) {
  return fs
    .readFileSync(path.join(projectRoot, "state", "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

function readLog(projectRoot) {
  const logPath = path.join(projectRoot, "logs", "indicator.log");
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
}

test("json PermissionRequest writes waiting status", () => {
  const projectRoot = tempProjectRoot("waiting");

  runBridge(
    projectRoot,
    [],
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_input: { command: "cargo test" },
    }),
  );

  const status = readStatus(projectRoot);
  assert.equal(status.status, "waiting");
  assert.equal(status.event, "PermissionRequest");
  assert.equal(status.detail, "cargo test");
});

test("json Stop writes done status", () => {
  const projectRoot = tempProjectRoot("done");

  runBridge(projectRoot, [], JSON.stringify({ hook_event_name: "Stop" }));

  const status = readStatus(projectRoot);
  assert.equal(status.status, "done");
  assert.equal(status.event, "Stop");
});

test("non-json agent-turn-complete notify argument maps to done without log error", () => {
  const projectRoot = tempProjectRoot("notify");

  runBridge(projectRoot, ["019f22ff-cfba-70f0-995e-a759123c6a52", "agent-turn-complete"]);

  const status = readStatus(projectRoot);
  assert.equal(status.status, "done");
  assert.equal(status.event, "agent-turn-complete");
  assert.doesNotMatch(readLog(projectRoot), /bridge failed|Invalid JSON primitive/);
});

test("unknown non-json notify argument does not write status or log error", () => {
  const projectRoot = tempProjectRoot("unknown");

  runBridge(projectRoot, ["019f22ff-cfba-70f0-995e-a759123c6a52", "unknown-event"]);

  assert.equal(fs.existsSync(path.join(projectRoot, "state", "status.json")), false);
  assert.doesNotMatch(readLog(projectRoot), /bridge failed|Invalid JSON primitive/);
});

test("different cwd events write separate instance statuses and event metadata", () => {
  const projectRoot = tempProjectRoot("instances");
  const cwdA = "D:\\Code\\ProjectA";
  const cwdB = "D:\\Code\\ProjectB";

  runBridge(
    projectRoot,
    [],
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      cwd: cwdA,
      tool_input: { command: "npm test" },
    }),
  );
  runBridge(
    projectRoot,
    [],
    JSON.stringify({
      hook_event_name: "Stop",
      cwd: cwdB,
    }),
  );

  const statuses = readInstanceStatuses(projectRoot);
  assert.equal(statuses.length, 2);
  assert.deepEqual(
    statuses.map(({ value }) => value.cwd).sort(),
    [cwdA, cwdB].sort(),
  );
  assert.deepEqual(
    statuses.map(({ value }) => value.status).sort(),
    ["done", "waiting"].sort(),
  );

  const events = readEvents(projectRoot);
  assert.equal(events.length, 2);
  assert.equal(events[0].cwd, cwdA);
  assert.equal(events[1].cwd, cwdB);
  assert.ok(events[0].instance);
  assert.ok(events[1].instance);
  assert.notEqual(events[0].instance, events[1].instance);
});
