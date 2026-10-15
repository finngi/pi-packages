# pi-context

Loads project context and selected instructions. Each directory's `AGENTS.local.md` follows
its `AGENTS.md` or `CLAUDE.md` in Pi's context order. Selected snippets enter a separate
`<instructions>` section; its label does not set instruction priority. Project context and
project-level `/instructions` changes require a trusted project.

Picker changes apply to this session. Ctrl+S saves project defaults to `.pi/settings.json`;
Ctrl+Shift+S saves personal defaults for new sessions, excluding project-only resources.
Resume and branch navigation restore recorded choices.

Children receive saved personal/project instruction defaults and static project context at launch.
Temporary parent session selections stay with the parent; each child's agent body is added separately.

Packages declare instruction directories in `pi.instructions`. `localContext.instructions`
sets personal defaults. Saved choices use ID-to-boolean maps: a missing project ID inherits
the personal choice, and a missing personal ID uses the local/native default.
Unavailable IDs in saved maps stay dormant and do not load instruction bodies.
Global instruction libraries are native packages, not a separate directory catalogue. A leading YAML header
with a closing delimiter is removed before selected text enters the prompt.

- [Load local context](../../docs/guides/context.md): overlay order, disabling, and optional personal Git excludes.
- [Prompt context](../../docs/guides/prompts.md): concise Pi-help discovery and lazy skill loading.
- [Settings reference](../../docs/reference/configuration.md#local-context-settings).
- [SDK embedding](../../docs/guides/distribution.md#embed-with-the-pi-120-sdk): the overlay's argv-based disable requirement.

Eager `AGENTS.local.md` and selected `.agents/instructions/*.md` reads follow symlinks only when
the resolved file stays within the nearest Git repository/worktree root. Without a Git root, the
source directory owns its boundary; home-level sources use the home directory. Internal symlinks
remain usable and are deduplicated by resolved path. Files with more than one hard link are skipped,
because path resolution cannot establish where their other names point. These path checks limit
which files the extension reads. Pi's project-trust state separately controls whether the project
overlay loads and whether `/instructions` can save project selections; neither mechanism isolates
the host process from tools or other extensions.

The package includes a lazy `pi-help` skill; the extension keeps Pi's default documentation section
to one line while preserving custom prompts and explicit section overrides.

Source entrypoint: [extensions/context.ts](extensions/context.ts). From the repository root, run `npm run test --workspace=pi-context`, `npm run typecheck --workspace=pi-context`, and `npm run test:e2e --workspace=pi-context`. The integration fixture exercises Pi 1.2.0 prompt/reload and Git metadata with isolated resources and no model calls.

This extension provides `/instructions` and the `session_setup` tool on stock Pi without delegation, background jobs or permissions.

[Resource packages](../pi-runtime/README.md) add available instructions to `/instructions`.
Package metadata helps search; selected text enters `<instructions>` with its source path.
