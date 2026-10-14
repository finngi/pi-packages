import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
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

export interface ResourceEntry {
  id: string;
  name: string;
  description: string;
  keywords?: string;
  selected: boolean;
  badge?: string;
  defaultSelected?: boolean;
  globalDefaultSelected?: boolean;
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
  /** Optional per-resource default editor; the host preserves other saved defaults. */
  setDefault?(entry: ResourceEntry, selected: boolean, scope: "project" | "global"): Promise<void>;
  saveDefaults?(entries: ResourceEntry[]): Promise<void>;
  saveGlobalDefaults?(entries: ResourceEntry[]): Promise<void>;
}
const clean = (text: string) =>
  stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

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
    if (options.selectionScope === "session") this.status = "Changes apply only to this session.";
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
    const snapshot = this.options.entries.map((entry) => ({ ...entry }));
    const defaultable = snapshot.filter(
      (entry) =>
        entry.defaultable !== false &&
        (!global || entry.globalDefaultable !== false) &&
        entry.toggleable !== false,
    );
    const selected = new Set(
      defaultable.filter((entry) => entry.selected).map((entry) => entry.id),
    );
    const skipped = snapshot.filter(
      (entry) =>
        entry.selected &&
        (entry.defaultable === false ||
          (global && entry.globalDefaultable === false) ||
          entry.toggleable === false),
    ).length;
    try {
      await save(defaultable);
      if (!this.alive) return;
      if (!global) this.options.defaultsInherited = false;
      for (const entry of this.options.entries) {
        if (global) entry.globalDefaultSelected = selected.has(entry.id);
        else entry.defaultSelected = selected.has(entry.id);
      }
      this.status = global
        ? `Personal defaults saved for new sessions across projects.${skipped ? ` ${skipped} project-only or fixed choice${skipped === 1 ? " was" : "s were"} skipped.` : ""}`
        : skipped
          ? `Defaults saved for future sessions. ${skipped} project-only or fixed choice${skipped === 1 ? " was" : "s were"} not defaulted.`
          : this.options.defaultsScope === "project"
            ? "Project defaults saved."
            : "Defaults saved for future sessions.";
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
  async toggleScope(scope: "session" | "project" | "global"): Promise<void> {
    if (scope === "session") return this.toggleCurrent();
    const entry = this.results[this.index];
    if (!entry || !this.options.setDefault || this.saving || this.savingDefaults || !this.alive)
      return;
    if (
      entry.toggleable === false ||
      entry.defaultable === false ||
      (scope === "global" && entry.globalDefaultable === false)
    )
      return;
    const current =
      scope === "global"
        ? entry.globalDefaultSelected
        : this.options.defaultsInherited
          ? entry.globalDefaultSelected
          : entry.defaultSelected;
    if (current === undefined) return;
    this.savingDefaults = true;
    this.error = false;
    this.status = `Saving ${scope} default for ${entry.name}…`;
    this.redraw();
    let defaultSaved = false;
    try {
      await this.options.setDefault(entry, !current, scope);
      if (!this.alive) return;
      if (scope === "global") entry.globalDefaultSelected = !current;
      else {
        if (this.options.defaultsInherited) {
          for (const item of this.options.entries)
            item.defaultSelected = item.globalDefaultSelected;
        }
        this.options.defaultsInherited = false;
        entry.defaultSelected = !current;
      }
      defaultSaved = true;
      if (scope === "project" && !current && !entry.selected) {
        await this.options.toggle(entry, true);
        if (!this.alive) return;
        entry.selected = true;
        this.changed = true;
      }
      this.status = `${entry.name}: ${scope} default ${current ? "OFF" : "ON"}.${scope === "project" && !current ? " Enabled in this session." : " Current session unchanged."}`;
    } catch (error) {
      if (!this.alive) return;
      this.error = true;
      this.closeRequested = false;
      const reason = clean(error instanceof Error ? error.message : String(error));
      this.status = defaultSaved
        ? `Project default ON saved; session could not be enabled: ${reason}`
        : `Default not saved: ${reason}`;
    } finally {
      this.savingDefaults = false;
      if (this.alive && this.closeRequested) this.close();
      else this.redraw();
    }
  }
  handleInput(data: string): void {
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
      event.y === l.previewY &&
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
          event.y === l.previewY + 1 + range.row &&
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
    const previewRows = wide ? budget : Math.max(2, budget - listRows);
    const left = wide ? Math.min(46, Math.floor((width - 1) * 0.38)) : width;
    const right = wide ? width - left - 1 : width;
    if (this.index < this.offset) this.offset = this.index;
    if (this.index >= this.offset + listRows) this.offset = this.index - listRows + 1;
    this.offset = Math.max(0, this.offset);
    this.input.focused = this.focused && this.pane === "query";
    const selected = this.options.entries.filter((entry) => entry.selected).length;
    const searchHintWidth = Math.min(24, Math.floor(width / 2));
    const searchHint = this.searchFocused ? "[SEARCH ACTIVE · Esc]" : "/ or click to search";
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
    ) => {
      const border = (text: string) => theme.fg(active ? "accent" : "borderMuted", text);
      const label = ` ${title} `;
      const top =
        "╭" +
        truncateToWidth(label, columns - 2, "", true).replace(/ +$/, (m) => "─".repeat(m.length)) +
        "╮";
      return [
        border(top),
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
      row = pad(row, left - 2);
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
        const shown = this.detailTab === tab ? `[${label}]` : ` ${label} `;
        this.tabRanges.push({ tab, start: tabColumn, end: tabColumn + shown.length });
        tabColumn += shown.length + 1;
        return this.detailTab === tab
          ? theme.bold(theme.fg("accent", shown))
          : theme.fg("muted", shown);
      })
      .join(" ");
    this.scopeRanges = [];
    let scopeColumn = 0;
    const scopeLines: string[] = [""];
    const state = entry
      ? (["session", "project", "global"] as const)
          .map((scope) => {
            const value =
              scope === "session"
                ? entry.selected
                : scope === "global"
                  ? entry.globalDefaultSelected
                  : this.options.defaultsInherited
                    ? entry.globalDefaultSelected
                    : entry.defaultSelected;
            const inherited = scope === "project" && this.options.defaultsInherited;
            const label = `${scope[0].toUpperCase() + scope.slice(1)}: ${scope === "session" && entry.badge === "partial" ? "PARTIAL" : value === undefined ? "—" : value ? "ON " : "OFF"}${inherited ? " ↳ global" : ""}`;
            const enabled =
              entry.toggleable !== false &&
              (scope === "session" ||
                (this.options.setDefault &&
                  entry.defaultable !== false &&
                  value !== undefined &&
                  (scope !== "global" || entry.globalDefaultable !== false)));
            const shown = enabled ? `[${label}]` : label;
            if (scopeColumn && scopeColumn + shown.length > Math.max(1, right - 4)) {
              scopeLines.push("");
              scopeColumn = 0;
            }
            if (enabled)
              this.scopeRanges.push({
                scope,
                row: scopeLines.length - 1,
                start: scopeColumn,
                end: scopeColumn + shown.length,
              });
            scopeColumn += shown.length + 2;
            const styled = theme.fg(enabled ? (value ? "success" : "text") : "muted", shown);
            scopeLines[scopeLines.length - 1] += styled + "  ";
            return styled;
          })
          .join("  ")
      : "No matching resource";
    const stateLines = entry
      ? scopeLines.map((line) => truncateToWidth(line.trimEnd(), Math.max(1, right - 4)))
      : [state];
    const pinned = [" " + tabLine, ...stateLines.map((line) => " " + line)];
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
            ? "Project-only: cannot save as a personal default."
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
    const detailBody = [
      ...pinned,
      ...detailLines
        .slice(this.detailOffset, this.detailOffset + contentRows)
        .map((line) => " " + line),
    ];
    const listBox = box(
      `${this.options.title} · ${selected} selected · ${this.results.length}/${this.options.entries.length} shown`,
      rows,
      left,
      listRows,
      this.pane !== "preview",
    );
    const previewBox = box(
      `${entry?.name ?? "Details"} · ${this.detailOffset + 1}–${Math.min(detailLines.length, this.detailOffset + contentRows)}/${detailLines.length}`,
      detailBody,
      right,
      previewRows,
      this.pane === "preview",
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
    lines.push(truncateToWidth(theme.fg(this.error ? "error" : "muted", this.status), width));
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          "/ search · hjkl/Arrows navigate · Enter/Space toggle · Tab pane · Esc back/close",
        ),
        width,
      ),
    );
    if (this.options.setDefault)
      lines.push(
        truncateToWidth(
          theme.fg("dim", "Click Session / Project / Global, or use s / p / g outside search"),
          width,
        ),
      );
    if (this.options.saveDefaults || this.options.saveGlobalDefaults)
      lines.push(
        truncateToWidth(
          theme.fg(
            "dim",
            [
              this.options.saveDefaults
                ? `Ctrl+S ${this.options.defaultsScope === "project" ? "project defaults" : "defaults"}`
                : undefined,
              this.options.saveGlobalDefaults ? "Ctrl+Shift+S personal defaults" : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          width,
        ),
      );
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
      const globalEntries = options.entries.filter(
        (entry) =>
          entry.defaultable !== false &&
          entry.globalDefaultable !== false &&
          entry.toggleable !== false,
      );
      await options.saveGlobalDefaults(globalEntries);
      ctx.ui.notify("Personal defaults saved for new sessions across projects.", "info");
      continue;
    }
    if (
      options.saveDefaults &&
      chosen ===
        (options.defaultsScope === "project"
          ? "Save project defaults"
          : "Save selected as defaults")
    ) {
      const defaultable = options.entries.filter(
        (entry) => entry.defaultable !== false && entry.toggleable !== false,
      );
      await options.saveDefaults?.(defaultable);
      const skipped = options.entries.filter(
        (entry) => entry.selected && (entry.defaultable === false || entry.toggleable === false),
      ).length;
      if (skipped)
        ctx.ui.notify(
          `${skipped} selected project-only or fixed choice${skipped === 1 ? " was" : "s were"} not saved as defaults.`,
          "info",
        );
      continue;
    }
    const entry = options.entries[labels.indexOf(chosen)];
    if (!entry || entry.toggleable === false) continue;
    await options.toggle(entry, !entry.selected);
    entry.selected = !entry.selected;
    changed = true;
  }
}
