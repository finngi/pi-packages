import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
  ResourceBrowser,
  resourceBrowserNavigation,
  showResourceBrowser,
} from "./resource-browser.ts";
import type { ResourceEntry } from "./resource-browser.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function chooseDefault(
  component: ResourceBrowser,
  scope: "session" | "project" | "global",
  state: "inherit" | "on" | "off",
) {
  component.handleInput(scope[0]);
  const label = state === "inherit" ? "Inherit" : state === "on" ? "On" : "Off";
  const selected = () =>
    component.render(160).map(stripTerminalSequences).join("\n").includes(`→ ${label} `);
  for (let i = 0; i < 6 && !selected(); i++) component.handleInput("\x1b[B");
  assert(selected(), `saved-state menu should select ${label}`);
  component.handleInput("\r");
  await flush();
}
function refreshDefault(
  entry: ResourceEntry,
  state: "inherit" | "on" | "off",
  scope: "project" | "global",
) {
  if (scope === "project") {
    entry.projectState = state;
    entry.defaultSelected =
      state === "inherit" ? (entry.globalDefaultSelected ?? false) : state === "on";
  } else {
    entry.globalState = state;
    entry.globalDefaultSelected = state === "on";
    if (entry.projectState === "inherit") entry.defaultSelected = entry.globalDefaultSelected;
  }
}
async function refreshSession(entry: ResourceEntry, state: "inherit" | "on" | "off") {
  entry.sessionState = state;
  entry.selected = state === "inherit" ? (entry.defaultSelected ?? false) : state === "on";
  entry.effectiveSource = state === "inherit" ? "project" : "session";
}
async function refreshMode(
  entry: ResourceEntry,
  mode: "inherit" | "any" | "interactive",
  scope: "project" | "global",
) {
  entry[`${scope}Mode`] = mode;
}
function fixture(
  overrides: {
    toggle?: (entry: ResourceEntry, selected: boolean) => Promise<void>;
    setSession?: typeof refreshSession;
    saveDefaults?: (entries: ResourceEntry[]) => Promise<void>;
    saveGlobalDefaults?: (entries: ResourceEntry[]) => Promise<void>;
    defaultsScope?: "project" | "global";
    previews?: Array<() => Promise<string>>;
  } = {},
) {
  const saved: Array<[string, boolean]> = [],
    closed: boolean[] = [];
  const entries: ResourceEntry[] = [
    {
      id: "adr",
      name: "adr",
      description: "Record architecture decisions",
      selected: false,
      preview:
        overrides.previews?.[0] ??
        (async () => "Architecture decision records\n\n**Source:** /project/skills/adr/SKILL.md"),
    },
    {
      id: "review",
      name: "code-review",
      description: "Review code for security",
      selected: false,
      preview:
        overrides.previews?.[1] ?? (async () => "Review code and callers.\n\nRead-only report."),
    },
  ];
  const component = new ResourceBrowser({
    title: "Skills",
    entries,
    defaultsScope: overrides.defaultsScope,
    theme: {
      fg: (_color, text) => text,
      bg: (_color, text) => text,
      bold: (text) => `\x1b[1m${text}\x1b[22m`,
    },
    rows: () => 42,
    render() {},
    close: (changed) => closed.push(changed),
    setSession: overrides.setSession,
    saveDefaults:
      overrides.saveDefaults &&
      (async (snapshot) => {
        await overrides.saveDefaults!(snapshot);
        for (const entry of entries) {
          const saved = snapshot.find((item) => item.id === entry.id);
          if (saved) refreshDefault(entry, saved.selected ? "on" : "off", "project");
          else entry.defaultSelected ??= false;
        }
      }),
    saveGlobalDefaults:
      overrides.saveGlobalDefaults &&
      (async (snapshot) => {
        await overrides.saveGlobalDefaults!(snapshot);
        for (const entry of entries) {
          const saved = snapshot.find((item) => item.id === entry.id);
          if (saved) refreshDefault(entry, saved.selected ? "on" : "off", "global");
        }
      }),
    toggle:
      overrides.toggle ??
      (async (entry, selected) => {
        saved.push([entry.id, selected]);
      }),
  });
  return {
    component,
    entries,
    saved,
    closed,
    text: (width = 110) => component.render(width).map(stripTerminalSequences).join("\n"),
  };
}
test("Ctrl+S saves selected defaults and displays the saved state", async () => {
  let saved: string[] = [];
  const f = fixture({
    saveDefaults: async (entries) => {
      saved = entries.filter((entry) => entry.selected).map((entry) => entry.id);
    },
  });
  f.entries[0].selected = true;
  f.component.handleInput("\x13");
  await flush();
  assert.deepEqual(saved, ["adr"]);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[1].defaultSelected, false);
  assert.match(f.text(), /Defaults/);
  f.component.dispose();
});
test("Ctrl+S defaults catalogue instructions while leaving project instructions project-only", async () => {
  let saved: string[] = [];
  const f = fixture({
    saveDefaults: async (entries) => {
      saved = entries.filter((entry) => entry.selected).map((entry) => entry.id);
    },
  });
  f.entries[0].id = "catalogue:team/instructions.md";
  f.entries[1].id = "local:AGENTS.local.md";
  f.entries[0].selected = true;
  f.entries[1].selected = true;
  f.entries[1].defaultable = false;
  f.component.handleInput("\x13");
  await flush();
  assert.deepEqual(saved, ["catalogue:team/instructions.md"]);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[1].defaultSelected, false);
  assert.match(f.text(), /1 selected saved; 1 selected skipped/);
  f.component.dispose();
});
test("Ctrl+S never badges the non-toggleable Pi help skill as a persisted default", async () => {
  let saved: string[] = [];
  const f = fixture({
    saveDefaults: async (entries) => {
      saved = entries.filter((entry) => entry.selected).map((entry) => entry.id);
    },
  });
  f.entries[0].selected = true;
  f.entries[1].id = "pi-help";
  f.entries[1].name = "pi-help";
  f.entries[1].selected = true;
  f.entries[1].toggleable = false;
  f.component.handleInput("\x13");
  await flush();
  assert.deepEqual(saved, ["adr"]);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[1].defaultSelected, false);
  f.component.dispose();
});
test("closing waits for a defaults save and badges use its captured selection", async () => {
  let complete!: () => void;
  const f = fixture({
    saveDefaults: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  });
  f.entries[0].selected = true;
  f.component.handleInput("\x13");
  f.component.handleInput("\x1b");
  f.entries[0].selected = false;
  assert.deepEqual(f.closed, []);
  complete();
  await flush();
  assert.deepEqual(f.closed, [false]);
  assert.equal(f.entries[0].defaultSelected, true);
  f.component.dispose();
});
test("a direct selection saves once and updates the checkbox; escape preserves the saved change", async () => {
  const f = fixture();
  await f.component.toggleCurrent();
  assert.deepEqual(f.saved, [["adr", true]]);
  assert.equal(f.entries[0].selected, true);
  f.component.handleInput("\x1b");
  assert.deepEqual(f.closed, [true]);
  f.component.dispose();
});
test("failed persistence keeps the original state and displays the error in the browser", async () => {
  const f = fixture({
    toggle: async () => {
      throw Error("Project is not trusted");
    },
  });
  await f.component.toggleCurrent();
  assert.equal(f.entries[0].selected, false);
  assert.match(f.text(), /Not saved: Project is not trusted/);
  f.component.dispose();
});
test("an in-flight save prevents duplicate toggles and closing waits for its result", async () => {
  let complete!: () => void;
  const f = fixture({
    toggle: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  });
  const pending = f.component.toggleCurrent();
  await f.component.toggleCurrent();
  f.component.handleInput("\x1b");
  assert.deepEqual(f.closed, []);
  complete();
  await pending;
  assert.deepEqual(f.closed, [true]);
  f.component.dispose();
});
test("search changes the list and the adjacent preview without another dialog", async () => {
  const f = fixture();
  f.component.handleInput("/");
  f.component.handleInput("review");
  await flush();
  assert.match(f.text(), /1\/2/);
  assert.match(f.text(), /Read-only report/);
  assert.doesNotMatch(f.text(), /Architecture decision records/);
  f.component.dispose();
});
test("late previews cannot replace the highlighted resource and disposed callbacks do not mutate state", async () => {
  let finish!: (text: string) => void;
  const f = fixture({
    previews: [
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      async () => "CURRENT PREVIEW",
    ],
  });
  f.component.handleInput("\x1b[B");
  await flush();
  finish("STALE PREVIEW");
  await flush();
  assert.match(f.text(), /CURRENT PREVIEW/);
  assert.doesNotMatch(f.text(), /STALE PREVIEW/);
  f.component.dispose();
  await f.component.toggleCurrent();
  assert.deepEqual(f.saved, []);
});
test("layout fits narrow and wide terminals, including Unicode and long lines", async () => {
  const f = fixture();
  await flush();
  f.entries[0].name = "記録 👩‍💻 " + "very-long-name".repeat(20);
  for (const width of [1, 8, 20, 44, 77, 78, 110, 180]) {
    const lines = f.component.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `overflow at width ${width}`,
    );
  }
  f.component.dispose();
});
test("a native mouse click selects the row and toggles it once", async () => {
  const f = fixture();
  const y = f.component
    .render(110)
    .map(stripTerminalSequences)
    .findIndex((row) => row.includes("[ ] code-review"));
  f.component.handleMouse({
    type: "click",
    button: "left",
    x: 5,
    y,
    screenX: 5,
    screenY: y,
    width: 110,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  });
  await flush();
  assert.deepEqual(f.saved, [["review", true]]);
  f.component.dispose();
});

