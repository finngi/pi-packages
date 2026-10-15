import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ResourceBrowser } from "./resource-browser.ts";
import type { ResourceEntry } from "./resource-browser.ts";

initTheme("dark", false);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (browser: ResourceBrowser, width = 160) =>
  browser.render(width).map(stripTerminalSequences).join("\n");
function fixture() {
  const writes: unknown[] = [];
  const entry: ResourceEntry = {
    id: "review",
    name: "review",
    description: "Review the proposed change.",
    selected: false,
    sessionState: "off",
    projectState: "inherit",
    globalState: "on",
    effectiveSource: "session",
    sessionMode: "inherit",
    projectMode: "interactive",
    globalMode: "any",
    mode: "interactive",
    modeSource: "project",
    defaultSelected: true,
    globalDefaultSelected: true,
    preview: async () => ({ body: "# Review\n\nInspect callers before suggesting changes." }),
  };
  const browser = new ResourceBrowser({
    title: "Skills",
    entries: [entry],
    selectionScope: "session",
    defaultsScope: "project",
    theme: { fg: (_color, value) => value, bg: (_color, value) => value, bold: (value) => value },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async (item, selected) => {
      writes.push(["session", selected ? "on" : "off"]);
      item.sessionState = selected ? "on" : "off";
    },
    setSession: async (item, state) => {
      writes.push(["session", state]);
      item.sessionState = state;
    },
    setDefault: async (item, state, scope) => {
      writes.push([scope, state]);
      item[`${scope}State`] = state;
    },
    setMode: async (item, mode, scope) => {
      writes.push([scope, "mode", mode]);
      item[`${scope}Mode`] = mode;
    },
  });
  return { browser, entry, writes };
}
async function choose(browser: ResourceBrowser, scope: string, label: string) {
  browser.handleInput(scope[0]);
  for (let i = 0; i < 6 && !plain(browser).includes(`→ ${label} `); i++)
    browser.handleInput("\x1b[B");
  assert(plain(browser).includes(`→ ${label} `), `menu must expose ${label}`);
  browser.handleInput("\r");
  await flush();
}

test("each scope menu writes only its selection or session type", async () => {
  const { browser, entry, writes } = fixture();
  await flush();
  for (const scope of ["session", "project", "global"] as const) {
    const original = { ...entry };
    await choose(browser, scope, "Inherit");
    assert.deepEqual(writes.at(-1), [scope, "inherit"]);
    assert.equal(entry[`${scope}State`], "inherit");
    for (const other of ["session", "project", "global"] as const) {
      if (other !== scope) assert.equal(entry[`${other}State`], original[`${other}State`]);
      assert.equal(entry[`${other}Mode`], original[`${other}Mode`]);
    }
    await choose(browser, scope, "On");
    await choose(browser, scope, "Off");
    await choose(browser, scope, "Interactive only");
    assert.deepEqual(writes.at(-1), [scope, "mode", "interactive"]);
    assert.equal(entry[`${scope}State`], "off", "session type must not select the resource");
    await choose(browser, scope, "Any session");
    await choose(browser, scope, "Type: Inherit");
    assert.deepEqual(writes.at(-1), [scope, "mode", "inherit"]);
    assert.equal(
      entry.selected,
      false,
      "saved choices cannot toggle the active session implicitly",
    );
  }
  browser.dispose();
});

test("scope controls separate explicit values from effective selection and fit narrow widths", async () => {
  const { browser, entry } = fixture();
  await flush();
  const text = plain(browser);
  assert.match(text, /Session:\s+OFF/);
  assert.match(text, /Project:\s+INHERIT/);
  assert.match(text, /Global:\s+ON/);
  assert.doesNotMatch(text, /Active here:|Other scopes unchanged/);
  assert.match(text, /Applies in: Interactive only — project/);
  const rendered = text.split("\n");
  const scopeRow = rendered.findIndex((line) => line.includes("Session:"));
  const controls = rendered[scopeRow];
  const heading = rendered.find((line) => line.includes(""))!;
  const resource = rendered.find((line) => line.includes("[ ] review"))!;
  for (const [icon, marker] of [
    ["", ""],
    ["", "·"],
    ["", ""],
  ])
    assert.equal(
      resource[heading.indexOf(icon)],
      marker,
      "scope indicators align with their headers",
    );
  const previewHeading = rendered.find((line) => line.includes(" Overview "))!;
  assert.match(previewHeading, /Overview.*Instructions.*Source.*review/);
  assert.doesNotMatch(previewHeading, /\d+–\d+\//);
  assert.doesNotMatch(controls, /[\[\]]/, "scope options use colour without brackets");
  assert.equal(
    controls.indexOf("Project:") - controls.indexOf("Session:"),
    controls.indexOf("Global:") - controls.indexOf("Project:"),
  );
  for (const row of [scopeRow - 1, scopeRow + 1])
    assert.match(rendered[row].split("│").at(-2)!, /^\s*$/, "scope controls have vertical padding");
  const globalColumn = text
    .split("\n")
    .find((line) => line.includes("Global:"))!
    .indexOf("Global:");
  entry.sessionState = "on";
  assert.equal(
    plain(browser)
      .split("\n")
      .find((line) => line.includes("Global:"))!
      .indexOf("Global:"),
    globalColumn,
  );
  for (const width of [32, 44, 70, 100, 160]) {
    assert(browser.render(width).every((line) => visibleWidth(line) === width));
    browser.handleInput("p");
    const menu = plain(browser, width);
    assert.match(menu, /Interactive only/);
    assert(browser.render(width).every((line) => visibleWidth(line) === width));
    browser.handleInput("\x1b");
  }
  browser.dispose();
});

test("scope click opens choices, wheel never writes, and searching consumes scope keys", async () => {
  const { browser, writes } = fixture();
  await flush();
  const lines = browser.render(160).map(stripTerminalSequences);
  const y = lines.findIndex((line) => line.includes("Global:"));
  const x = lines[y].indexOf("Global:") + 2;
  browser.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    shift: false,
    alt: false,
    ctrl: false,
    width: 160,
    height: 42,
  });
  assert.match(plain(browser), /Global choices/);
  assert.match(plain(browser), /Type: Inherit/);
  browser.handleMouse({
    type: "wheel",
    button: "none",
    x,
    y,
    screenX: x,
    screenY: y,
    shift: false,
    alt: false,
    ctrl: false,
    width: 160,
    height: 42,
    wheelDelta: 1,
  });
  assert.deepEqual(writes, []);
  const menuLines = browser.render(160).map(stripTerminalSequences);
  const choiceY = menuLines.findIndex((line) => line.includes("Interactive only"));
  const choiceX = menuLines[choiceY].indexOf("Interactive only") + 1;
  browser.handleMouse({
    type: "click",
    button: "left",
    x: choiceX,
    y: choiceY,
    screenX: choiceX,
    screenY: choiceY,
    shift: false,
    alt: false,
    ctrl: false,
    width: 160,
    height: 42,
  });
  await flush();
  assert.deepEqual(writes, [["global", "mode", "interactive"]]);
  writes.length = 0;
  browser.handleInput("/");
  browser.handleInput("s");
  browser.handleInput("p");
  browser.handleInput("g");
  assert.equal(browser.input.getValue(), "spg");
  assert.deepEqual(writes, []);
  browser.dispose();
});
