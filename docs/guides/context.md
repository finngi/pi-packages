# Load local context

`pi-context` adds two things to Pi's prompt:

- **Local files.** An `AGENTS.local.md` next to a project's `AGENTS.md` or `CLAUDE.md` is added to
  Pi's `<project_context>` section. Use it for personal notes you do not commit.
- **Selected instructions.** Snippets you choose with `/instructions` go in a separate
  `<instructions>` section. Use them for guidance on communication, delegation, coding or data
  handling.

The two section names say where text came from. They do not make one source outrank the other.
The extension only reads project files, and only saves project choices, in a project Pi trusts.

## Try it

Load the entrypoint:

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js \
  --no-extensions -e packages/pi-context/extensions/context.ts
```

Create `AGENTS.local.md` beside a project's `AGENTS.md` or `CLAUDE.md`. Pi walks from the
filesystem root down to the working directory. In each directory, Pi's context file comes first,
then the local file. Context from your agent directory, outside that walk, stays first.

## Where snippets come from

Packages declare instruction directories in their `pi.instructions` field. Load the package
through personal or project settings, then choose snippets with `/instructions` or
`session_setup`. If you have not chosen any, the trusted project's `.agents/instructions/*.md`
files are used, in file-name order.

Order in `<instructions>`: selected project snippets, in directory-walk and file-name order, then
selected package snippets.

Saved choices are maps from snippet ID to `true` or `false`; a missing ID inherits from the next
level. Explicit session choices come back on resume; inherited choices refresh from saved defaults.
`/refresh` does the same without leaving the session or stopping children. In the picker, Ctrl+S
saves project defaults and Ctrl+Shift+S saves personal defaults for new sessions.

A selected snippet's text goes into the prompt in full. Skills are different: only their
description is listed until the model reads them.

## The `/instructions` picker

The list shows names, selection marks and default badges. Project snippets have a short `Project`
label; others come from your instruction packages. The details pane shows the text, where the
choice is saved and the full source path. A project setting chooses which snippets apply there; it
does not turn them into project rules or raise their priority. Turning every snippet off still
leaves `AGENTS.local.md` active.

## What gets read and when

Local files and selected snippets are re-read before each parent turn, so edits apply without a
restart.

Files are de-duplicated by their real path across Pi's context files, local files, project
snippets and package snippets. The first copy wins, and entries supplied by the host are kept. Two
different files with the same text stay separate. Nested worktrees shadow each other the same way
Pi's context walk does. Files that cannot be read are skipped; an unreadable local file shows a
warning.

A file is only read if its real path stays inside its source root: the enclosing Git checkout, or
otherwise the directory it came from. A home-level `AGENTS.local.md` uses the home directory.
Project snippets are only taken from directories inside the Git root (or the working directory,
without Git), and never from the home directory. Symlinks inside the
root work and are de-duplicated by real path; links that leave it are skipped. Files with more than
one hard link are skipped, because their other names cannot be checked. These checks cover only
files this extension adds. They do not affect Pi's own context loading or what tools and other
extensions can read.

A leading YAML front-matter block is removed from every context entry before it reaches the
prompt, including global, team and ancestor files, and blocks with invalid YAML. The block must
open and close with a line that is exactly `---`. Text starting `---text` and unclosed blocks are
left alone. HTML comments stay. Source files and raw tool output are never changed.

## Child agents

Children get the parent's static context files and the instruction choices saved in personal and
project settings, followed by their own agent instructions. Choices the parent made only for its
current session are not passed on. Saved snippet text is read when the child launches; a running
child keeps that copy. Live parent sections, such as running agents and goal state, are not
copied. See [delegate work](delegation.md#assign-a-task).

## Pi help skill

The package includes an optional `pi-help` skill in Pi's normal skill list. Its text loads only
when the model picks it or you invoke it. The extension shortens Pi's default documentation
section to one line that points at the skill, or at the SDK docs directory. Custom system prompts
and explicit documentation-section overrides are kept. See
[prompt context](prompts.md#select-optional-skills).

## Turn it off

`-nc` or `--no-context-files` turns off local files and selected snippets. Extensions cannot see
the SDK resource loader's `noContextFiles` option, so when embedding Pi, also pass
`--no-context-files` in the host's arguments. Custom sections from the caller are kept.
Front-matter is still removed from entries the host supplies.

## Keep local files out of Git

In your user agent directory settings:

```json
{ "localContext": { "autoGitIgnore": true } }
```

This is off by default. When on, session start can add `AGENTS.local.md` to the repository's
personal `.git/info/exclude`, keeping what is already there. Linked worktrees use the shared
exclude file. It never edits `.gitignore` or tracked files.

It only writes when the repository and the current project are both trusted. It does not write in
child sessions (`PI_SUBAGENT`), with Pi's `-na`/`--no-approve`, or when context files are off. The
exclude file must be an ordinary file you own: symlinks, hard links, FIFOs, unusual Git pointers
and unregistered worktree redirects are skipped without a message. Git runs with hooks and
fsmonitor off and without inherited routing variables. These checks protect normal Git metadata;
they cannot stop another process running as you from racing the write.

Source and tests: [local files](../../packages/pi-context/lib/local-context.ts),
[front-matter removal](../../packages/pi-context/lib/frontmatter.ts),
[exclude checks](../../packages/pi-context/lib/local-ignore.ts) and
[Pi 1.2.0 SDK check](../../packages/pi-context/context-check.mjs).
