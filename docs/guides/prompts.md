# Prompt context

The TUI shows the conversation. The model gets more: system instructions, tool schemas and the
messages. Each part has its own job. Tools take actions. Skills are optional instructions the
model reads when needed. An agent is a separate session with its own tools and skills.

## Give a session its own prompt

For a focused Pi session, pass a system prompt and choose its tools:

```sh
pi --system-prompt /absolute/path/lexical-search.md --tools read,bash
```

A trusted project's `.pi/SYSTEM.md` sets the prompt permanently. With a custom prompt, Pi 1.2.0
drops its generic opening and its default text about tools, rules and documentation. Tools still
send their full schemas separately. Project instructions, selected skills and extension sections
can still be added. Which tools are available is set separately.

For a child agent, the agent file's body becomes its system instructions. Its front-matter picks
resources and is removed. See [agent metadata](../reference/configuration.md#agent-and-skill-selection).

## Project instructions

Pi's global instructions come before project instructions. Project files go from the outermost
parent directory down to the working directory, each in its own block:

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

`pi-context` adds `AGENTS.local.md` files here and removes YAML front-matter, keeping the text and
source paths. See [local context](context.md).

## Selected instructions

Use `/instructions` to choose reusable guidance, such as how to communicate, delegate or handle a
kind of data. Selected snippets go in their own section:

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

These bodies are examples. Project files and selected snippets are both system instructions. The
wrappers show where text came from; their order does not settle conflicts. Unlike a skill, a
selected snippet is always in the prompt. The session records which snippets are selected. Ctrl+S
saves them as project defaults and Ctrl+Shift+S as personal defaults.

The section is rendered with Pi's `systemPromptOptions.sections` API. Content the caller already
put in the section stays, and selected snippets are added after it. When nothing changes, the
section text stays the same; edits and selection changes update it through Pi's normal prompt
diffing. That makes provider caching possible but does not guarantee it. A forced system prompt
keeps Pi's usual override behaviour.

Children get this section along with the static project context, inside their fixed system
instructions. Other live parent sections are not passed on. See
[what the child receives](delegation.md#what-the-child-receives).

We picked the tag name `<instructions>` because it fits general guidance. Alternatives we
considered were `<selected_instructions>`, `<guidance>` and `<preferences>`. This is a naming
note, not a setting. Pi's `<project_context>` and `<project_instructions>` names are unchanged.

## Select optional skills

Selecting a skill adds its name, description and file location to the skill list. The model reads
`SKILL.md` when it would help; the body is never added up front. An agent bundle can give its child
private skills without adding them to the parent's list. The agent's instructions can say when to
use a skill; they do not need to load every one.

`pi-context` includes the optional `pi-help` skill. Its description says when it applies, and its
body points to a small script that finds the running SDK's docs and examples. Installing the
package makes the skill available unless the host filters skills out. When you load only the
entrypoint, add the skill with Pi's usual option:

```sh
pi -e /absolute/checkout/packages/pi-context/extensions/context.ts \
   --skill /absolute/checkout/packages/pi-context/skills/pi-help/SKILL.md
```

The extension shortens Pi's default documentation section to one line. It points to `pi-help`
when that skill is selected, or otherwise to the SDK documentation folder. Custom and forced system
prompts, and explicit overrides of that section, are left alone.

## The agent list

When delegation is loaded, the parent's prompt has an `<available_agents>` section listing the
agents it can launch, followed by the models it can choose. Each entry shows the name,
description, model, tools and a short scope:

```xml
<agent>
  <name>reviewer</name>
  <description>Review correctness with source evidence.</description>
  <model selection="selectable">provider/model</model>
  <tools>read, bash, agent_message, agent_list</tools>
  <scope>
    <workspace>scratch, project</workspace>
    <execution>host permissions</execution>
    <approval>native tool-call hooks</approval>
    <read>host permissions</read>
    <write>host permissions; workspace is an organisational directory, not confinement</write>
    <network>host permissions</network>
    <unavailable>MCP connections are not transferred</unavailable>
  </scope>
</agent>
```

This is a summary. Launch results include the full scope, and the parent cannot give a child more
access by wording the task differently. The tool schemas remain the exact definition of each tool.

## Running agents stay in the conversation

The session's `<agent_id>` stays the same. Running children and their busy or idle state are not
written into the system prompt. Launch and close results add that information to the conversation,
and child messages and answers arrive as their own messages. Use `agent_list` to see who is running
now.

So starting or closing a child does not change the start of the prompt. Changing selected
instructions, skills, tools or agents can. Whether the provider reuses a cached prompt also
depends on the provider; an unchanged prefix makes it possible but does not guarantee it.
