# One native package path

## Decision

Use stock Pi plus packages that each load on their own. Remove the OS sandbox, the custom launcher,
copied credentials, the second skill loader and readers for old settings formats. Keep a small
optional permission package with no sandbox.

Before this, launching an agent, running plain Bash and searching all depended on the sandbox's
policy and transport code. An earlier attempt at thin packages still imported that code and
repeated Pi's own resource and login handling. Renaming it did not remove the dependency.

## What stayed, and why

| Code | Why |
|---|---|
| `pi.agents` and `pi.instructions` reader | Pi has no resource types for these |
| Child RPC adapter and message broker | Named child sessions and matched answers are new behaviour |
| Child tool, skill and model setup | A child needs an explicit setup, including private skills |
| Shared process manager | Background output, cancellation and cleanup per session |
| Session selection records | Choices must survive resume without changing saved defaults |
| Goal state machine and evaluator | Objectives, budgets, waits and continuation are new behaviour |
| Usage records | Otherwise child, classifier and evaluator calls are missing from totals |
| File collection | Scratch files must outlive the child |
| Optional permission package | Deny and allow rules and automatic approval are useful without a sandbox |

Pi's package resolution decides what is found, and no other loader brings back excluded skills.
Each process logs in through Pi. Model settings can cross the RPC boundary, but provider callbacks
need an extension the child can load. There is one launcher.

The permission package adds its own start-up data to children through a small launch event, so
delegation needs no knowledge of permissions. Your messages are passed separately from the task the
parent agent writes.

Personal code lives in ordinary private packages. Patches to Pi's core UI classes are gone; Pi's
header, footer and tool rendering APIs replace them. Matching an old private layout exactly is not
a reason to keep another loader.

## Rejected

- Keeping the sandbox as a library: importing it still pulls in its dependencies and policy types.
- A second package registry: repeats Pi's installation, filtering and identity.
- Passing resolved login credentials to children: repeats Pi's refresh and locking and limits
  which providers work.
- Readers for old settings: they keep old behaviour alive forever. Convert saved settings once
  during local migration, keep transcripts and files, then use one format.

## Verification

Test each package on stock Pi, then pack it and install it in a fresh project. Exercise child
tools, private skills, model choice, permissions, accounting, goals and resume. Local activation
must use the same agent directory and confirm no old package or loader is still active. Publishing
to npm was not part of this change.

See [package design](../package-design.md), [testing](../testing.md),
[permissions](../../packages/pi-permissions/README.md) and Pi's
[package docs](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/packages.md).
