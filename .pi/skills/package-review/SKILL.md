---
name: package-review
description: Review a Pi package change for necessity, native Pi reuse, independent loading, lifecycle correctness and clear user-facing behaviour.
---

# Review a Pi package

Read the repository `AGENTS.md`, the requested diff, the affected package README/manifests and
relevant callers. Check claims against implementation and existing checks.

- Could repository code or native Pi provide the behaviour? Flag duplicate loaders, registries,
  model clients or state stores when a concrete simpler replacement exists.
- Do the package name, description and entrypoints match its contents? Verify declared dependencies
  and installed exports; an imported library must not implicitly activate another extension.
- Are resource selection, code loading and permissions described separately? Check who owns each
  effect and when it applies, including new children, running children, reload and session resume.
- For affected processes/state, trace cancellation, shutdown, stale handles and accounting replay.
  Permission approval is not OS confinement; explicitly selected security must not silently fail open.
- Does the user/model-facing text explain the actual action and remedy? Remove jargon, repetition,
  stale claims and personal-machine details while preserving important limits.
- Does verification exercise the claimed effect on stock Pi and, where distribution changed,
  an installed consumer? Inspect actual terminal captures for UI claims.

Use [package decisions](../../../docs/package-design.md),
[package responsibilities](../../../docs/reference/packages.md) and
[testing](../../../docs/testing.md) when relevant. Focus on systemic mistakes and actionable
simplifications; do not propose speculative frameworks or list cosmetic preferences as defects.
Give findings with a location, concrete consequence and smallest correction. Distinguish verified
findings from hypotheses and state material gaps. Say when no actionable finding was established.
