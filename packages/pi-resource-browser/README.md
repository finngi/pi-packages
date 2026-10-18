# pi-resource-browser

A searchable resource picker built from Pi's TUI components. `pi-delegation` uses it for agents,
`pi-resources` for skills and packages, and `pi-context` for instruction snippets. The host
extension supplies the entries, previews and save callbacks. Importing the library registers no
tools or event handlers.

## API

`showResourceBrowser(context, options)` opens the picker in Pi's editor slot. `ResourceBrowser` is
the component itself, for custom layouts.

Each entry has an internal `id`, a shown `name` and `description`, selected and default state, and
an async preview. Enter or Space in the list toggles it.

Search uses Pi's own fuzzy matcher over each entry's name, description and `keywords`. Every
space-separated query word must match in order, so abbreviations such as `bh` find `build-helper`;
an empty query keeps the host's order. `ResourceSearch` from `pi-resource-browser/search` exposes
the same matching to hosts without the picker.

| Option | Meaning |
| --- | --- |
| `selectionScope` | `project` (default) or `session` |
| `defaultsScope` | `project` labels saves as project saves; otherwise saves are worded as personal defaults |
| `saveDefaults` | Called by Ctrl+S with entries that can be saved (`defaultable` and `toggleable` not false) |
| `saveGlobalDefaults` | Called by Ctrl+Shift+S, also leaving out `globalDefaultable: false` entries |
| `setDefault(entry, state, scope)` | Changes one Project or Global selection: `inherit`, `on` or `off` |
| `setSession(entry, state)` | Changes one Session selection, including removing its override with `inherit` |
| `setMode(entry, mode, scope)` | Changes only the Project or Global session type: `inherit`, `any` or `interactive` |
| `globalDefaultSelected` | Resolved personal default for each entry |
| `categories`, `activeCategory`, `selectCategory` | Numbered, clickable category tabs in the frame |

Fixed or ineligible entries stay selected at their current scope and are never saved as defaults.
RPC clients get Pi's choice dialog instead.

Each callback changes only the requested resource, scope and setting. A Project or Global
selection does not overwrite a Session override, and setting a session type does not select the
resource. The host refreshes each entry after saving; the browser does not compute inheritance.
Enter/Space remains a quick explicit Session On/Off toggle. The s/p/g menus also offer Inherit to
remove an override. The p/g menus add Any session, Interactive only and Type: Inherit when the host
supports session types; Session has no type. Interactive only means TUI sessions, excluding RPC and
print mode.

If a control is unavailable, its reason appears in Overview and when you try it. The browser never
makes up global state from session choices. Ctrl+S and Ctrl+Shift+S remain explicit bulk snapshots
of the current On/Off selection into project and global defaults; they do not write session types. A normal per-item edit never triggers
one of those snapshots.

Previews can be a string, or a `ResourcePreview` with `fields`, `body` and `source` so metadata
stays out of the instruction text. `sessionState`, `projectState` and `globalState` expose explicit
Inherit, On or Off choices. `selected` and `effectiveSource` expose the active result separately.
`projectMode` and `globalMode` expose explicit session-type choices; `mode` and
`modeSource` expose the resolved type. `defaultSelected` and `globalDefaultSelected` are resolved
saved values. Hosts that do not offer the new per-session callbacks can continue using boolean
session toggles. The preview exposes `searchFocused` so a host can keep shortcuts out of search.

## Layout and keys

The list shows active-session checkboxes and three scope columns:  Session,  Project and
 Global. Filled circles mean On, hollow circles Off, dots Inherit and half circles mixed package
members; a dash means unknown. These columns show each scope's stored choice, while the checkbox
shows the active result after inheritance and session-type filtering. Its border shows the category
and selection count. The adjacent pane has **Overview**, **Instructions** and **Source** tabs in its
top border, with the resource name on the right. Scope controls and the effective session type sit
above the content. Successful per-item edits update those controls without a repeated footer message;
save errors and bulk-save confirmations still appear below the panes.

- Click a tab, or use h/l (Left/Right) to move into the preview and between tabs.
- j/k (Up/Down) move through the list or scroll the preview.
- `/` or clicking the search field focuses search. Enter or Escape goes back to the list without
  toggling. While searching, every key, including hjkl and numbers, is typed as text.
- s/p/g open Session, Project or Global choices from either pane when search is not focused.
- Click a scope to open the same menu. Mouse-wheel events only scroll.
- Category number keys are off while searching.

Turning an item off in the list changes only this session until you explicitly save defaults. The active tab label uses
the theme's accent colour and inactive ones its muted border colour. Search focus highlights its
row and shows SEARCH ACTIVE. ON and OFF labels are the same width, so the controls next to them do
not move. The input placeholder uses the theme's dim foreground.

## Build

`npm run build --workspace=pi-resource-browser` builds JavaScript and type declarations. The host
must provide compatible Pi coding-agent and TUI peers. See [packages](../../docs/reference/packages.md),
the [context guide](../../docs/guides/context.md) and
[saved defaults](../../docs/reference/configuration.md#saved-defaults).