test("clicking the search field accepts multiword queries rather than toggling the resource", async () => {
  const f = fixture();
  const y = f.component
    .render(110)
    .map(stripTerminalSequences)
    .findIndex((row) => row.includes("Search"));
  f.component.handleMouse({
    type: "click",
    button: "left",
    x: 9,
    y,
    screenX: 9,
    screenY: y,
    width: 110,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  });
  f.component.handleInput("code review");
  await flush();
  assert.equal(f.component.input.getValue(), "code review");
  assert.match(f.text(), /1\/2/);
  assert.deepEqual(f.saved, []);
  f.component.dispose();
});

test("Ctrl+Shift+S saves personal choices without overwriting project-default badges", async () => {
  let personal: string[] = [],
    projectSaves = 0;
  const f = fixture({
    saveDefaults: async () => {
      projectSaves++;
    },
    saveGlobalDefaults: async (entries) => {
      personal = entries.filter((entry) => entry.selected).map((entry) => entry.id);
    },
  });
  f.entries[0].selected = true;
  f.entries[0].defaultSelected = false;
  f.entries[1].selected = true;
  f.entries[1].defaultSelected = true;
  f.entries[1].globalDefaultable = false;
  f.component.handleInput("\x1b[115;6u");
  await flush();
  assert.deepEqual(personal, ["adr"]);
  assert.equal(projectSaves, 0);
  assert.equal(f.entries[0].defaultSelected, false);
  assert.equal(f.entries[1].defaultSelected, true);
  assert.match(f.text(), /Global defaults: 1 selected saved; 1 selected skipped/);
  f.component.dispose();
});

