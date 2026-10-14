# pi-local-context

Personal project context and selected agent instructions for Pi. Each directory's `AGENTS.local.md` follows its `AGENTS.md` or `CLAUDE.md` inside native project context. Selected snippets shape agent behavior in a separate `<instructions>` section; the labels do not establish precedence. Project-local context and `/instructions` project selection require Pi to mark the project trusted. The picker changes session choices only. Ctrl+S saves project defaults to `.pi/settings.json`; Ctrl+Shift+S saves personal defaults for new sessions across projects, excluding project-only resources. Recorded session choices survive resume and branch navigation. Native packages declare instruction directories in `pi.instructions`; `localContext.instructions` selects personal defaults and can be overridden per project, including with an explicit empty list. Explicit standalone paths in `resources.instructionCatalogues` remain supported, but are not required for package resources. Leading closed YAML frontmatter is stripped from eager prompt entries. Source files, read output, HTML body comments, and lazy skill loading are unchanged.

- [Load local context](../../docs/guides/context.md): overlay order, disabling, and optional personal Git excludes.
- [Prompt context](../../docs/guides/prompts.md): concise Pi-help discovery and lazy skill loading.
- [Settings reference](../../docs/reference/configuration.md#local-context-settings).
- [SDK embedding](../../docs/guides/distribution.md#embed-with-the-pi-110-sdk): the overlay's argv-based disable requirement.

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

Source entrypoint: [extensions/context.ts](extensions/context.ts). From the repository root, run `npm run test --workspace=pi-local-context`, `npm run typecheck --workspace=pi-local-context`, and `npm run test:e2e --workspace=pi-local-context`. The integration fixture exercises Pi 1.2.0 prompt/reload and Git metadata with isolated resources and no model calls.

This extension provides `/instructions` and the `session_setup` tool on stock Pi without agents, background jobs or security.

Native [resource packages](../pi-runtime/README.md) contribute opt-in instruction snippets to
`/instructions` through the same catalogue IDs and selection settings. Pack metadata augments
picker search; selected body text renders in `<instructions>` with the file's source path.
