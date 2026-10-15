# Load local context

Load `pi-context` for personal project context and selected agent instructions. `AGENTS.md`, `CLAUDE.md` and `AGENTS.local.md` remain in Pi's native `<project_context>` section. Selected snippets appear separately in `<instructions>` and can guide communication, delegation, coding or data handling. These labels identify the sources' roles; they do not establish a priority rule between them. Pi's project-trust state controls whether this extension reads project-local sources and whether `/instructions` can save project choices.

Declare instruction directories in a native package's `pi.instructions` field and load that package
through personal or trusted project settings. Select resource IDs through `/instructions` or
`session_setup`. Sparse boolean maps save explicit personal/project choices; omitted IDs inherit.
Session choices are recorded and retained on resume. Bodies refresh before each parent turn.

When no selection is configured, `.agents/instructions/*.md` files in the trusted project are selected in filename order. Selecting a snippet loads its body eagerly as agent guidance; skills remain lazy. Leading closed YAML frontmatter is removed from eager prompt context, including team, local, and ancestor entries. Source files and raw read/grep/edit output are unchanged.

## Add personal or selected instructions

Load the entrypoint explicitly:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-extensions -e packages/pi-context/extensions/context.ts
```

Create `AGENTS.local.md` beside a project's `AGENTS.md` or `CLAUDE.md`. The walk runs from the filesystem root to the working directory. Within each directory, Pi's context file comes first, then the local file. Agent-directory context outside that walk stays first. Selected project snippets follow directory walk and filename order in the separate `<instructions>` section, followed by selected catalogue snippets.

Added files are deduplicated by canonical path across native context, local overlays, selected project snippets, and selected catalogue entries. The first loaded source keeps its content; existing host-supplied entries are preserved. Distinct files with identical text remain separate instructions. Nested worktree shadowing follows Pi's context-file walk. Other loaded entries keep their source paths. Unreadable additions are skipped; unreadable local files produce a UI warning.

The `/instructions` picker keeps its list to names, selection marks and default badges. Project-local entries carry a short `Project` label; reusable entries come from your instruction library. The details pane shows the behavioral body, selection storage and full source path. A project settings override chooses the set to use there; it does not make the snippets project rules or give their contents higher priority. An empty selection leaves `AGENTS.local.md` active.

Local overlays and selected snippet bodies are read again before the next parent turn, so editing them does not require a process restart. Children receive a launch-time snapshot of both project context and selected instructions; already-running children retain that snapshot. Dynamic parent sections, including running agents and goal state, are not copied.

The eager overlay reads local and selected files only when their resolved paths stay within the source root: the enclosing Git checkout when one exists, otherwise the directory that supplied the file. Symlinks within that root remain supported and are deduplicated by their canonical path; links outside it are skipped. Files with multiple hard links are also skipped, because their other paths cannot be confined. These path checks apply to files added by this extension, not to Pi's own context-file loading or to file access by tools and other extensions. Project trust is Pi's separate gate for loading the project-local overlay and changing project instruction selections.

Leading closed YAML frontmatter is removed from every eager context entry, including global/team files and a closed block with malformed YAML. Delimiters must be standalone `---` lines; prose beginning with `---text` and unclosed blocks stay intact. The child snapshot follows the same rule. HTML body comments remain. Pi's lazy skill catalogue and loading keep their default behavior; skill bodies are not inserted eagerly.

## Discover Pi help

The package supplies the optional `pi-help` skill using Pi's ordinary skill catalogue. Its body is
loaded only when the model chooses it or the user invokes it. The context extension replaces Pi's
default documentation catalogue with a one-line skill or SDK-directory pointer. Custom system
prompts and explicit caller documentation-section overrides are preserved. See [prompt context](prompts.md#select-optional-skills).

## Disable the overlay

`-nc` or `--no-context-files` disables local overlays and selected snippet contributions. For SDK embedding, the separate resource-loader `noContextFiles` option is not visible to this extension: also pass `--no-context-files` in the host arguments to disable the overlay. Caller-supplied custom sections are preserved. Metadata stripping still applies to eager entries supplied by the host.

## Keep personal files out of Git

The optional user agent directory setting is:

```json
{ "localContext": { "autoGitIgnore": true } }
```

It defaults to false. When enabled, session startup can append `AGENTS.local.md` to the owning repository's personal `.git/info/exclude`, preserving existing text. Linked worktrees use the verified common exclude. It does not edit `.gitignore` or tracked local files.

Writes require saved trust for each owning repository and current project trust. Children marked `PI_SUBAGENT`, `-na`/`--no-approve`, and context-disable arguments do not write. Exclude targets must be owned regular files; symlinks, hardlinks, FIFOs, arbitrary Git pointers, and unregistered worktree redirects are refused silently. Git subprocesses disable hooks and fsmonitor and remove inherited routing. These checks protect normal metadata; they do not isolate a race with a concurrent process holding the same host privileges.

Implementation and checks: [overlay](../../packages/pi-context/lib/local-context.ts), [metadata stripping](../../packages/pi-context/lib/frontmatter.ts), [exclude validation](../../packages/pi-context/lib/local-ignore.ts), and [Pi 1.2.0 SDK acceptance](../../packages/pi-context/context-check.mjs).
