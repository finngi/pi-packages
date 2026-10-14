# Configure prompt context

The interactive TUI displays the conversation. The model receives system instructions, callable tool
schemas, and conversation messages. These inputs have different jobs: tools execute actions, skills
supply optional instructions, and an agent is a separate session that uses the selected tools and skills.

## Use a specific agent prompt

For a focused Pi session, supply a system prompt and choose its tools:

```sh
pi --system-prompt /absolute/path/lexical-search.md --tools read,bash
```

A trusted project's `.pi/SYSTEM.md` can supply the prompt persistently. Pi 1.2.0 replaces its generic
preamble and omits its default textual tools, rules, and documentation sections when a custom prompt
is supplied. Callable tools still carry their full schemas separately. Project instructions, selected
skills, and extension sections can still be added; tool availability is a separate configuration.

A delegated agent's Markdown entrypoint becomes that child's system instructions. Its frontmatter
selects resources and is removed from the instructions. See [agent definitions](../reference/configuration.md#agent-definitions).

## Read project instructions

Pi's global instructions precede discovered project instructions. Project files are ordered from
outer ancestor directories to the working directory, each with its own source block:

```xml
<project_context>
  <project_instructions path="/project/AGENTS.md">
    Use dependency-free JavaScript.
  </project_instructions>
  <project_instructions path="/project/parser/AGENTS.md">
    Verify quoted fields and trailing empty fields.
  </project_instructions>
</project_context>
```

`pi-local-context` adds `AGENTS.local.md` to this project context and strips closed YAML metadata.
It preserves bodies and source paths. See [local context](context.md).

## Select agent instructions

Use `/instructions` to choose reusable guidance for the agent: how to communicate, delegate work or
handle a data type. The selected bodies appear in a separate native Pi prompt section:

```xml
<instructions>
  <instruction path="/catalogue/communication.md">
    Explain results in plain language and state what remains uncertain.
  </instruction>
  <instruction path="/catalogue/delegation.md">
    Give each child a concrete task and review its evidence before integrating changes.
  </instruction>
</instructions>
```

The examples are illustrative snippet bodies. Project files and selected guidance are both system
instructions; their wrappers clarify origin and purpose without resolving contradictions by order.
Unlike a skill, a selected instruction body is loaded eagerly. Session history stores the selected snippets. Ctrl+S saves project defaults; Ctrl+Shift+S saves personal defaults for new sessions across projects.

Pi's supported `systemPromptOptions.sections` API renders the `<instructions>` wrapper. It retains
caller-supplied content in that section and appends selected source blocks. Unchanged turns retain
the same section text; edits or selection changes update that section through Pi's native prompt
diff mechanism. This does not guarantee a provider cache-hit rate. A forced opaque system prompt
keeps Pi's native override behavior.

Children inherit this static instruction section separately from project-file context. Other dynamic
parent sections are not inherited. The child receives the section inside its static system addendum,
so the distinction does not require another loader or independent child section bootstrap.

| Tag | Fit |
| --- | --- |
| `<instructions>` | General guidance; the section used here |
| `<selected_instructions>` | Emphasizes how guidance was chosen |
| `<guidance>` | Broad wording, less explicit about instructions |
| `<preferences>` | Suitable for style choices, narrower than workflows and data-handling rules |

These are naming alternatives, not new settings or permission levels. The native `<project_context>`
and `<project_instructions>` names remain unchanged.

## Select optional skills

Selecting a skill adds its name, description, and file location to the catalogue. The model can read
`SKILL.md` when its instructions would help the current task. The skill body is not inserted eagerly.
An agent bundle can expose private skills to its child without adding them to the parent's catalogue.
The agent's own instructions can guide skill selection; they need not require loading every skill.

`pi-local-context` includes the optional `pi-help` skill. Its metadata describes when it applies; its
body points to a small script that resolves the running SDK's documentation and examples. Installing
the package selects that metadata unless the host filters out its skills. An explicit entrypoint-only
launch can select it using Pi's ordinary skill option:

```sh
pi -e /absolute/checkout/packages/pi-local-context/extensions/context.ts \
   --skill /absolute/checkout/packages/pi-local-context/skills/pi-help/SKILL.md
```

The extension reduces Pi's default documentation section to one line. If `pi-help` is selected, the
line points to that skill; otherwise it points to the installed SDK documentation directory. A
custom system prompt, forced prompt, or explicit caller documentation-section override is preserved.

## Review agent capabilities

The parent has one `<agents>` section containing available definitions. Each entry exposes the
name, description, effective tools, and a concise scope:

```xml
<agent>
  <name>reviewer</name>
  <description>Review correctness with source evidence.</description>
  <tools>read, bash, agent_message, agent_list</tools>
  <scope>
    <workspace>scratch</workspace>
    <approval>auto</approval>
    <read>permitted files, excluding policy denials and other agent temporary directories</read>
    <write>none</write>
    <network>none</network>
  </scope>
</agent>
```

This is a capability summary. The runtime still enforces the exact policy, and launch results retain
its detailed scope. A parent cannot grant wider child access through task wording. The textual tools
section includes delegation and messaging summaries; full callable tool schemas remain authoritative.

## Keep running state in the conversation

The session's `<agent_id>` is stable. Running children and their changing busy/idle states do not
appear in a mutable `<active_agents>` system section. Launch and close results append identity and
state to the conversation; child messages and responses append their own envelopes. Use `agent_list`
for a current reachable-session snapshot.

Starting or closing a child therefore does not rewrite the leading system sections. Changing selected
instructions, skills, tools, or agent definitions can still change those sections. Provider caching
also depends on the provider's request format and retention; an unchanged prefix makes reuse possible
without guaranteeing a particular cache-hit rate.