test("structured details separate read-only metadata, instruction body and source", async () => {
  const f = fixture();
  f.entries[0].preview = async () => ({
    fields: [{ label: "Child skills", value: "private-check" }],
    body: "# Instructions\nBODY_ONLY",
    source: "/agent/role.md",
    bodyLabel: "Child instructions; loaded when launched",
  });
  // A new instance starts the async preview using the structured entry.
  const component = new ResourceBrowser({
    title: "Agents",
    entries: f.entries,
    selectionScope: "session",
    defaultsScope: "project",
    defaultsInherited: true,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    saveDefaults: async (snapshot) => {
      for (const saved of snapshot)
        refreshDefault(
          f.entries.find((entry) => entry.id === saved.id)!,
          saved.selected ? "on" : "off",
          "project",
        );
    },
  });
  await flush();
  const text = () => component.render(110).map(stripTerminalSequences).join("\n");
  assert.match(text(), /Child skills\s+: private-check/);
  assert.match(text(), /Project: INHERIT/);
  assert.doesNotMatch(text(), /BODY_ONLY|\/agent\/role.md/);
  component.handleInput("\t");
  component.handleInput("\x1b[C");
  assert.match(text(), /Instructions/);
  assert.match(text(), /BODY_ONLY/);
  assert.doesNotMatch(text(), /Child skills\s+: private-check/);
  component.handleInput("\r");
  assert.equal(f.entries[0].selected, false, "read-only preview Enter must not change selections");
  component.handleInput("\x1b[C");
  assert.match(text(), /Source/);
  assert.match(text(), /\/agent\/role.md/);
  assert.doesNotMatch(text(), /BODY_ONLY/);
  component.handleInput("\t");
  await component.toggleCurrent();
  component.handleInput("\x13");
  await flush();
  assert.match(text(), /Session: ON.*Project: ON/);
  await component.toggleCurrent();
  assert.match(text(), /Session: OFF.*Project: ON/);
  component.handleInput("\x13");
  await flush();
  assert.match(text(), /Session: OFF.*Project: OFF/);
  component.dispose();
  f.component.dispose();
});

