import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function loadDockModel() {
  const sourcePath = path.resolve("src/dockModel.ts");
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

const none = { mode: "none", edge: null };
const hiddenRight = { mode: "hidden", edge: "right" };
const peekRight = { mode: "peek", edge: "right" };

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("dock check result enters hidden and closes the panel when an edge is returned", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(none, { kind: "dockCheckResult", edge: "right" })), {
    state: hiddenRight,
    commands: [{ kind: "closePanel" }, { kind: "setMode", mode: "hidden" }],
  });
});

test("docked peek settles to hidden and closes the panel", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(peekRight, { kind: "pointerLeaveSettled" })), {
    state: hiddenRight,
    commands: [{ kind: "closePanel" }, { kind: "setMode", mode: "hidden" }],
  });
});

test("hidden hover returns to peek", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(hiddenRight, { kind: "pointerEnter" })), {
    state: peekRight,
    commands: [{ kind: "setMode", mode: "peek" }],
  });
});

test("leaving a docked edge undocks when dock check returns null", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(peekRight, { kind: "dockCheckResult", edge: null })), {
    state: none,
    commands: [{ kind: "undock" }],
  });
});

test("dock disabled undocks from every docked mode", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(peekRight, { kind: "dockDisabled" })), {
    state: none,
    commands: [{ kind: "undock" }],
  });
  assert.deepEqual(plain(reduceDock(hiddenRight, { kind: "dockDisabled" })), {
    state: none,
    commands: [{ kind: "undock" }],
  });
  assert.deepEqual(plain(reduceDock(none, { kind: "dockDisabled" })), {
    state: none,
    commands: [],
  });
});

test("restored state follows persisted dock state", () => {
  const { reduceDock } = loadDockModel();

  assert.deepEqual(plain(reduceDock(none, { kind: "restored", state: { edge: "top" } })), {
    state: { mode: "hidden", edge: "top" },
    commands: [],
  });
  assert.deepEqual(plain(reduceDock(peekRight, { kind: "restored", state: null })), {
    state: none,
    commands: [],
  });
});
