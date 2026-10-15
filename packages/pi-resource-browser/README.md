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

| Option | Meaning |
| --- | --- |
| `selectionScope` | `project` (default) or `session` |
| `defaultsScope` | `project` labels saves as project saves; otherwise saves are worded as personal defaults |
| `saveDefaults` | Called by Ctrl+S with entries that can be saved (`defaultable` and `toggleable` not false) |
| `saveGlobalDefaults` | Called by Ctrl+Shift+S, also leaving out `globalDefaultable: false` entries |
| `setDefault(entry, state, scope)` | Optional per-resource Project or Global control |
| `globalDefaultSelected` | Resolved personal default for each entry |
| `categories`, `activeCategory`, `selectCategory` | Numbered, clickable category tabs in the frame |

Fixed or ineligible entries stay selected at their current scope and are never saved as defaults.
RPC clients get Pi's choice dialog instead.

`setDefault` must change only that one saved item, using the host's existing saving code and
keeping other defaults. Turning a project default on also toggles the item on in the session;
turning it off leaves the session alone. Global changes affect future defaults, not the session. If
a saved control is unavailable, its reason shows in Overview and when you try to use it. The
browser never makes up global state from session choices. The standalone preview uses in-memory
callbacks; real hosts keep their bulk saves.

Previews can be a string, or a `ResourcePreview` with `fields`, `body` and `source` so metadata
stays out of the instruction text. `projectState` and `globalState` give the saved Inherit, On or
Off choice; `defaultSelected` and `globalDefaultSelected` give the resolved values and colours.
`defaultsInherited` is only a fallback for hosts without per-resource states. The preview exposes
`searchFocused` so a host can keep number shortcuts out of the search box.

## Layout and keys

The list shows session checkboxes, without package-path badges. Its border shows the category and
how many are selected. The preview keeps session and default state at the top, above three tabs:
**Overview** (metadata), **Instructions** and **Source**.

- Click a tab, or use h/l (Left/Right) to move into the preview and between tabs.
- j/k (Up/Down) move through the list or scroll the preview.
- `/` or clicking the search field focuses search. Enter or Escape goes back to the list without
  toggling. While searching, every key, including hjkl and numbers, is typed as text.
- s/p/g change scope from either pane when search is not focused.
- Category number keys are off while searching.

Turning an item off changes only this session until you save defaults. The active tab label uses
the theme's accent colour and inactive ones its muted border colour. Search focus highlights its
row and shows SEARCH ACTIVE. ON and OFF labels are the same width, so the controls next to them do
not move. The input placeholder uses the theme's dim foreground.

## Build

`npm run build --workspace=pi-resource-browser` builds JavaScript and type declarations. The host
must provide compatible Pi coding-agent and TUI peers. See [packages](../../docs/reference/packages.md),
the [context guide](../../docs/guides/context.md) and
[saved defaults](../../docs/reference/configuration.md#saved-defaults).
