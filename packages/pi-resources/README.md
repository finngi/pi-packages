# pi-resources

Select skills and package guidance for a Pi session without loading delegation, background jobs
or security. This extension provides `/skills`, `/packages` and the shared `session_setup` tool.
It reuses Pi's loaded resources and the existing searchable resource browser.

- `/skills` selects which available skill descriptions enter the parent prompt. Bodies stay lazy;
  unselected `/skill:name` commands are refused.
- `/packages` groups available public skills, agents and instructions by their native package.
  Agent members require `pi-delegation`; instruction members require `pi-context`. Those packages
  are optional and are never activated by opening this picker.
- Changes apply to this session and survive resume. Ctrl+S saves project defaults;
  Ctrl+Shift+S saves personal defaults for future sessions. Project defaults take precedence.
  Saves affect only resource kinds supplied by loaded extensions; other defaults are preserved.

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
