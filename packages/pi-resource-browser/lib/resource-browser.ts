import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  SelectList,
  Text,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Component, KeyId, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ResourceSearch } from "./resource-search.ts";

export interface ResourcePreview {
  fields?: Array<{ label: string; value: string }>;
  body?: string;
  source?: string;
}

export type ResourceDefaultState = "inherit" | "on" | "off";
export type ResourceSessionMode = "inherit" | "any" | "interactive";
type ResourceScope = "session" | "project" | "global";
type ResourceSource = ResourceScope | "native";

export interface ResourceEntry {
  id: string;
  name: string;
  description: string;
  keywords?: string;
  selected: boolean;
  badge?: string;
  /** Resolved defaults; undefined can represent mixed package members. */
  defaultSelected?: boolean;
  globalDefaultSelected?: boolean;
  sessionState?: ResourceDefaultState | "mixed";
  effectiveSource?: ResourceSource;
  sessionMode?: ResourceSessionMode | "mixed";
  projectMode?: ResourceSessionMode | "mixed";
  globalMode?: ResourceSessionMode | "mixed";
  mode?: "any" | "interactive";
  modeSource?: ResourceSource;
  projectState?: ResourceDefaultState | "mixed";
  globalState?: ResourceDefaultState | "mixed";
  /** Whether this resource may be saved as a default selection. */
  defaultable?: boolean;
  globalDefaultable?: boolean;
  toggleable?: boolean;
  preview(): Promise<string | ResourcePreview>;
}
interface BrowserOptions {
  title: string;
  categories?: Array<{ id: string; label: string; key: KeyId }>;
  activeCategory?: string;
  selectCategory?(id: string): void;
  entries: ResourceEntry[];
  notice?: string;
  selectionScope?: "project" | "session";
  defaultsScope?: "global" | "project";
  defaultsInherited?: boolean;
  theme: Pick<Theme, "fg" | "bg" | "bold">;
  rows(): number;
  render(): void;
  close(changed: boolean): void;
  toggle(entry: ResourceEntry, selected: boolean): Promise<void>;
  /** The host preserves other defaults and refreshes entries' saved and resolved states. */
  setDefault?(
    entry: ResourceEntry,
    state: ResourceDefaultState,
    scope: "project" | "global",
  ): Promise<void>;
  setSession?(entry: ResourceEntry, state: ResourceDefaultState): Promise<void>;
  setMode?(entry: ResourceEntry, mode: ResourceSessionMode, scope: ResourceScope): Promise<void>;
  saveDefaults?(entries: ResourceEntry[]): Promise<void>;
  saveGlobalDefaults?(entries: ResourceEntry[]): Promise<void>;
}
const clean = (text: string) =>
  stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

async function saveDefaultSnapshot(
  options: Pick<
    BrowserOptions,
    "entries" | "defaultsScope" | "saveDefaults" | "saveGlobalDefaults"
  >,
  global: boolean,
): Promise<string> {
  const snapshot = options.entries.map((entry) => ({ ...entry }));
  const eligible = (entry: ResourceEntry) =>
    entry.defaultable !== false &&
    (!global || entry.globalDefaultable !== false) &&
    entry.toggleable !== false;
  const defaultable = snapshot.filter(eligible);
  const chosen = (entry: ResourceEntry) => entry.selected || entry.badge === "partial";
  const skipped = snapshot.filter((entry) => chosen(entry) && !eligible(entry)).length;
  const selected = defaultable.filter(chosen).length;
  const scope = global || options.defaultsScope === "global" ? "global" : "project";
  if (!defaultable.length && snapshot.length)
    return `No eligible resources for ${scope} defaults; nothing saved.`;
  await (global ? options.saveGlobalDefaults : options.saveDefaults)?.(defaultable);
  return skipped
    ? `${scope === "global" ? "Global" : "Project"} defaults: ${selected} selected saved; ${skipped} selected skipped (ineligible).`
    : global
      ? "Personal defaults saved for new sessions across projects."
      : options.defaultsScope === "project"
        ? "Project defaults saved."
        : "Defaults saved for future sessions.";
}

/** Owns one browser interaction; saved project changes survive closing the dialog. */
export class ResourceBrowser implements Component {
  focused = true;
  readonly input: Input;
  private search: ResourceSearch<ResourceEntry>;
  private results: ResourceEntry[];
  private index = 0;
  private offset = 0;
  private pane: "list" | "query" | "preview" = "list";
  private details: string | ResourcePreview = "";
  private detailTab: "overview" | "body" | "source" = "overview";
  private tabRanges: Array<{ tab: "overview" | "body" | "source"; start: number; end: number }> =
    [];
  private categoryRanges: Array<{ id: string; start: number; end: number }> = [];
  private scopeRanges: Array<{
    scope: "session" | "project" | "global";
    row: number;
    start: number;
    end: number;
  }> = [];
  private markdown?: Markdown;
  private markdownText = "";
  private detailOffset = 0;
  private previewId = "";
  private previewGeneration = 0;
  private previews = new Map<string, string | ResourcePreview>();
  private alive = true;
  private changed = false;
  private saving = false;
  private savingDefaults = false;
  private defaultMenu?: { scope: ResourceScope; list: SelectList; rows: number };
  private closeRequested = false;
  private status = "Changes save to this project immediately.";
  private error = false;
  private layout = { left: 0, listY: 0, listRows: 0, previewY: 0, previewX: 0, previewRows: 0 };

