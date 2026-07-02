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