test("mouse detail tabs switch content without toggling and scrolling preserves selection state", async () => {
  const f = fixture();
  const component = new ResourceBrowser({
    title: "Skills",
    entries: [
      {
        ...f.entries[0],
        preview: async () => ({ body: "BODY_ROW\n".repeat(60), source: "/source/SKILL.md" }),
      },
    ],
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {
      throw Error("Must not toggle");
    },
  });
  await flush();
  const rows = component.render(110).map(stripTerminalSequences);
  const y = rows.findIndex((row) => row.includes(" Overview "));
  const x = rows[y].indexOf(" Instructions ") + 2;
  const result = component.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 110,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.equal(result?.handled, true);
  let text = component.render(110).map(stripTerminalSequences).join("\n");
  assert.match(text, /Instructions/);
  assert.match(text, /BODY_ROW/);
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[6~");
  text = component.render(110).map(stripTerminalSequences).join("\n");
  assert.match(text, /Session: OFF/);
  for (const [label, content] of [
    ["Source", /\/source\/SKILL.md/],
    ["Overview", /Record architecture decisions/],
  ] as const) {
    const x = rows[y].indexOf(` ${label} `) + 2;
    component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width: 110,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.match(component.render(110).map(stripTerminalSequences).join("\n"), content);
  }
  component.dispose();
  f.component.dispose();
});

test("Vim navigation and explicit search keep query characters out of navigation", async () => {
  const f = fixture();
  f.component.handleInput("j");
  await flush();
  assert.equal(f.component.input.getValue(), "");
  assert.match(f.text(), /Review code and callers/);
  f.component.handleInput("k");
  f.component.handleInput("l");
  f.component.handleInput("l");
  assert(f.component.render(110).join("\n").includes("\x1b[1m Instructions \x1b[22m"));
  f.component.handleInput("h");
  assert(f.component.render(110).join("\n").includes("\x1b[1m Overview \x1b[22m"));
  f.component.handleInput("h");
  f.component.handleInput("/");
  assert.equal(f.component.searchFocused, true);
  f.component.handleInput("hjkl1234");
  assert.equal(f.component.input.getValue(), "hjkl1234");
  f.component.handleInput("\x1b");
  assert.equal(f.component.searchFocused, false);
  assert.deepEqual(f.closed, []);
  f.component.handleInput("/");
  f.component.handleInput("\r");
  assert.equal(f.component.searchFocused, false);
  assert.deepEqual(f.saved, []);
  f.component.dispose();
});

test("Session Inherit removes only its override and follows the project's resolved choice", async () => {
  const f = fixture({ setSession: refreshSession });
  Object.assign(f.entries[0], {
    selected: false,
    sessionState: "off",
    projectState: "on",
    globalState: "off",
    defaultSelected: true,
    globalDefaultSelected: false,
  });
  await chooseDefault(f.component, "session", "inherit");
  assert.equal(f.entries[0].sessionState, "inherit");
  assert.equal(f.entries[0].selected, true);
  assert.equal(f.entries[0].projectState, "on");
  assert.equal(f.entries[0].globalState, "off");
  assert.match(f.text(160), /Session: INHERIT/);
  assert.match(f.text(160), /\[x\] adr/);
  assert.deepEqual(f.saved, [], "Inherit is not an explicit On toggle");
  f.component.dispose();
});

test("project choices preserve the explicit session and unrelated saved selections", async () => {
  const f = fixture();
  f.entries[0].defaultSelected = false;
  f.entries[0].globalDefaultSelected = false;
  f.entries[1].defaultSelected = true;
  f.entries[1].globalDefaultSelected = true;
  const calls: Array<[string, string, string]> = [];
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    selectionScope: "session",
    defaultsScope: "project",
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, value, scope) => {
      calls.push([entry.id, value, scope]);
      refreshDefault(entry, value, scope);
    },
  });
  await chooseDefault(component, "project", "on");
  assert.deepEqual(calls, [["adr", "on", "project"]]);
  assert.equal(f.entries[0].selected, false);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].globalDefaultSelected, false);
  await chooseDefault(component, "global", "on");
  assert.equal(f.entries[0].globalDefaultSelected, true);
  assert.equal(f.entries[1].defaultSelected, true);
  assert.equal(f.entries[1].globalDefaultSelected, true);
  assert.equal(f.entries[1].selected, false);
  component.dispose();
  f.component.dispose();
});

test("clickable scope controls target the displayed resource at wide and narrow widths", async () => {
  for (const width of [140, 70]) {
    const f = fixture();
    for (const entry of f.entries) {
      entry.defaultSelected = false;
      entry.globalDefaultSelected = false;
    }
    const component = new ResourceBrowser({
      title: "Skills",
      entries: f.entries,
      selectionScope: "session",
      defaultsScope: "project",
      theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      rows: () => 42,
      render() {},
      close() {},
      toggle: async () => {},
      setSession: refreshSession,
      setMode: refreshMode,
      setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
    });
    await flush();
    const rows = component.render(width).map(stripTerminalSequences);
    const y = rows.findIndex((row) => /Project:\s+OFF/.test(row));
    const x = rows[y].indexOf("Project:") + 3;
    const result = component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await flush();
    assert.equal(result?.handled, true);
    assert.equal(f.entries[0].defaultSelected, false, "opening a menu does not save");
    assert.match(component.render(width).map(stripTerminalSequences).join("\n"), /Inherit/);
    component.handleInput("\x1b[A");
    component.handleInput("\r");
    await flush();
    assert.equal(f.entries[0].defaultSelected, true);
    assert.equal(f.entries[0].selected, false);
    component.dispose();
    f.component.dispose();
  }
});