  private options: BrowserOptions;

  constructor(options: BrowserOptions) {
    this.options = options;
    this.input = new Input({
      prompt: "Search  ",
      placeholder: "names, descriptions, tools…",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });
    if (options.selectionScope === "session") this.status = "";
    this.search = new ResourceSearch(options.entries);
    this.results = [...options.entries];
    this.refreshPreview();
  }

  get searchFocused(): boolean {
    return this.pane === "query";
  }

  private redraw() {
    if (this.alive) this.options.render();
  }
  private refreshPreview() {
    const entry = this.results[this.index];
    if (entry?.id === this.previewId) return;
    this.previewId = entry?.id ?? "";
    this.detailOffset = 0;
    const generation = ++this.previewGeneration;
    if (!entry) {
      this.details = "No matching resources. Try another word or clear the search.";
      return;
    }
    this.details = this.previews.get(entry.id) ?? "Loading details…";
    if (this.previews.has(entry.id)) return;
    void entry
      .preview()
      .then((text) => {
        if (!this.alive || generation !== this.previewGeneration) return;
        this.details =
          typeof text === "string"
            ? clean(text)
            : {
                fields: text.fields?.map((field) => ({
                  label: clean(field.label),
                  value: clean(field.value),
                })),
                body: text.body === undefined ? undefined : clean(text.body),
                source: text.source === undefined ? undefined : clean(text.source),
              };
        this.previews.set(entry.id, this.details);
        this.redraw();
      })
      .catch((error) => {
        if (!this.alive || generation !== this.previewGeneration) return;
        this.details = `Could not inspect ${entry.name}: ${clean(String(error))}`;
        this.redraw();
      });
  }
  private move(delta: number) {
    this.index = Math.max(0, Math.min(this.results.length - 1, this.index + delta));
    this.refreshPreview();
    this.redraw();
  }
  private filter() {
    const previous = this.results[this.index]?.id;
    this.results = this.search.search(this.input.getValue());
    this.index = Math.max(
      0,
      this.results.findIndex((entry) => entry.id === previous),
    );
    this.offset = 0;
    this.refreshPreview();
    this.redraw();
  }
  private close() {
    if (this.saving || this.savingDefaults) {
      this.closeRequested = true;
      return;
    }
    this.options.close(this.changed);
  }
  async toggleCurrent(): Promise<void> {
    const entry = this.results[this.index];
    if (!entry || this.saving || this.savingDefaults || !this.alive) return;
    if (entry.toggleable === false) {
      this.status = "This resource is supplied by the harness.";
      this.redraw();
      return;
    }
    this.saving = true;
    this.error = false;
    this.status = `Saving ${entry.name}…`;
    this.redraw();
    try {
      const next = !entry.selected;
      await this.options.toggle(entry, next);
      if (!this.alive) return;
      entry.selected = next;
      entry.sessionState = next ? "on" : "off";
      this.changed = true;
      this.status = `${next ? "Added" : "Removed"} ${entry.name} ${next ? "to" : "from"} this ${this.options.selectionScope ?? "project"}.`;
    } catch (error) {
      if (!this.alive) return;
      this.error = true;
      this.closeRequested = false;
      this.status = `Not saved: ${clean(error instanceof Error ? error.message : String(error))}`;
    } finally {
      this.saving = false;
      if (this.alive && this.closeRequested) this.close();
      else this.redraw();
    }
  }
  async saveDefaults(global = false): Promise<void> {
    const save = global ? this.options.saveGlobalDefaults : this.options.saveDefaults;
    if (!save || this.saving || this.savingDefaults || !this.alive) return;
    this.savingDefaults = true;
    this.error = false;
    this.status = global
      ? "Saving personal defaults…"
      : this.options.defaultsScope === "project"
        ? "Saving project defaults…"
        : "Saving defaults for future sessions…";
    this.redraw();
    try {
      const status = await saveDefaultSnapshot(this.options, global);
      if (!this.alive) return;
      this.status = status;
    } catch (error) {
      if (!this.alive) return;
      this.error = true;
      this.status = `Defaults not saved: ${clean(error instanceof Error ? error.message : String(error))}`;
    } finally {
      this.savingDefaults = false;
      if (this.alive && this.closeRequested) this.close();
      else this.redraw();
    }
  }
  async toggleScope(scope: ResourceScope): Promise<void> {
    const entry = this.results[this.index];
    if (!entry || this.saving || this.savingDefaults || !this.alive) return;
    if (scope === "session" && !this.options.setSession) return this.toggleCurrent();
    const unavailable = this.defaultUnavailable(entry, scope);
    if (unavailable) {
      this.error = false;
      this.status = unavailable;
      this.redraw();
      return;
    }
    const theme = this.options.theme;
    const inherited =
      scope === "session" ? "project/global" : scope === "project" ? "global" : "native";
    const current = this.defaultState(entry, scope);
    const mode = this.scopeMode(entry, scope);
    const items = [
      {
        value: "inherit",
        label: "Inherit",
        description: `Selection: use ${inherited} default${current === "inherit" ? " · current" : ""}`,
      },
      {
        value: "on",
        label: "On",
        description: `Selection: include${current === "on" ? " · current" : ""}`,
      },
      {
        value: "off",
        label: "Off",
        description: `Selection: exclude${current === "off" ? " · current" : ""}`,
      },
      ...(this.options.setMode
        ? [
            {
              value: "mode:inherit",
              label: "Type: Inherit",
              description: `Use ${inherited} session type${mode === "inherit" ? " · current" : ""}`,
            },
            {
              value: "mode:any",
              label: "Any session",
              description: `TUI, RPC and print${mode === "any" ? " · current" : ""}`,
            },
            {
              value: "mode:interactive",
              label: "Interactive only",
              description: `TUI only${mode === "interactive" ? " · current" : ""}`,
            },
          ]
        : []),
    ];
    const list = new SelectList(
      items,
      items.length,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
      { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 18 },
    );
    list.setSelectedIndex(Math.max(0, ["inherit", "on", "off"].indexOf(current ?? "inherit")));
    list.onSelect = (item) => {
      this.defaultMenu = undefined;
      if (item.value.startsWith("mode:"))
        void this.setScopeMode(scope, item.value.slice(5) as ResourceSessionMode);
      else void this.setScopeState(scope, item.value as ResourceDefaultState);
    };
    list.onCancel = () => {
      this.defaultMenu = undefined;
      this.redraw();
    };
    this.defaultMenu = { scope, list, rows: items.length };
    this.pane = "preview";
    this.redraw();
  }
  private defaultState(entry: ResourceEntry, scope: ResourceScope) {
    if (scope === "session") return entry.sessionState ?? (entry.selected ? "on" : "off");
    const state = scope === "project" ? entry.projectState : entry.globalState;
    if (state !== undefined) return state;
    // Composing hosts may supply resolved booleans without explicit saved states.
    if (scope === "project" && this.options.defaultsInherited) return "inherit";
    const value = scope === "project" ? entry.defaultSelected : entry.globalDefaultSelected;
    return value === undefined ? undefined : value ? "on" : "off";
  }
  private scopeMode(entry: ResourceEntry, scope: ResourceScope) {
    return entry[`${scope}Mode`] ?? "inherit";
  }
  private canEditDefault(entry: ResourceEntry, scope: ResourceScope) {
    return Boolean(
      !this.saving && !this.savingDefaults && this.alive && !this.defaultUnavailable(entry, scope),
    );
  }
  private defaultUnavailable(entry: ResourceEntry, scope: ResourceScope) {
    const label = scope[0].toUpperCase() + scope.slice(1);
    if (entry.toggleable === false) return `${label} unavailable: supplied by the harness.`;
    if (scope === "session")
      return this.options.setSession
        ? undefined
        : "Session inheritance cannot be edited by this browser.";
    if (entry.defaultable === false)
      return `${label} default unavailable: this resource cannot be defaulted.`;
    if (scope === "global" && entry.globalDefaultable === false)
      return "Global default unavailable: loaded only for this project or launch.";
    if (!this.options.setDefault)
      return `${label} default unavailable: this browser cannot edit it.`;
    if (this.defaultState(entry, scope) === undefined)
      return `${label} default unavailable: saved state is unknown.`;
    return undefined;
  }
  async setScopeState(scope: ResourceScope, state: ResourceDefaultState): Promise<void> {
    const entry = this.results[this.index];
    if (!entry || !this.canEditDefault(entry, scope)) return;
    await this.saveScope(scope, async () => {
      if (scope === "session") await this.options.setSession!(entry, state);
      else await this.options.setDefault!(entry, state, scope);
    });
  }
  async setScopeMode(scope: ResourceScope, mode: ResourceSessionMode): Promise<void> {
    const entry = this.results[this.index];
    if (!entry || !this.options.setMode || !this.canEditDefault(entry, scope)) return;
    await this.saveScope(scope, () => this.options.setMode!(entry, mode, scope));
  }
  private async saveScope(scope: ResourceScope, save: () => Promise<void>) {
    const entry = this.results[this.index]!;
    this.defaultMenu = undefined;
    this.savingDefaults = true;
    this.error = false;
    this.status = `Saving ${scope} choice for ${entry.name}…`;
    this.redraw();
    try {
      await save();
      if (!this.alive) return;
      this.changed = true;
      this.status = "";
    } catch (error) {
      if (!this.alive) return;
      this.error = true;
      this.closeRequested = false;
      this.status = `Choice not saved: ${clean(error instanceof Error ? error.message : String(error))}`;
    } finally {
      this.savingDefaults = false;
      if (this.alive && this.closeRequested) this.close();
      else this.redraw();
    }
  }
  handleInput(data: string): void {
    if (this.defaultMenu) {
      this.defaultMenu.list.handleInput(data);
      this.redraw();
      return;
    }
    if (!this.searchFocused) {
      const category = this.options.categories?.find((category) => matchesKey(data, category.key));
      if (category && this.options.selectCategory && !this.saving && !this.savingDefaults) {
        this.options.selectCategory(category.id);
        return;
      }
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      this.close();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.pane === "query") {
        this.pane = "list";
        this.redraw();
      } else this.close();
      return;
    }
    if (matchesKey(data, Key.ctrlShift("s"))) {
      void this.saveDefaults(true);
      return;
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      void this.saveDefaults();
      return;
    }
    if (matchesKey(data, Key.ctrl("f")) || (this.pane !== "query" && matchesKey(data, "/"))) {
      this.pane = "query";
      this.redraw();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "preview" ? "list" : "preview";
      this.redraw();
      return;
    }
    if (this.pane === "query") {
      if (matchesKey(data, Key.enter)) {
        this.pane = "list";
        this.redraw();
        return;
      }
      if (!matchesKey(data, Key.up) && !matchesKey(data, Key.down)) {
        this.input.handleInput(data);
        this.filter();
        return;
      }
    }
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, "h") ||
      matchesKey(data, Key.right) ||
      matchesKey(data, "l")
    ) {
      const forward = matchesKey(data, Key.right) || matchesKey(data, "l");
      const tabs = ["overview", "body", "source"] as const;
      if (this.pane !== "preview") {
        if (forward) {
          this.pane = "preview";
          this.detailTab = "overview";
        }
      } else {
        const next = tabs.indexOf(this.detailTab) + (forward ? 1 : -1);
        if (next < 0) this.pane = "list";
        else if (next < tabs.length) this.detailTab = tabs[next];
      }
      this.detailOffset = 0;
      this.redraw();
      return;
    }
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.down) ||
      matchesKey(data, "k") ||
      matchesKey(data, "j")
    ) {
      const delta = matchesKey(data, Key.up) || matchesKey(data, "k") ? -1 : 1;
      if (this.pane === "preview") this.detailOffset = Math.max(0, this.detailOffset + delta);
      else {
        this.pane = "list";
        this.move(delta);
      }
      this.redraw();
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const delta = matchesKey(data, Key.pageUp) ? -5 : 5;
      if (this.pane === "preview") this.detailOffset = Math.max(0, this.detailOffset + delta);
      else this.move(delta);
      this.redraw();
      return;
    }
    if (!this.searchFocused) {
      for (const [key, scope] of [
        ["s", "session"],
        ["p", "project"],
        ["g", "global"],
      ] as const) {
        if (matchesKey(data, key)) {
          void this.toggleScope(scope);
          return;
        }
      }
    }
    if (matchesKey(data, Key.enter) || (this.pane === "list" && matchesKey(data, Key.space))) {
      if (this.pane === "list") void this.toggleCurrent();
    }
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.defaultMenu) {
      const x = event.x - 2 - this.layout.previewX - 2;
      const y = event.y - 1 - this.layout.previewY - 1;
      if (
        x >= 0 &&
        x < event.width - this.layout.previewX - 8 &&
        y >= 0 &&
        y < this.defaultMenu.rows
      ) {
        const result = this.defaultMenu.list.handleMouse({ ...event, x, y });
        this.redraw();
        return result;
      }
      return { handled: true };
    }
    if (event.y === 0 && event.type === "click" && event.button === "left") {
      const category = this.categoryRanges.find(
        (range) => event.x >= range.start && event.x < range.end,
      );
      if (category && this.options.selectCategory && !this.saving && !this.savingDefaults) {
        this.options.selectCategory(category.id);
        return { handled: true, focus: true };
      }
    }
    // The frame adds one row and two columns around the interactive content.
    if (event.width < 12 || event.x < 2 || event.x >= event.width - 2 || event.y < 1)
      return undefined;
    event = { ...event, x: event.x - 2, y: event.y - 1, width: event.width - 4 };
    const l = this.layout;
    if (
      event.y === 0 &&
      event.button === "left" &&
      (event.type === "click" || event.type === "press")
    ) {
      this.pane = "query";
      this.input.focused = this.focused;
      this.input.handleMouse({ ...event, y: 0, height: 1 });
      this.redraw();
      return { handled: true, focus: true };
    }
    if (
      event.y === l.previewY - 1 &&
      event.x >= l.previewX &&
      event.type === "click" &&
      event.button === "left"
    ) {
      const range = this.tabRanges.find(
        (range) => event.x - l.previewX - 2 >= range.start && event.x - l.previewX - 2 < range.end,
      );
      if (range) {
        this.detailTab = range.tab;
        this.detailOffset = 0;
        this.pane = "preview";
        this.redraw();
        return { handled: true, focus: true };
      }
    }
    if (
      event.y >= l.previewY + 1 &&
      event.y < l.previewY + l.previewRows &&
      event.type === "click" &&
      event.button === "left"
    ) {
      const range = this.scopeRanges.find(
        (range) =>
          event.y === l.previewY + range.row &&
          event.x - l.previewX - 2 >= range.start &&
          event.x - l.previewX - 2 < range.end,
      );
      if (range) {
        this.pane = "preview";
        void this.toggleScope(range.scope);
        return { handled: true, focus: true };
      }
    }
    if (event.y >= l.previewY && event.y < l.previewY + l.previewRows && event.x >= l.previewX) {
      if (event.type === "wheel") {
        this.pane = "preview";
        this.detailOffset = Math.max(0, this.detailOffset + (event.wheelDelta ?? 0));
        this.redraw();
        return { handled: true };
      }
      if (event.type === "click") {
        this.pane = "preview";
        this.redraw();
        return { handled: true, focus: true };
      }
    }
    if (event.x < l.left && event.y >= l.listY && event.y < l.listY + l.listRows) {
      if (event.type === "wheel") {
        this.pane = "list";
        this.move(event.wheelDelta ?? 0);
        return { handled: true };
      }
      const index = this.offset + event.y - l.listY;
      if (index >= this.results.length) return undefined;
      if (event.type === "click" && event.button === "left") {
        this.pane = "list";
        this.index = index;
        this.refreshPreview();
        void this.toggleCurrent();
        return { handled: true, focus: true };
      }
      if (event.type === "move") {
        this.index = index;
        this.refreshPreview();
        this.redraw();
        return { handled: true, render: true };
      }
    }
    return undefined;
  }
  render(width: number): string[] {
    if (width < 12) return [truncateToWidth(this.options.title, width)];
    const frameWidth = width;
    width -= 4;
    const theme = this.options.theme;
    const wide = width >= 78;
    const budget = Math.max(
      8,
      Math.min(
        18,
        Math.floor(this.options.rows() * 0.7) -
          (wide ? 10 : 13) -
          (this.options.saveGlobalDefaults ? 1 : 0),
      ),
    );
    const listRows = wide ? budget : Math.max(2, Math.floor(budget * 0.4));
    let previewRows = Math.max(
      this.defaultMenu ? this.defaultMenu.rows + 2 : 7,
      wide ? budget : budget - listRows,
    );
    const left = wide ? Math.min(46, Math.floor((width - 1) * 0.38)) : width;
    const right = wide ? width - left - 1 : width;
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + listRows) this.offset = this.index - listRows + 1;
    this.offset = Math.max(0, this.offset);
    this.input.focused = this.focused && this.pane === "query";
    const selected = this.options.entries.filter((entry) => entry.selected).length;
    const searchHintWidth = Math.min(24, Math.floor(width / 2));
    const searchHint = this.searchFocused ? "SEARCH ACTIVE · Esc" : "/ or click to search";
    const searchLine =
      this.input.render(width - searchHintWidth)[0] +
      theme.fg(
        this.searchFocused ? "accent" : "dim",
        truncateToWidth(searchHint, searchHintWidth, "", true),
      );
    const lines = [this.searchFocused ? theme.bg("selectedBg", searchLine) : searchLine, ""];
    const pad = (line: string, columns: number) => {
      const result = truncateToWidth(line, columns, "…");
      return result + " ".repeat(Math.max(0, columns - visibleWidth(result)));
    };
    const box = (
      title: string,
      body: string[],
      columns: number,
      height: number,
      active: boolean,
      endTitle = "",
    ) => {
      const border = (text: string) => theme.fg(active ? "accent" : "borderMuted", text);
      const end = endTitle ? ` ${truncateToWidth(endTitle, Math.max(0, columns - 8), "…")} ` : "";
      const label = truncateToWidth(
        ` ${title} `,
        Math.max(0, columns - 2 - visibleWidth(end)),
        "…",
      );
      const top =
        border("╭") +
        label +
        border(
          "─".repeat(Math.max(0, columns - 2 - visibleWidth(label) - visibleWidth(end))) +
            end +
            "╮",
        );
      return [
        top,
        ...Array.from(
          { length: height },
          (_, i) => border("│") + pad(body[i] ?? "", columns - 2) + border("│"),
        ),
        border("╰" + "─".repeat(columns - 2) + "╯"),
      ];
    };
    const rows = this.results.slice(this.offset, this.offset + listRows).map((entry, i) => {
      const isCurrent = this.offset + i === this.index;
      const marker =
        entry.badge === "partial"
          ? theme.fg("muted", "[-]")
          : entry.selected
            ? theme.fg("success", "[x]")
            : theme.fg("dim", "[ ]");
      let row = `${isCurrent ? "›" : " "} ${marker} ${clean(entry.name)}`;
      if (entry.badge === "partial") row += theme.fg("muted", " · partial");
      const scopes = (["session", "project", "global"] as const)
        .map((scope) => {
          const state = this.defaultState(entry, scope);
          const marker =
            state === "on"
              ? ""
              : state === "off"
                ? ""
                : state === "inherit"
                  ? "·"
                  : state === "mixed"
                    ? ""
                    : "—";
          return theme.fg(state === "on" ? "success" : state === "off" ? "text" : "dim", marker);
        })
        .join("  ");
      row = pad(row, left - 10) + scopes + " ";
      return isCurrent ? theme.bg("selectedBg", row) : row;
    });
    if (!rows.length) rows.push(theme.fg("muted", "No matches"));
    const entry = this.results[this.index];
    const preview = typeof this.details === "string" ? { body: this.details } : this.details;
    const tabs = ["overview", "body", "source"] as const;
    let tabColumn = 0;
    this.tabRanges = [];
    const tabLine = tabs
      .map((tab) => {
        const label = tab === "body" ? "Instructions" : tab[0].toUpperCase() + tab.slice(1);
        const shown = ` ${label} `;
        this.tabRanges.push({ tab, start: tabColumn, end: tabColumn + shown.length });
        tabColumn += shown.length + 1;
        return this.detailTab === tab
          ? theme.bold(theme.fg("accent", shown))
          : theme.fg("muted", shown);
      })
      .join(theme.fg("borderMuted", "─"));
    this.scopeRanges = [];
    let scopeColumn = 0;
    const scopeLines: string[] = [""];
    const state = entry
      ? (["session", "project", "global"] as const)
          .map((scope) => {
            const savedState = this.defaultState(entry, scope);
            const stateLabel = (savedState?.toUpperCase() ?? "—").padEnd(7);
            const label = `${`${scope[0].toUpperCase() + scope.slice(1)}:`.padEnd(9)}${stateLabel}`;
            const enabled = this.canEditDefault(entry, scope);
            const shown = label;
            if (scopeColumn && scopeColumn + shown.length > Math.max(1, right - 4)) {
              scopeLines.push("");
              scopeColumn = 0;
            }
            this.scopeRanges.push({
              scope,
              row: scopeLines.length,
              start: scopeColumn,
              end: scopeColumn + shown.length,
            });
            scopeColumn += shown.length + 3;
            const styled = theme.fg(
              enabled
                ? savedState === "on"
                  ? "success"
                  : savedState === "inherit"
                    ? "muted"
                    : "text"
                : "muted",
              shown,
            );
            scopeLines[scopeLines.length - 1] += styled + "   ";
            return styled;
          })
          .join("   ")
      : "No matching resource";
    const stateLines = entry
      ? scopeLines.map((line) => truncateToWidth(line.trimEnd(), Math.max(1, right - 4)))
      : [state];
    const applies = entry?.mode
      ? `Applies in: ${entry.mode === "interactive" ? "Interactive only" : "Any session"}${entry.modeSource ? ` — ${entry.modeSource}` : ""}`
      : "";
    const pinned = [
      "",
      ...stateLines.map((line) => " " + line),
      "",
      ...[applies]
        .filter(Boolean)
        .flatMap((line) =>
          new Text(line, 0, 0).render(Math.max(1, right - 4)).map((part) => " " + part),
        ),
      "",
    ];
    if (!this.defaultMenu) previewRows = Math.max(previewRows, pinned.length + 1);
    const contentWidth = Math.max(1, right - 4);
    let detailLines: string[];
    if (this.detailTab === "body") {
      const details =
        preview.body ?? "No instruction body in this package. Inspect its members individually.";
      if (!this.markdown || details !== this.markdownText) {
        this.markdown = new Markdown(details, 0, 0, getMarkdownTheme());
        this.markdownText = details;
      }
      detailLines = this.markdown.render(contentWidth);
    } else if (this.detailTab === "source") {
      detailLines = new Text(
        [
          entry?.badge && entry.badge !== "partial" ? `Package/source: ${clean(entry.badge)}` : "",
          preview.source ?? "No separate source path supplied.",
          entry?.globalDefaultable === false
            ? "Loaded only for this project or launch; cannot save as a personal default."
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        0,
        0,
      ).render(contentWidth);
    } else {
      const labelWidth = Math.min(
        16,
        Math.max(0, ...(preview.fields ?? []).map((field) => field.label.length)),
      );
      const fields =
        preview.fields?.map(
          (field) =>
            `${theme.fg("muted", field.label.padEnd(labelWidth) + " :")} ${theme.fg("text", field.value)}`,
        ) ?? [];
      detailLines = new Text(
        [
          ...(["project", "global"] as const).flatMap((scope) => {
            const reason = entry && this.defaultUnavailable(entry, scope);
            return reason ? [reason] : [];
          }),
          entry?.globalDefaultable === false
            ? "Add or enable it in personal settings to reuse it."
            : undefined,
          typeof this.details === "string" ? this.details : (entry?.description ?? ""),
          fields.length ? "" : undefined,
          ...fields,
          this.options.notice ? `Diagnostics: ${clean(this.options.notice)}` : undefined,
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
        0,
        0,
      ).render(contentWidth);
    }
    const contentRows = Math.max(1, previewRows - pinned.length);
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, detailLines.length - contentRows));
    const detailBody = this.defaultMenu
      ? [
          ` ${this.defaultMenu.scope[0].toUpperCase() + this.defaultMenu.scope.slice(1)} choices${entry && this.defaultState(entry, this.defaultMenu.scope) === "mixed" ? " · MIXED" : ""}`,
          ...this.defaultMenu.list.render(contentWidth).map((line) => " " + line),
        ]
      : [
          ...pinned,
          ...detailLines
            .slice(this.detailOffset, this.detailOffset + contentRows)
            .map((line) => " " + line),
        ];
    const listBox = box(
      theme.fg(
        this.pane !== "preview" ? "accent" : "borderMuted",
        `${this.options.title} · ${selected} selected · ${this.results.length}/${this.options.entries.length}`,
      ),
      rows,
      left,
      wide ? previewRows : listRows,
      this.pane !== "preview",
      "    ",
    );
    const previewBox = box(
      tabLine,
      detailBody,
      right,
      previewRows,
      this.pane === "preview",
      truncateToWidth(
        clean(entry?.name ?? "Details"),
        Math.max(0, right - visibleWidth(tabLine) - 6),
        "…",
      ),
    );
    this.layout = {
      left,
      listY: lines.length + 1,
      listRows,
      previewY: wide ? lines.length + 1 : lines.length + listBox.length + 2,
      previewX: wide ? left + 1 : 0,
      previewRows,
    };
    if (wide) lines.push(...listBox.map((line, i) => line + " " + previewBox[i]));
    else lines.push(...listBox, "", ...previewBox);
    lines.push(
      truncateToWidth(
        theme.fg(
          this.error ? "error" : "muted",
          this.status || " On    Off   · Inherit    Mixed   — Unknown",
        ),
        width,
      ),
    );
    const help = (items: Array<[string, string]>) => {
      let row = "";
      for (const [key, label] of items) {
        const item = `${theme.fg("muted", key)} ${theme.fg("dim", label)}`;
        if (row && visibleWidth(row) + 3 + visibleWidth(item) > width) {
          lines.push(row);
          row = "";
        }
        row += (row ? "   " : "") + item;
      }
      if (row) lines.push(truncateToWidth(row, width));
    };
    if (this.defaultMenu)
      help([
        ["↑↓", "Choose"],
        ["Enter", "Apply"],
        ["Esc", "Cancel"],
      ]);
    else {
      help(
        this.searchFocused
          ? [
              ["Type", "Filter"],
              ["Enter", "Browse results"],
              ["Esc", "Leave search"],
            ]
          : [
              ["/", "Search"],
              ["↑↓/jk", "Move"],
              ["←→/hl", "Tabs"],
              ["Tab", "Pane"],
              ["Enter/Space", "Toggle"],
              ["Esc", "Close"],
            ],
      );
      help([
        ...(!this.searchFocused && (this.options.setDefault || this.options.setSession)
          ? ([
              ["s", "Session"],
              ["p", "Project"],
              ["g", "Global"],
            ] as Array<[string, string]>)
          : []),
        ...(this.options.saveDefaults
          ? ([
              [
                "Ctrl+S",
                `Save ${this.options.defaultsScope === "project" ? "project" : "defaults"}`,
              ],
            ] as Array<[string, string]>)
          : []),
        ...(this.options.saveGlobalDefaults
          ? ([["Ctrl+Shift+S", "Save global"]] as Array<[string, string]>)
          : []),
      ]);
    }
    const border = (text: string) => theme.fg("accent", text);
    this.categoryRanges = [];
    let categoryColumn = 2;
    const categories = (this.options.categories ?? [])
      .map((category) => {
        const label = ` ${clean(category.key)} ${clean(category.label)} `;
        if (categoryColumn + label.length <= frameWidth - 1)
          this.categoryRanges.push({
            id: category.id,
            start: categoryColumn,
            end: categoryColumn + label.length,
          });
        categoryColumn += label.length + 1;
        return category.id === this.options.activeCategory
          ? theme.bold(theme.fg("accent", label))
          : theme.fg("borderMuted", label);
      })
      .join(border("─"));
    const top = this.options.categories?.length
      ? border("╭─") +
        truncateToWidth(categories, frameWidth - 3, "", true).replace(/ +$/, (spaces) =>
          border("─".repeat(spaces.length)),
        ) +
        border("╮")
      : border(`╭${"─".repeat(frameWidth - 2)}╮`);
    return [
      top,
      ...lines.map((line) => `${border("│")} ${pad(line, width)} ${border("│")}`),
      border(`╰${"─".repeat(frameWidth - 2)}╯`),
    ];
  }
  invalidate(): void {
    this.input.invalidate();
    this.defaultMenu?.list.invalidate();
    this.markdown?.invalidate();
  }
  dispose(): void {
    this.alive = false;
    this.previewGeneration++;
  }
}

