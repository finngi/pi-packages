# pi-context

Adds personal and selected instructions to Pi's prompt, without delegation, jobs or permissions.

- **`AGENTS.local.md`**: in each directory, this file comes right after `AGENTS.md` or `CLAUDE.md`
  in Pi's context order. Use it for notes you do not commit.
- **`/instructions`**: pick instruction snippets for this session. They go in a separate
  `<instructions>` section. The section name does not change their priority.
- **`session_setup`**: lets the model select snippets too.

Project files are read, and project choices saved, only in a project Pi trusts.

## Choosing snippets

Packages declare snippet folders in `pi.instructions`. A project's `.agents/instructions/*.md`
files are also available, and package names, descriptions and keywords help search. Discovery,
saved selection and session setup come from `pi-resources` library subpaths; importing them does
not load the resources extension or turn on `/skills` and `/packages`. Picker changes apply to this session; Ctrl+S saves project defaults in
`.pi/settings.json` and Ctrl+Shift+S saves personal defaults for new sessions, without project-only
snippets. Resume and branch navigation restore the session's choices.

Saved choices (`localContext.instructions`) map snippet IDs to `true` or `false`. A missing project
ID follows the personal choice; a missing personal ID uses the default. IDs that are no longer
available are ignored. Personal snippet libraries should be packages, not a separate folder. A
leading YAML front-matter block is removed before text reaches the prompt.

Children get saved personal and project choices and the static project context at launch, plus
their own agent body. Choices made only for the parent's session stay with the parent.

## Which files are read

`AGENTS.local.md` files are read through symlinks only if the real file stays inside the nearest
Git repository or worktree. Without Git, the file's own directory is the limit, and a home-level
file uses the home directory. Project snippets in `.agents/instructions` come only from directories
inside the Git root (or the working directory, without Git); the home directory is always skipped.
Symlinks inside the limit work and are de-duplicated by real path.
Files with more than one hard link are skipped, because their other names cannot be checked. These
checks only limit what this extension reads. Neither they nor project trust stop tools or other
extensions from reading files.

## Pi help

The package includes an on-demand `pi-help` skill. The extension shortens Pi's default
documentation section to one line, keeping custom prompts and explicit overrides.

## More

- [Local context](../../docs/guides/context.md): file order, turning it off, and optional Git excludes.
- [Prompt context](../../docs/guides/prompts.md): `pi-help` and on-demand skills.
- [Settings](../../docs/reference/configuration.md#local-context-settings).
- [SDK embedding](../../docs/guides/distribution.md#embed-with-the-pi-120-sdk): why you must pass
  `--no-context-files` in the arguments.

## Tests

From the repository root:

```sh
npm run test --workspace=pi-context
npm run typecheck --workspace=pi-context
npm run test:e2e --workspace=pi-context
```

The integration test runs Pi 1.2.0 prompt and reload and real Git metadata with isolated resources
and no model calls. Entrypoint: [extensions/context.ts](extensions/context.ts).
