# Documentation

Start with [getting started](getting-started.md) to build the packages and launch Pi from this checkout. For the process model and the meaning of workspace, extension, and library, read [architecture](architecture.md).

## Task guides

| Task | Guide |
| --- | --- |
| Select and review a confined session | [Configure security](guides/security.md) |
| Define an agent, delegate work, and retain files | [Delegate work](guides/delegation.md) |
| Run shell jobs and hand foreground work to the background | [Manage processes](guides/background-processes.md) |
| Start a goal and manage evaluation and continuation | [Manage goals](guides/goals.md) |
| Customize prompts, tools, and optional skills | [Configure prompt context](guides/prompts.md) |
| Add personal and selected instructions | [Load local context](guides/context.md) |
| Load from Git, pack tarballs, or embed with the SDK | [Install and distribute](guides/distribution.md) |
| Keep personal models, policies and styling local | [Local profiles](guides/local-profiles.md) |
| Check a contribution | [Testing](testing.md) |

## Concepts

- [Architecture](architecture.md): where code executes, how processes communicate, and where confinement applies.
- [Usage and cost accounting](accounting.md): recorded provider usage, result delivery, estimates, and unknown usage.

## Reference

| Reference | Contents |
| --- | --- |
| [Packages](reference/packages.md) | Responsibilities, dependencies, entrypoints, SDK pins, and licences |
| [Tools and commands](reference/tools.md) | Parameters, returned values, and limits |
| [Configuration](reference/configuration.md) | Security selection, policy paths, agent metadata, and context settings |
| [Security policy](reference/security-policy.md) | Policy schema, host executables and enforcement |
| [Goals](reference/goals.md) | Authorization, assessment roles, provider accounting, persisted state, and waits |
| [Events and delivery](reference/events.md) | In-process services, RPC frames, session records, and response ownership |
| [Semantic IDs](semantic-ids.md) | Format, vocabulary, collision behavior, and tokenizer evidence |
| [Pi API reuse](reference/pi-api-reuse.md) | Supported SDK APIs and the ownership boundaries implemented by these extensions |

See [publication preparation](publication.md) for the clean source boundary and private-history separation.
