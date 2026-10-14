# pi-resource-browser

A searchable resource picker built with Pi's TUI components. `pi-subagents` uses it for agents, skills and
package guidance; `pi-local-context` uses it for instruction snippets. The host extension supplies entries,
previews and persistence callbacks. The library registers no tools or event handlers on import.

`showResourceBrowser(context, options)` mounts the picker in Pi's editor slot. `ResourceBrowser`
provides the component for custom compositions. Each entry has an internal `id`, a displayed `name`
and `description`, selected/default state and an asynchronous preview. Enter or Space in the list toggles a
selection; `selectionScope` defaults to `project` and can be `session`. `defaultsScope` can be
`project` to label an explicit project save; the default retains personal-default wording. Ctrl+S calls the host's optional `saveDefaults` callback with only entries that
can be defaulted (`defaultable` and `toggleable` are not false). Ctrl+Shift+S invokes the optional `saveGlobalDefaults` callback, additionally excluding `globalDefaultable: false` entries. Fixed or ineligible selections
stay selected at their current scope and are excluded from saved defaults. RPC clients use Pi's native
choice dialog.

See the [package reference](../../docs/reference/packages.md), [context guide](../../docs/guides/context.md)
and [resource settings](../../docs/reference/configuration.md#project-resource-selection). Build with
`npm run build --workspace=pi-resource-browser`; the distributed entrypoint contains JavaScript and
TypeScript declarations. The host must supply compatible Pi coding-agent and TUI peers.

The list shows session checkboxes without package-path badges. Its border holds the category and
selection count. The preview keeps session/default state visible above three tabs: **Overview**
for read-only metadata, **Instructions** for the instructions, and **Source** for provenance. Click a tab,
or use h/l (Left/Right) to enter the preview and move through its tabs. j/k (Up/Down) navigate the list or scroll the preview. `/` or a search-field click focuses search; Enter/Escape returns to navigation without toggling. Query text, including hjkl and numbers, stays literal while search is focused.
Toggling an item off changes only the current session until another explicit default save.

Hosts can return `ResourcePreview` with `fields`, `body` and `source` instead of mixing
metadata into instruction prose. `defaultsInherited` distinguishes an absent project override from
an explicit saved list; a successful project save clears that flag. String previews remain supported.

The preview exposes `searchFocused` so a composing screen can reserve number shortcuts outside search.
Hosts may supply `globalDefaultSelected` and `setDefault(entry, selected, scope)` for per-resource
Project/Global controls. This callback must change only that saved item using the host's existing
persistence mechanism, preserving unrelated defaults. Turning a project default on also calls
the session toggle to enable the same item now; turning it off leaves the current session choice
unchanged. Global changes apply to future defaults without changing the session. Missing callbacks or unknown
saved state render as read-only; the browser never invents global state from session selections.
The standalone preview supplies in-memory callbacks; production hosts retain their existing bulk saves.

Composing hosts can provide `categories`, `activeCategory` and `selectCategory` to put numbered,
clickable tabs in the outer frame. The active label uses the native theme accent; inactive labels
use its muted border colour. Category shortcuts are inactive while the search field has focus.
Search focus highlights its row and displays a SEARCH ACTIVE indicator. ON/OFF labels occupy
the same number of terminal cells so adjacent scope controls retain their positions.

The native Input `placeholderStyle` uses the theme's dim foreground. Scope keys s/p/g work
from either pane whenever search is unfocused; inside search they remain ordinary query text.
