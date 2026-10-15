# pi-resources

Choose which skills and package guidance a Pi session uses, without loading delegation, background
jobs or permissions. It adds `/skills`, `/packages` and the shared `session_setup` tool, using
Pi's loaded resources and the shared resource browser.

- `/skills` chooses which skill descriptions the parent's prompt lists. Skill bodies still load on
  demand, and `/skill:name` is refused for skills that are off.
- `/packages` groups public skills, agents and instructions by package. Agents need
  `pi-delegation` and instructions need `pi-context`. Both are optional, and opening the picker
  never loads them.

## Saving choices

Session, Project and Global each show their own Inherit, On or Off choice. The most specific
explicit choice wins; Inherit follows the broader scope, ending at Pi's default. Turning a skill
off for this session leaves its project and global choices intact. The picker shows the effective
choice and where it came from separately.

Each scope also offers **Any session**, **Interactive only** or **Type: Inherit**. Interactive
means Pi's TUI; RPC (even with dialogs), print mode and delegated children are excluded. Session
type does not turn a resource on or off. Project and session types can override a broader type.

Ctrl+S copies eligible current selections and session types to project defaults; Ctrl+Shift+S
copies them to personal defaults. These bulk saves are explicit; changing a single scope control
only writes that resource at that scope. Editing defaults here refreshes this session without
replacing its explicit overrides. Other running sessions keep their current defaults.

`/refresh` rereads saved defaults and metadata for Pi's already-loaded resources. Leaving and
resuming a session does the same. Both preserve explicit session choices and session types;
inherited choices follow the refreshed defaults. Neither reloads executable extensions or stops
children. New package registrations and native skill paths still need Pi's idle `/reload` or a
new invocation.

Older session records contain complete selection snapshots rather than per-item overrides. Those
snapshots stay explicit so an upgrade cannot guess which choices you meant to keep. Choose Inherit
for a row, or reset that category with `session_setup`, to follow refreshed defaults again.

A grey Global control means the resource only exists in this project or this `-e` run. The reason
shows in Overview and when you use the control. To make a package available in every project,
register its source in personal settings with Pi and include the resource in any package filters.
Saving defaults does not register sources.

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
