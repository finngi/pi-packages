import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ResourceBrowser, resourceBrowserNavigation } from "./resource-browser.ts";
import type { ResourceEntry } from "./resource-browser.ts";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(
  overrides: {
    toggle?: (entry: ResourceEntry, selected: boolean) => Promise<void>;
    saveDefaults?: (entries: ResourceEntry[]) => Promise<void>;
    saveGlobalDefaults?: (entries: ResourceEntry[]) => Promise<void>;
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
    theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    rows: () => 42,
    render() {},
    close: (changed) => closed.push(changed),
    saveDefaults: overrides.saveDefaults,
    saveGlobalDefaults: overrides.saveGlobalDefaults,
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
  assert.match(f.text(), /1 project-only or fixed choice was not defaulted/);
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
  assert.match(f.text(), /1\/2 shown/);
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
  assert.match(f.text(), /1\/2 shown/);
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
  assert.match(f.text(), /Personal defaults saved for new sessions across projects/);
  assert.match(f.text(), /1 project-only or fixed choice/);
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
    saveDefaults: async () => {},
  });
  await flush();
  const text = () => component.render(110).map(stripTerminalSequences).join("\n");
  assert.match(text(), /Child skills\s+: private-check/);
  assert.match(text(), /↳ global/);
  assert.doesNotMatch(text(), /BODY_ONLY|\/agent\/role.md/);
  component.handleInput("\t");
  component.handleInput("\x1b[C");
  assert.match(text(), /\[Instructions\]/);
  assert.match(text(), /BODY_ONLY/);
  assert.doesNotMatch(text(), /Child skills\s+: private-check/);
  component.handleInput("\r");
  assert.equal(f.entries[0].selected, false, "read-only preview Enter must not change selections");
  component.handleInput("\x1b[C");
  assert.match(text(), /\[Source\]/);
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
  const y = rows.findIndex((row) => row.includes("[Overview]"));
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
  assert.match(text, /\[Instructions\]/);
  assert.match(text, /BODY_ROW/);
  for (let i = 0; i < 4; i++) component.handleInput("\x1b[6~");
  text = component.render(110).map(stripTerminalSequences).join("\n");
  assert.match(text, /Session: OFF/);
  assert.match(text, /\[Instructions\]/);
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
  assert.match(f.text(), /\[Instructions\]/);
  f.component.handleInput("h");
  assert.match(f.text(), /\[Overview\]/);
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

test("project activation enables the session while preserving unrelated saved selections", async () => {
  const f = fixture();
  f.entries[0].defaultSelected = false;
  f.entries[0].globalDefaultSelected = false;
  f.entries[1].defaultSelected = true;
  f.entries[1].globalDefaultSelected = true;
  const calls: Array<[string, boolean, string]> = [];
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
    setDefault: async (entry, value, scope) => {
      calls.push([entry.id, value, scope]);
    },
  });
  await component.toggleScope("project");
  assert.deepEqual(calls, [["adr", true, "project"]]);
  assert.equal(f.entries[0].selected, true);
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].globalDefaultSelected, false);
  await component.toggleScope("global");
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
      setDefault: async () => {},
    });
    await flush();
    const rows = component.render(width).map(stripTerminalSequences);
    const y = rows.findIndex((row) => row.includes("[Project: OFF]"));
    const x = rows[y].indexOf("[Project: OFF]") + 3;
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
    assert.equal(f.entries[0].defaultSelected, true);
    assert.equal(f.entries[0].selected, true);
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
    setDefault: async () => {
      throw Error("Denied save");
    },
  });
  await component.toggleScope("project");
  assert.equal(f.entries[0].defaultSelected, false);
  assert.match(
    component.render(140).map(stripTerminalSequences).join("\n"),
    /Default not saved: Denied save/,
  );
  f.entries[0].globalDefaultable = false;
  await component.toggleScope("global");
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
    setDefault: async () => {},
  });
  const state = () =>
    component
      .render(140)
      .map(stripTerminalSequences)
      .find((row) => row.includes("[Session:"))!;
  const before = state();
  await component.toggleCurrent();
  const after = state();
  assert.match(after, /\[Session: ON \]/);
  assert.equal(after.indexOf("[Project:"), before.indexOf("[Project:"));
  assert.equal(after.indexOf("[Global:"), before.indexOf("[Global:"));
  await component.toggleScope("project");
  assert.equal(state().indexOf("[Global:"), before.indexOf("[Global:"));
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
    setDefault: async () => {},
  });
  component.handleInput("p");
  await flush();
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, true);
  component.handleInput("s");
  await flush();
  assert.equal(f.entries[0].selected, false);
  component.handleInput("g");
  await flush();
  assert.equal(f.entries[0].globalDefaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  component.handleInput("/");
  component.handleInput("spg");
  assert.equal(component.input.getValue(), "spg");
  assert.equal(f.entries[0].selected, false);
  component.dispose();
  f.component.dispose();
});

test("project activation reports a saved default separately if session activation fails", async () => {
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
    setDefault: async () => {},
  });
  await component.toggleScope("project");
  assert.equal(f.entries[0].defaultSelected, true);
  assert.equal(f.entries[0].selected, false);
  assert.match(
    component.render(140).map(stripTerminalSequences).join("\n"),
    /Project default ON saved; session could not be enabled: Session unavailable/,
  );
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
