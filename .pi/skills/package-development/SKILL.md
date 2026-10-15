---
name: package-development
description: Implement or change a package in this Pi workspace, including its native manifest, lifecycle, dependencies and installed-consumer checks.
---

# Develop a Pi package

Read the repository `AGENTS.md`, the affected package README and manifest, and its callers.
Use existing implementations and the pinned Pi SDK docs/types before introducing code.

## Choose the mechanism

Use `AGENTS.md` for project context, a skill for task instructions and supporting scripts,
a prompt template for a reusable user prompt, and a theme for colours. Use an extension when
behaviour needs tools, commands, events or UI. A native Pi package distributes these resources;
it is not another runtime mode. Use [package decisions](../../../docs/package-design.md) for
our additional `pi.agents` and `pi.instructions` fields and their discovery limits.

## Make the change

Follow the smallest complete path through callers, exports, manifests, tests and docs. Keep each
package independently loadable; libraries declare dependencies without activating extensions.
Name packages for their contents and distinguish extension entrypoints from imported libraries.
Keep permission checks separate from OS confinement and resource selection separate from code
loading. Preserve cancellation, shutdown, resume and accounting behaviour where affected.
Record a consequential architectural choice in `docs/decisions/` only when its reasoning is not
already documented. Include the alternative rejected and the practical tradeoff.

## Verify the claim

Run affected tests and typechecks using existing package scripts. Run `npm run check` from
the public repository root; personal packages use the stock-Pi checks in their own READMEs.
Use [the testing guide](../../../docs/testing.md) to choose stock-Pi lifecycle/accounting tests,
relevant kernel checks for confinement changes, or `npm run test:packages` for manifest, name,
export or distribution changes. Inspect terminal captures when changing UI rendering.
Run `npm run check:docs` and `npm run check:boundary` for documentation/public-content changes.
Report what the checks establish and what remains untested. Source preparation does not activate
an installed harness or prove live-model quality.
