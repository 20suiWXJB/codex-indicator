import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("main floating pill starts native dragging from non-button left pointer presses", () => {
  const source = fs.readFileSync("src/main.ts", "utf8");

  assert.match(source, /import\s+\{\s*getCurrentWindow\s*\}\s+from\s+"@tauri-apps\/api\/window"/);
  assert.match(source, /\.pill"\)!\s*;/);
  assert.match(source, /addEventListener\("pointerdown"/);
  assert.match(source, /event\.button\s*!==\s*0/);
  assert.match(source, /closest\("button"\)/);
  assert.match(source, /getCurrentWindow\(\)\.startDragging\(\)/);
  assert.match(source, /catch\s*\{/);
});

test("default capability allows native window dragging", () => {
  const capability = JSON.parse(fs.readFileSync("src-tauri/capabilities/default.json", "utf8"));

  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));
});
