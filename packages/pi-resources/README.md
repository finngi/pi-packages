# pi-resources

Choose which skills and packages a Pi session can use, without loading delegation, background
jobs or permissions. It adds `/skills`, `/packages` and the shared `session_setup` tool, using
Pi's loaded resources and the shared resource browser.

- `/skills` chooses which skill descriptions the parent's prompt lists. Skill bodies still load on
  demand, and `/skill:name` is refused for skills that are off.
- `/packages` makes package resources available or hides them. It does not select their skills,
  agents or instructions. Those choices stay independent, and return when a disabled package is
  enabled again. Packages with only extensions are not listed: availability never changes which
  extension code loads. Agents need `pi-delegation` and instructions need `pi-context`. Opening
  the picker loads neither.

## Saving choices

Session, Project and Global each show their own Inherit, On or Off choice. The most specific
explicit choice wins; Inherit follows the broader scope, ending at Pi's default. Turning a skill
off for this session leaves its project and global choices intact. The picker shows the effective
choice and where it came from separately.

Project and Global also offer a session type: **Any session**, **Interactive only** or
**Type: Inherit**. Interactive means Pi's TUI; RPC (even with dialogs), print mode and delegated
children are excluded. Session type does not turn a resource on or off. A project type overrides
the global one. Session has no type of its own.

Ctrl+S copies eligible current On/Off selections to project defaults; Ctrl+Shift+S copies them to
personal defaults. Bulk saves leave session types alone. Changing a single scope control only
writes that resource at that scope. Editing defaults here rereads them for this session without
replacing its explicit overrides. Other running sessions keep their current defaults.

`/skills enable NAME` and `/skills disable NAME` set one skill's session choice, like the picker;
other skills keep inheriting. `/skills all` and `/skills none` turn every listed skill on or off
for this session, and `/skills inherit` clears this session's skill choices.

Leaving and resuming a session rereads saved defaults. Explicit session choices stay; inherited
choices follow the current defaults. Resuming never reloads executable extensions or stops
children. New package registrations and native skill paths still need Pi's idle `/reload` or a
new invocation.

If a saved choice or session type is not valid (for example an old list instead of an ID map), that
category uses Pi's defaults and Pi shows a warning; `session_setup` also returns it. Other
categories and the active tools are unaffected. In an RPC or print session, `session_setup apply`
names any requested interactive-only resources it leaves out.

Older session records contain complete selection snapshots rather than per-item overrides. Those
snapshots stay explicit so an upgrade cannot guess which choices you meant to keep. Choose Inherit
for a row, or reset that category with `session_setup`, to follow saved defaults again.

A grey Global control means the resource only exists in this project or this `-e` run. The reason
shows in Overview and when you use the control. To make a package available in every project,
register its source in personal settings with Pi and include the resource in any package filters.
Saving defaults does not register sources. Package availability is saved separately in
`resourcePackages`; it never rewrites individual resource defaults or the native source list.

## Picking is not installing

`pi install SOURCE` saves a personal package source, `pi install --local SOURCE` a project one,
and `pi -e SOURCE` tries a package for one run. Those are Pi commands. This extension never
installs packages, unloads code, changes permissions or restarts children. See
[package design](../../docs/package-design.md).

`pi-delegation` owns `/agents` and child sessions; `pi-context` owns `/instructions` and adds
snippets to the prompt. All three share one `session_setup` service and session record format.
Without `pi-resources`, Pi loads skills as usual and delegation's skill rules still work. Children
get their launcher's explicit skills and never run a picker.

When you resume a session with recorded skill choices, load `pi-resources` again. Resources from
missing packages do not appear; their recorded overrides remain available if the resources return.

## Library APIs

Other extensions can import these without turning on `/skills`, `/packages` or parent skill
filtering:

| Import | Provides |
| --- | --- |
| `pi-resources/discovery` | Resolved package resources and agent and instruction descriptors |
| `pi-resources/selection` | Saved personal and project selections and saving |
| `pi-resources/session-setup` | The shared session selection service, installed by calling a function |
| `pi-resources/instructions` | Requests saved instruction text from the loaded context extension |
| `pi-resources/picker` | Shared scope controls for skills, agents, instructions and package groups |

The package's default entrypoint is the extension, and the library subpaths never import it.
Delegation and context use these APIs but still load on their own; each installs the session setup
service it needs. Pi still owns installation, trust and filters. No import scans a new catalogue,
loads another extension or writes settings.

## Tests

```sh
npm run test --workspace=pi-resources
npm run typecheck --workspace=pi-resources
```

Stock-Pi tests cover each extension on its own, both loading orders and resumed choices.
Entrypoint: [resources.ts](extensions/resources.ts).
