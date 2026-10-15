import type { FoundAgent } from "./agents.ts";
import { escapeXml } from "./messages.ts";

/** Scope fields the native launcher reports, in display order. */
const scopeFields = [
  ["workspaceModes", "workspace"],
  ["execution", "execution"],
  ["approval", "approval"],
  ["read", "read"],
  ["write", "write"],
  ["network", "network"],
  ["unavailable", "unavailable"],
] as const;

type ScopeField = (typeof scopeFields)[number][0];

export interface AgentPreview {
  tools: string[];
  scope: Partial<Record<ScopeField, string | string[]>>;
}

const isText = (value: unknown): value is string | string[] =>
  typeof value === "string" ||
  (Array.isArray(value) && value.every((item) => typeof item === "string"));

/** Keep the tools and scope summary; launcher details such as child skills stay out of parent context. */
export function publicAgentPreview(value: unknown): AgentPreview {
  const preview = (value ?? {}) as { tools?: unknown; scope?: unknown };
  if (
    !Array.isArray(preview.tools) ||
    !preview.tools.every(
      (tool) => typeof tool === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(tool),
    ) ||
    !preview.scope ||
    typeof preview.scope !== "object"
  )
    throw Error("Child capability preview is invalid");
  const rawScope = preview.scope as Record<string, unknown>;
  const scope: AgentPreview["scope"] = {};
  for (const [field] of scopeFields) {
    const value = rawScope[field];
    if (isText(value)) scope[field] = value;
  }
  return { tools: [...preview.tools], scope };
}

export function scopeCatalogue(scope: AgentPreview["scope"]): string {
  const rows = scopeFields.flatMap(([field, tag]) => {
    const value = field === "workspaceModes" ? (scope[field] ?? ["scratch"]) : scope[field];
    if (value === undefined) return [];
    const content = typeof value === "string" ? value : value.join(", ") || "none";
    return [`      <${tag}>${escapeXml(content)}</${tag}>`];
  });
  return ["    <scope>", ...rows, "    </scope>"].join("\n");
}

export function agentCatalogue(
  agents: FoundAgent[],
  previews = new Map<string, AgentPreview>(),
  models = new Map<string, { model: string; locked: boolean }>(),
): string {
  const lines = ["<available_agents>"];
  for (const { name, description } of agents) {
    const preview = previews.get(name);
    lines.push(
      "  <agent>",
      `    <name>${escapeXml(name)}</name>`,
      `    <description>${escapeXml(description)}</description>`,
    );
    const selection = models.get(name);
    if (selection)
      lines.push(
        `    <model selection="${selection.locked ? "fixed" : "selectable"}">${escapeXml(selection.model)}</model>`,
      );
    if (preview)
      lines.push(
        `    <tools>${escapeXml(preview.tools.join(", "))}</tools>`,
        scopeCatalogue(preview.scope),
      );
    lines.push("  </agent>");
  }
  lines.push("</available_agents>");
  return lines.join("\n");
}

export function cataloguePrompt(
  systemPrompt: string,
  agents: FoundAgent[],
  previews?: Map<string, AgentPreview>,
  selections?: Map<string, { model: string; locked: boolean }>,
  models: readonly { provider: string; id: string }[] = [],
): string {
  return `${systemPrompt}\n\nThe following agents can perform delegated tasks.\nUse subagent with an exact definition name when a task matches its description.\nSet subagent.model to choose a listed model when selection is selectable; a fixed model is a user choice and cannot be overridden. Check each agent's tools and scope before delegating. Check the advertised workspace modes and permissions. Closing a child returns its retained artifact location; inspect and integrate its output. Direct project changes stay in the project.\nUse agent_message with an existing agent ID for questions and actionable coordination (kind: question or message). Routine parent telemetry uses kind: progress and never starts an idle parent turn; progress to children or siblings is refused. Acknowledgements confirm broker/RPC acceptance, not reading, task acceptance or completed work.\n${agentCatalogue(agents, previews, selections)}
${
  models.length
    ? `<available_subagent_models>\n${[...models]
        .sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`))
        .map((model) => `  <model>${escapeXml(`${model.provider}/${model.id}`)}</model>`)
        .join("\n")}\n</available_subagent_models>`
    : ""
}`;
}