test("failed default writes and ineligible resources never update displayed state", async () => {
  const f = fixture();
  f.entries[0].defaultSelected = false;
  f.entries[0].globalDefaultSelected = false;
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async () => {
      throw Error("Denied save");
    },
  });
  await chooseDefault(component, "project", "on");
  assert.equal(f.entries[0].defaultSelected, false);
  assert.match(
    component.render(140).map(stripTerminalSequences).join("\n"),
    /Choice not saved: Denied save/,
  );
  f.entries[0].globalDefaultable = false;
  component.handleInput("g");
  assert.equal(f.entries[0].globalDefaultSelected, false);
  component.dispose();
  f.component.dispose();
});

test("category tabs live in the frame, accept clicks and reserve numbers only outside search", async () => {
  const f = fixture();
  const changes: string[] = [];
  const colors: Array<[string, string]> = [];
  const component = new ResourceBrowser({
    title: "Agents",
    entries: f.entries,
    categories: [
      { id: "agents", label: "Agents", key: "1" },
      { id: "skills", label: "Skills", key: "2" },
    ],
    activeCategory: "agents",
    selectCategory: (id) => {
      changes.push(id);
    },
    theme: {
      fg: (color, text) => {
        colors.push([color, text]);
        return text;
      },
      bg: (_color, text) => text,
      bold: (text) => text,
    },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
  });
  const rows = component.render(110).map(stripTerminalSequences);
  assert.match(rows[0], /^╭.*1 Agents.*2 Skills.*╮$/);
  assert(colors.some(([color, text]) => color === "accent" && text.includes("1 Agents")));
  assert(colors.some(([color, text]) => color === "borderMuted" && text.includes("2 Skills")));
  const x = rows[0].indexOf("2 Skills") + 2;
  component.handleMouse({
    type: "click",
    button: "left",
    x,
    y: 0,
    screenX: x,
    screenY: 0,
    width: 110,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.deepEqual(changes, ["skills"]);
  component.handleInput("1");
  assert.deepEqual(changes, ["skills", "agents"]);
  component.handleInput("/");
  component.handleInput("2");
  assert.equal(component.input.getValue(), "2");
  assert.deepEqual(changes, ["skills", "agents"]);
  assert.match(component.render(110).map(stripTerminalSequences).join("\n"), /SEARCH ACTIVE/);
  component.dispose();
  f.component.dispose();
});

test("scope controls hold their columns when ON and OFF change", async () => {
  const f = fixture();
  for (const entry of f.entries) {
    entry.defaultSelected = false;
    entry.globalDefaultSelected = false;
  }
  const component = new ResourceBrowser({
    title: "Agents",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
  });
  const state = () =>
    component
      .render(140)
      .map(stripTerminalSequences)
      .find((row) => row.includes("Session:"))!;
  const before = state();
  await component.toggleCurrent();
  const after = state();
  assert.match(after, /Session:\s+ON/);
  assert.equal(after.indexOf("Project:"), before.indexOf("Project:"));
  assert.equal(after.indexOf("Global:"), before.indexOf("Global:"));
  await chooseDefault(component, "project", "on");
  assert.equal(state().indexOf("Global:"), before.indexOf("Global:"));
  component.dispose();
  f.component.dispose();
});

test("s/p/g operate from the list but remain literal inside search", async () => {
  const f = fixture();
  f.entries[0].defaultSelected = false;
  f.entries[0].globalDefaultSelected = false;
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
  });
  component.handleInput("p");
  assert.equal(f.entries[0].defaultSelected, false);
  assert.match(component.render(140).map(stripTerminalSequences).join("\n"), /Project choices/);
  component.handleInput("\x1b[A");
  component.handleInput("\r");
  await flush();
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, false, "project edits do not write a session override");
  await chooseDefault(component, "session", "on");
  assert.equal(f.entries[0].selected, true);
  await chooseDefault(component, "session", "off");
  assert.equal(f.entries[0].selected, false);
  await chooseDefault(component, "global", "on");
  assert.equal(f.entries[0].globalDefaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  component.handleInput("/");
  component.handleInput("spg");
  assert.equal(component.input.getValue(), "spg");
  assert.equal(f.entries[0].selected, false);
  component.dispose();
  f.component.dispose();
});

