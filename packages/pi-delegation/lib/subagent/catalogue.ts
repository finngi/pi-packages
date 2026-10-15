import type { FoundAgent } from "./agents.ts";
import { escapeXml } from "./messages.ts";

export interface AgentPreview {
  tools: string[];
  scope: Record<string, unknown>;
}

const previewScopeFields = [
  "workspaceModes",
  "mode",
  "security",
  "read",
  "write",
  "network",
  "capabilities",
] as const;

function previewText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const normalized = value.normalize("NFKC");
  if (/[%&\\/\u0000-\u001f\u2044\u2215\u29f8]/u.test(normalized)) return undefined;
  return value;
}

function previewValue(value: unknown): unknown {
  const text = previewText(value);
  if (text !== undefined) return text;
  if (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((item) => typeof item === "string" && previewText(item) !== undefined)
  )
    return value.map((item) => previewText(item));
  return undefined;
}

/** Keep launcher internals such as private skills and policy deny paths out of parent context. */
export function publicAgentPreview(value: unknown): AgentPreview {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Child capability preview is invalid");
  const preview = value as Record<string, unknown>;
  if (
    !Array.isArray(preview.tools) ||
    preview.tools.length > 256 ||
    !preview.tools.every(
      (tool) => typeof tool === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(tool),
    ) ||
    !preview.scope ||
    typeof preview.scope !== "object" ||
    Array.isArray(preview.scope)
  )
    throw Error("Child capability preview is invalid");

  const rawScope = preview.scope as Record<string, unknown>;
  const scope: Record<string, unknown> = {};
  for (const field of previewScopeFields) {
    const safe = previewValue(rawScope[field]);
    if (safe !== undefined) scope[field] = safe;
  }
  return { tools: [...preview.tools], scope };
}

/** Render the capability summary; full policy data stays in inspection results. */
export function scopeCatalogue(scope: AgentPreview["scope"]): string {
  const rows: Array<[string, unknown]> = [
    ["workspace", scope.workspaceModes ?? ["scratch"]],
    ["approval", scope.mode],
    ["read", scope.read],
    ["write", scope.write],
    ["network", scope.network],
    ["capabilities", scope.capabilities],
  ];
  const text = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      return value.length ? value.join(", ") : "none";
    return undefined;
  };
  return [
    "    <scope>",
    ...rows.flatMap(([name, value]) => {
      const content = text(value);
      return content === undefined ? [] : [`      <${name}>${escapeXml(content)}</${name}>`];
    }),
    "    </scope>",
  ].join("\n");
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
