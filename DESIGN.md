# Design principles

Build small native Pi packages that remain useful independently. Reuse Pi's model access,
authentication, resource loading, tools, sessions and UI before adding another mechanism.

- Start with a complete thin slice. Keep only the code needed for a real workflow.
- Give each capability an explicit entrypoint and declared dependencies. Importing a library
  must not activate another extension, create a process or change permissions.
- Keep executable extensions, resource content and personal preferences distinct. Package paths
  are relative to the package, not a particular user's checkout or home directory.
- Treat security as optional. Ordinary host access is explicit when it is absent; an explicitly
  selected security mechanism must fail clearly rather than silently dropping enforcement.
- Keep child agents and background jobs independently usable. Reuse process/RPC code as library
  code; each owner handles its own cancellation, bounded output and shutdown.
- Preserve recorded session data. Use native entries for state and native accounting before
  adding a second store. Distinguish missing accounting from task completion.
- Prefer existing components and standard libraries. Add shared abstractions only when concrete
  callers need them. Keep configuration smaller than the behaviour it controls.
- Test meaningful effects and boundaries, including independently packed consumers and stock Pi.
  A source import or green fixture is not evidence of deployment or live model quality.
- Document decisions, known limits and the observable behaviour a user can rely on.

These principles apply to the public packages and to personal packages developed alongside them.
This file is included in the public repository so independent contributors do not need a private
parent workspace to understand them.