/** Route resource tabs through Pi's existing slash-command dispatcher. */
export function resourceBrowserNavigation(pi: ExtensionAPI, activeCategory: string) {
  const names = ["agents", "skills", "instructions", "packages"];
  const available = new Set(
    (pi.getCommands?.() ?? [])
      .filter((command) => command.source === "extension")
      .map((command) => command.name),
  );
  return {
    categories: names
      .map((id, index) => ({
        id,
        label: id[0].toUpperCase() + id.slice(1),
        key: String(index + 1) as KeyId,
      }))
      .filter((category) => available.has(category.id)),
    activeCategory,
    selectCategory: (id: string) => {
      if (id !== activeCategory && available.has(id))
        pi.sendUserMessage(`/${id}`, { expandPromptTemplates: true });
    },
  };
}

export async function showResourceBrowser(
  ctx: ExtensionCommandContext,
  options: Omit<BrowserOptions, "theme" | "rows" | "render" | "close">,
): Promise<boolean> {
  if (typeof ctx.ui.custom === "function") {
    try {
      let nextCategory: string | undefined;
      const changed = await ctx.ui.custom<boolean>(
        (tui, theme, _keys, done) =>
          new ResourceBrowser({
            ...options,
            selectCategory: options.selectCategory
              ? (id) => {
                  if (id !== options.activeCategory) {
                    nextCategory = id;
                    done(false);
                  }
                }
              : undefined,
            theme,
            rows: () => tui.terminal.rows,
            render: () => tui.requestRender(),
            close: done,
          }),
        // Pi mounts non-overlay custom components in its editor slot, above the footer,
        // and restores the prompt text and focus when the component closes.
        { overlay: false },
      );
      if (nextCategory) options.selectCategory?.(nextCategory);
      return changed;
    } catch (error) {
      if (!/custom.*(?:not supported|unsupported|not available|unavailable)/i.test(String(error)))
        throw error;
    }
  }
  // RPC clients can provide native single-choice dialogs but cannot host custom components.
  if (options.notice) ctx.ui.notify(options.notice, "warning");
  let changed = false;
  while (true) {
    const labels = options.entries.map(
      (entry) => `${entry.selected ? "[x]" : "[ ]"} ${entry.name}`,
    );
    const chosen = await ctx.ui.select(options.title, [
      ...labels,
      ...(options.saveDefaults
        ? [
            options.defaultsScope === "project"
              ? "Save project defaults"
              : "Save selected as defaults",
          ]
        : []),
      ...(options.saveGlobalDefaults ? ["Save personal defaults (all projects)"] : []),
      "Done",
    ]);
    if (!chosen || chosen === "Done") return changed;
    if (chosen === "Save personal defaults (all projects)" && options.saveGlobalDefaults) {
      ctx.ui.notify(await saveDefaultSnapshot(options, true), "info");
      continue;
    }
    if (
      options.saveDefaults &&
      chosen ===
        (options.defaultsScope === "project"
          ? "Save project defaults"
          : "Save selected as defaults")
    ) {
      ctx.ui.notify(await saveDefaultSnapshot(options, false), "info");
      continue;
    }
    const entry = options.entries[labels.indexOf(chosen)];
    if (!entry || entry.toggleable === false) continue;
    await options.toggle(entry, !entry.selected);
    entry.selected = !entry.selected;
    changed = true;
  }
}