test("project saves do not attempt session activation even when its toggle would fail", async () => {
  const f = fixture();
  f.entries[0].defaultSelected = false;
  f.entries[0].globalDefaultSelected = false;
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {
      throw Error("Session unavailable");
    },
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
  });
  await chooseDefault(component, "project", "on");
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  assert.match(component.render(140).map(stripTerminalSequences).join("\n"), /Project:\s+ON/);
  component.dispose();
  f.component.dispose();
});

test("resource category navigation uses existing commands with native dispatch", () => {
  const sent: unknown[] = [];
  const options = resourceBrowserNavigation(
    {
      getCommands: () => [
        { name: "agents", source: "extension" },
        { name: "skills", source: "extension" },
        { name: "instructions", source: "skill" },
      ],
      sendUserMessage: (...args: unknown[]) => {
        sent.push(args);
      },
    } as any,
    "agents",
  );
  assert.deepEqual(
    options.categories.map((category) => category.id),
    ["agents", "skills"],
  );
  options.selectCategory("skills");
  options.selectCategory("agents");
  options.selectCategory("instructions");
  assert.deepEqual(sent, [["/skills", { expandPromptTemplates: true }]]);
});

test("saved-state menus cancel without changing defaults or navigating categories", async () => {
  const f = fixture();
  const calls: string[] = [];
  f.entries[0].projectState = "inherit";
  f.entries[0].globalState = "on";
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    categories: [{ id: "agents", label: "Agents", key: "1" }],
    selectCategory: (id) => calls.push(id),
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close: () => calls.push("close"),
    toggle: async () => {
      calls.push("toggle");
    },
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async () => {
      calls.push("save");
    },
  });
  component.handleInput("p");
  const menu = component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(menu, /→ Inherit/);
  assert.match(menu, /On/);
  assert.match(menu, /Off/);
  component.handleInput("1");
  component.handleInput("s");
  component.handleInput("\x1b");
  assert.deepEqual(calls, []);
  assert.equal(f.entries[0].projectState, "inherit");
  assert.equal(f.entries[0].selected, false);
  assert.match(component.render(140).map(stripTerminalSequences).join("\n"), /Project: INHERIT/);
  component.dispose();
  f.component.dispose();
});

test("every Project and Global choice preserves an explicit session selection", async () => {
  const f = fixture();
  const toggles: boolean[] = [];
  Object.assign(f.entries[0], {
    projectState: "inherit",
    globalState: "on",
    defaultSelected: true,
    globalDefaultSelected: true,
  });
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async (_entry, selected) => {
      toggles.push(selected);
    },
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
  });
  await chooseDefault(component, "project", "off");
  await chooseDefault(component, "project", "inherit");
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  await chooseDefault(component, "global", "off");
  await chooseDefault(component, "global", "inherit");
  await chooseDefault(component, "global", "on");
  assert.equal(f.entries[0].selected, false);
  assert.deepEqual(toggles, []);
  await chooseDefault(component, "project", "on");
  assert.deepEqual(toggles, []);
  await chooseDefault(component, "project", "off");
  await chooseDefault(component, "project", "inherit");
  assert.equal(f.entries[0].selected, false);
  assert.deepEqual(toggles, []);
  component.dispose();
  f.component.dispose();
});

test("inherited native defaults and mixed packages retain the host's refreshed states", async () => {
  const f = fixture();
  Object.assign(f.entries[0], {
    projectState: "inherit",
    globalState: "mixed",
    defaultSelected: undefined,
    globalDefaultSelected: undefined,
  });
  const component = new ResourceBrowser({
    title: "Packages",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 60,
    render() {},
    close() {},
    toggle: async () => {
      throw Error("Global defaults must not toggle the session");
    },
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => {
      assert.equal(scope, "global");
      assert.equal(state, "inherit");
      entry.globalState = "inherit";
      entry.globalDefaultSelected = true;
      entry.defaultSelected = true;
    },
  });
  await flush();
  const text = () => component.render(160).map(stripTerminalSequences).join("\n");
  assert.match(text(), /Project:\s+INHERIT/);
  assert.match(text(), /Global:\s+MIXED/);
  assert.match(text(), /Session:\s+OFF/);
  component.handleInput("g");
  assert.match(text(), /Global choices · MIXED/);
  component.handleInput("\r");
  await flush();
  assert.equal(f.entries[0].globalState, "inherit");
  assert.equal(f.entries[0].globalDefaultSelected, true);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  assert.match(text(), /Project:\s+INHERIT/);
  assert.match(text(), /Global:\s+INHERIT/);
  assert.match(text(), /Session:\s+OFF/);
  component.dispose();
  f.component.dispose();
});

