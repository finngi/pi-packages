# pi-permissions

Decide which tool calls Pi may run: by rule, by asking you, or by asking a classifier model.
This is the equivalent of "auto mode" in other coding agents. It checks calls before they run;
it does not sandbox the processes it lets through.

## Install

```sh
pi install /absolute/path/to/packages/pi-permissions
```

Then add a `permissions` key to your personal settings, `~/.pi/agent/settings.json`:

```json
{
  "permissions": {
    "mode": "auto",
    "model": "openai-codex/gpt-6-luna",
    "allow": ["read", "grep", "find", "ls", "bash:git status", "bash:rg"],
    "deny": ["bash:sudo", "bash:git push"]
  }
}
```

Project settings are ignored, so a repository cannot loosen your rules. Without a `permissions`
key the package starts in `ask` mode and allows `read`, `grep`, `find` and `ls`. If the settings
are invalid you get a warning and `ask` mode.

## Modes

| Mode | Calls that no rule covers |
|---|---|
| `off` | Run without checks, deny rules included |
| `ask` | You choose: allow once, allow for this session, or deny |
| `auto` | The classifier decides; if it is unsure or unavailable, you are asked |

`/permissions` shows the current mode and rules. `/permissions auto` (or `off`, `ask`) switches
mode for the current session; the footer shows the active mode and resuming the session keeps it.
Change `mode` in settings to set the default for new sessions.

"Allow for this session" adds a rule for that tool, or for that program when the call is a plain
Bash command (so allowing `npm test` allows every `npm` command). Session rules are kept in memory
and are lost when Pi restarts.

When there is no UI to ask, such as in print mode, calls that would need you are blocked.

## Rules

A rule is a tool name (`"edit"`) or a Bash command prefix (`"bash:git status"`). Deny rules are
checked first, then allow rules.

- A Bash allow rule only matches a single plain command: no `;`, `&&`, `|`, redirects or `$(...)`.
  Anything more complex goes to the mode.
- A Bash deny rule is checked against each command in a chain, so `ls && sudo rm x` matches
  `bash:sudo`. Deny rules catch mistakes; a script can still hide a program name from them.
- Setting `allow` replaces the default list, so include the read-only tools if you want them.

## Classifier

`model` names any model in Pi's registry, as `provider/id` or just `id`, using Pi's authentication.
Native classifier models answer a choice question; chat models reply with a short JSON verdict.
`timeoutSec` (default 15) limits each request.

The classifier sees your messages in the session, the agent's text and reasoning just before the
call, the working directory and the call itself. It is told that only your messages say what is
wanted. A denial is returned to the agent with the classifier's reason, so the agent can change
course.

Long sessions are trimmed to the newest messages, but the call itself never is: a call over
24 KiB, such as a large `write`, goes to you instead. The timeout holds even if a provider ignores
cancellation.

A new message from you while a call is waiting for approval cancels that call; the agent can retry.

## Child agents

With `pi-delegation`, each new child gets the parent's current mode and rules (including session
allows) and the parent's user messages. The child's task is shown to the classifier as the parent
agent's words, not yours. Approval prompts from children appear in the parent's UI.

## Costs and tests

Classifier usage is recorded in the session and shown by `/costs`.

```sh
npm test --workspace=pi-permissions
npm run test:stock --workspace=pi-permissions
```

The unit tests cover rule matching, modes, prompts, session allows, child settings and classifier
replies. The stock test runs the package in a real Pi session with a scripted model and checks
that denied calls never write. Neither makes a provider request, so they do not measure how well
a particular classifier model judges calls.
