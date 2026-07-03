import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

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