test("native saved-state menu accepts mouse choices and fits wide and narrow terminals", async () => {
  for (const width of [44, 70, 140]) {
    const f = fixture();
    f.entries[0].projectState = "inherit";
    const component = new ResourceBrowser({
      title: "Skills",
      entries: f.entries,
      theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
      rows: () => 42,
      render() {},
      close() {},
      toggle: async () => {},
      setSession: refreshSession,
      setMode: refreshMode,
      setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
    });
    component.handleInput("p");
    const rows = component.render(width).map(stripTerminalSequences);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    const y = rows.findIndex((row) => /\bOff\b/.test(row));
    const x = rows[y].indexOf("Off") + 1;
    component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width,
      height: rows.length,
      shift: false,
      alt: false,
      ctrl: false,
    });
    await flush();
    assert.equal(f.entries[0].projectState, "off");
    assert.equal(f.entries[0].selected, false);
    component.dispose();
    f.component.dispose();
  }
});

test("narrow terminals show both snapshot shortcut destinations", () => {
  const f = fixture({
    defaultsScope: "project",
    saveDefaults: async () => {},
    saveGlobalDefaults: async () => {},
  });
  const text = f.text(70);
  assert.match(text, /Ctrl\+S Save project/);
  assert.match(text, /Ctrl\+Shift\+S Save global/);
  f.component.dispose();
});

test("Project On uses its resolved value despite the initial inherited flag", async () => {
  const f = fixture();
  const colors: Array<[string, string]> = [];
  Object.assign(f.entries[0], {
    projectState: "inherit",
    globalState: "off",
    defaultSelected: false,
    globalDefaultSelected: false,
  });
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    defaultsInherited: true,
    theme: {
      fg: (color, text) => {
        colors.push([color, text]);
        return text;
      },
      bg: (_color, text) => text,
      bold: (text) => text,
    },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (entry, state, scope) => refreshDefault(entry, state, scope),
  });
  await chooseDefault(component, "project", "on");
  colors.length = 0;
  const text = component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(text, /Session:\s+OFF.*Project:\s+ON.*Global:\s+OFF/);
  assert(colors.some(([color, text]) => color === "success" && /Project:\s+ON/.test(text)));
  assert.equal(f.entries[0].selected, false);
  component.dispose();
  f.component.dispose();
});

test("unavailable saved controls explain the restriction in Overview, keyboard and mouse", async () => {
  const f = fixture();
  const writes: unknown[] = [];
  Object.assign(f.entries[0], {
    projectState: "on",
    globalState: "off",
    defaultSelected: true,
    globalDefaultSelected: false,
    selected: true,
    globalDefaultable: false,
  });
  const component = new ResourceBrowser({
    title: "Skills",
    entries: f.entries,
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close() {},
    toggle: async () => {},
    setSession: refreshSession,
    setMode: refreshMode,
    setDefault: async (...args) => {
      writes.push(args);
    },
  });
  await flush();
  const text = () => component.render(140).map(stripTerminalSequences).join("\n");
  assert.match(text(), /Global default unavailable: loaded only for this project or launch/);
  assert.match(text(), /\[x\] adr/);
  component.handleInput("l");
  component.handleInput("l");
  assert.doesNotMatch(text(), /Global default unavailable/);
  component.handleInput("g");
  assert.match(text(), /Global default unavailable: loaded only for this project or launch/);
  assert.doesNotMatch(text(), /Use native default/);
  await component.toggleCurrent();
  await component.toggleCurrent();
  assert.doesNotMatch(text(), /Global default unavailable/);
  const rows = component.render(140).map(stripTerminalSequences);
  const y = rows.findIndex((row) => row.includes("Global:"));
  const x = rows[y].indexOf("Global:") + 2;
  component.handleMouse({
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 140,
    height: rows.length,
    shift: false,
    alt: false,
    ctrl: false,
  });
  assert.match(text(), /Global default unavailable: loaded only for this project or launch/);
  assert.deepEqual(writes, []);
  assert.equal(f.entries[0].selected, true);
  component.handleInput("/");
  component.handleInput("g");
  assert.equal(component.input.getValue(), "g");
  component.handleInput("\x1b");
  component.dispose();
  f.component.dispose();
});

