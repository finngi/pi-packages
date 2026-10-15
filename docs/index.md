# Documentation

New here? Start with [getting started](getting-started.md). For how the pieces fit together, read
[architecture](architecture.md).

## Guides

| I want to… | Guide |
| --- | --- |
| Understand the repository layout and which packages to load | [Development packages](guides/development-packages.md) |
| Check tool calls before they run | [Permissions](../packages/pi-permissions/README.md) |
| Define an agent, hand it work and keep its files | [Delegate work](guides/delegation.md) |
| Run shell commands in the background | [Run shell jobs](guides/background-processes.md) |
| Keep Pi working until a goal is met | [Goals](guides/goals.md) |
| Shape the system prompt, tools and skills | [Prompt context](guides/prompts.md) |
| Add personal and selected instructions | [Local context](guides/context.md) |
| Load from Git, build tarballs or embed with the SDK | [Install and distribute](guides/distribution.md) |
| Keep personal models, rules and styling out of these packages | [Local profiles](guides/local-profiles.md) |
| Test a change | [Testing](testing.md) |

## Concepts

- [Architecture](architecture.md): what runs where and how processes talk.
- [Package design](package-design.md): how packages are found, selected and loaded.
- [Usage and costs](accounting.md): how usage from children, classifiers and evaluators is counted.
- [Semantic IDs](semantic-ids.md): the readable IDs used for agents, jobs and other objects.

## Reference

| Page | Contents |
| --- | --- |
| [Packages](reference/packages.md) | What each package does, dependencies, versions, licences |
| [Tools and commands](reference/tools.md) | Parameters, results and limits |
| [Configuration](reference/configuration.md) | Settings, agent metadata, context and goal options |
| [Goals](reference/goals.md) | Goal approval, evaluation, budgets, saved state and waits |
| [Events and delivery](reference/events.md) | In-process services, RPC frames and session records |
| [Pi API reuse](reference/pi-api-reuse.md) | Which Pi APIs these packages build on |

[Decisions](decisions/native-thin-slices.md) record why things are built the way they are.
[Publication](publication.md) covers the public/private repository split.
