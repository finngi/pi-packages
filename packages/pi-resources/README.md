# pi-resources

Select skills and package guidance for a Pi session without loading delegation, background jobs
or permissions. This extension provides `/skills`, `/packages` and the shared `session_setup` tool.
It reuses Pi's loaded resources and the existing searchable resource browser.

- `/skills` selects which available skill descriptions enter the parent prompt. Bodies stay lazy;
  unselected `/skill:name` commands are refused.
- `/packages` groups available public skills, agents and instructions by their native package.
  Agent members require `pi-delegation`; instruction members require `pi-context`. Those packages
  are optional and are never activated by opening this picker.
- Changes apply to this session and survive resume. Ctrl+S saves project defaults;
  Ctrl+Shift+S saves personal defaults for future sessions. Project defaults take precedence.
  Saved Project and Global controls offer Inherit / On / Off. Project Inherit follows Global;
  Global Inherit follows Pi's native default. Changing one row preserves the other rows.
  Ctrl+S and Ctrl+Shift+S deliberately snapshot eligible session choices. Saves affect only
  resource kinds supplied by loaded extensions; other defaults are preserved.

A grey Global control means the resource is available only from this project or temporary
launch. Its reason appears in Overview and when the control is used. To make a temporary
package available in future projects, register its source in personal settings with native Pi
and include the resource in any package filters.
Saving defaults does not register sources.

This picker selects guidance. Native `pi install SOURCE` saves a personal package source;
`pi install --local SOURCE` saves a project source. `pi -e SOURCE` tries a package for one
invocation. These remain Pi operations: this extension does not install packages, unload code,
change permissions or restart children. See [package decisions](../../docs/package-design.md).

`pi-delegation` owns `/agents` and child execution. `pi-context` owns `/instructions` and prompt
injection. All three use one shared `session_setup` service and the existing session record format.
Without `pi-resources`, native Pi skill loading and delegation's skill inheritance work normally.
Children receive their launcher's explicit skills rather than running a second resource picker.

Source entrypoint: [resources.ts](extensions/resources.ts). Run
`npm run test --workspace=pi-resources` and `npm run typecheck --workspace=pi-resources`.
Stock-Pi checks cover independent providers, both loading orders and resumed selections.

When resuming recorded skill choices, load `pi-resources` again. If a required provider is
missing, setup names it and offers reset; it does not silently replace saved choices with defaults.

## Library APIs

Other extensions can import these modules without activating `/skills`, `/packages` or parent
skill filtering:

| Import | Responsibility |
| --- | --- |
| `pi-resources/discovery` | Native resolved package resources and custom agent/instruction descriptors |
| `pi-resources/selection` | Saved personal/project selections and explicit persistence |
| `pi-resources/session-setup` | Shared session selection service, installed by an explicit function call |
| `pi-resources/instructions` | Request saved instruction text from the loaded context provider |

The default package entrypoint is the extension. Library subpaths never import it. Delegation and
context depend on these library APIs but remain independently loadable: each explicitly installs
the session setup service it needs. Pi still owns package installation, trust and native filters.
No library import scans a new catalogue, loads another extension or writes settings.