test("snapshot shortcuts report skipped selections and do not write zero eligible rows", async () => {
  const calls: string[] = [];
  const f = fixture({
    defaultsScope: "project",
    saveDefaults: async () => {
      calls.push("project");
    },
    saveGlobalDefaults: async () => {
      calls.push("global");
    },
  });
  f.entries[0].selected = true;
  f.entries[0].defaultable = false;
  f.component.handleInput("\x13");
  await flush();
  assert.match(f.text(), /Project defaults: 0 selected saved; 1 selected skipped/);
  f.component.handleInput("\x1b[115;6u");
  await flush();
  assert.match(f.text(), /Global defaults: 0 selected saved; 1 selected skipped/);
  assert.deepEqual(calls, ["project", "global"]);
  f.entries[1].defaultable = false;
  f.component.handleInput("\x13");
  await flush();
  assert.match(f.text(), /No eligible resources for project defaults; nothing saved/);
  f.component.handleInput("\x1b[115;6u");
  await flush();
  assert.match(f.text(), /No eligible resources for global defaults; nothing saved/);
  assert.deepEqual(calls, ["project", "global"]);
  assert.equal(f.entries[0].selected, true);
  f.component.dispose();
});

test("RPC snapshot choices share filtered snapshots, skipped feedback and empty-save handling", async () => {
  for (const global of [false, true]) {
    const f = fixture();
    f.entries[0].selected = true;
    f.entries[1].selected = true;
    if (global) f.entries[0].globalDefaultable = false;
    else f.entries[0].defaultable = false;
    const notifications: string[] = [];
    const writes: string[][] = [];
    const choice = global ? "Save personal defaults (all projects)" : "Save project defaults";
    const choices = [choice, "Done", choice, "Done"];
    const context = {
      ui: {
        select: async (_title: string, options: string[]) => {
          assert(options.includes(choice));
          return choices.shift();
        },
        notify: (message: string) => notifications.push(message),
      },
    } as any;
    const save = async (snapshot: ResourceEntry[]) => {
      writes.push(snapshot.map((entry) => entry.id));
      snapshot[0].selected = false;
    };
    const options = {
      title: "Skills",
      entries: f.entries,
      defaultsScope: "project" as const,
      toggle: async () => {},
      saveDefaults: save,
      saveGlobalDefaults: save,
    };
    await showResourceBrowser(context, options);
    assert.deepEqual(writes, [["review"]]);
    assert.equal(f.entries[1].selected, true, "RPC saves use a captured snapshot");
    assert.match(notifications[0], /1 selected saved; 1 selected skipped/);
    f.entries[1].toggleable = false;
    await showResourceBrowser(context, options);
    assert.deepEqual(writes, [["review"]]);
    assert.match(notifications[1], /No eligible resources.*nothing saved/);
    f.component.dispose();
  }
});

test("empty catalogues still save empty snapshots to clear stale defaults in native and RPC UIs", async () => {
  const writes: Array<[string, number]> = [];
  const f = fixture({
    defaultsScope: "project",
    saveDefaults: async (entries) => {
      writes.push(["project", entries.length]);
    },
    saveGlobalDefaults: async (entries) => {
      writes.push(["global", entries.length]);
    },
  });
  f.entries.length = 0;
  f.component.handleInput("\x13");
  await flush();
  assert.match(f.text(), /Project defaults saved/);
  f.component.handleInput("\x1b[115;6u");
  await flush();
  assert.match(f.text(), /Personal defaults saved/);
  assert.deepEqual(writes, [
    ["project", 0],
    ["global", 0],
  ]);
  const choices = ["Save project defaults", "Save personal defaults (all projects)", "Done"];
  const notifications: string[] = [];
  await showResourceBrowser(
    {
      ui: {
        select: async () => choices.shift(),
        notify: (message: string) => notifications.push(message),
      },
    } as any,
    {
      title: "Skills",
      entries: [],
      defaultsScope: "project",
      toggle: async () => {},
      saveDefaults: async (entries) => {
        writes.push(["project", entries.length]);
      },
      saveGlobalDefaults: async (entries) => {
        writes.push(["global", entries.length]);
      },
    },
  );
  assert.deepEqual(writes, [
    ["project", 0],
    ["global", 0],
    ["project", 0],
    ["global", 0],
  ]);
  assert.match(notifications[0], /Project defaults saved/);
  assert.match(notifications[1], /Personal defaults saved/);
  f.component.dispose();
});

test("snapshot feedback counts partly selected packages as chosen rows", async () => {
  const f = fixture({ saveGlobalDefaults: async () => {} });
  f.entries[0].badge = "partial";
  f.entries[0].globalDefaultable = false;
  f.entries[1].badge = "partial";
  f.component.handleInput("\x1b[115;6u");
  await flush();
  assert.match(f.text(160), /1 selected saved; 1 selected skipped/);
  f.component.dispose();
});
