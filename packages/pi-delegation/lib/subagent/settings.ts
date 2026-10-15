import { THINKING_LEVELS } from "./agents.ts";
import type { AgentDef } from "./agents.ts";

export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
}
export interface ParentResources {
  model?: ModelRef;
  thinking?: string;
  available: ModelRef[];
  tools: string[];
  skills: string[];
  privateSkills?: string[];
}
const isAlias = (id: string) => id.endsWith("-latest") || !/-\d{8}$/.test(id);
export function matchModel(pattern: string, available: ModelRef[]): ModelRef | undefined {
  const wanted = pattern.toLowerCase();
  const exact = available.filter((m) => m.id.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const matches = exact.length
    ? exact
    : available.filter(
        (m) => m.id.toLowerCase().includes(wanted) || m.name?.toLowerCase().includes(wanted),
      );
  return [...matches].sort(
    (a, b) => Number(isAlias(b.id)) - Number(isAlias(a.id)) || b.id.localeCompare(a.id),
  )[0];
}
function resolveModel(spec: string, parent: ParentResources) {
  let level: string | undefined;
  const at = spec.lastIndexOf(":");
  if (at > 0 && THINKING_LEVELS.includes(spec.slice(at + 1))) {
    level = spec.slice(at + 1);
    spec = spec.slice(0, at);
  }
  const slash = spec.indexOf("/");
  const model =
    spec === "inherit"
      ? parent.model
      : slash < 0
        ? matchModel(spec, parent.available)
        : parent.available.find(
            (m) => m.provider === spec.slice(0, slash) && m.id === spec.slice(slash + 1),
          );
  if (!model) throw Error(`model "${spec}" is unavailable or unauthenticated`);
  return { model, level };
}
export function resolveSettings(
  agent: AgentDef,
  parent: ParentResources,
  secured = true,
  requestedModel?: string,
) {
  if (
    requestedModel !== undefined &&
    (typeof requestedModel !== "string" || !requestedModel.trim())
  )
    throw Error("model must be a nonempty alias or provider/model ID");
  const configured = resolveModel(agent.model ?? "inherit", parent);
  const selected = requestedModel === undefined ? configured : resolveModel(requestedModel, parent);
  if (
    agent.model &&
    agent.model !== "inherit" &&
    (selected.model.provider !== configured.model.provider ||
      selected.model.id !== configured.model.id)
  )
    throw Error(
      `Agent "${agent.name}" has a user-configured model "${configured.model.provider}/${configured.model.id}" in ${agent.filePath}; requested "${selected.model.provider}/${selected.model.id}" conflicts. Use the configured model, or have the user remove the model setting or set it to inherit.`,
    );
  const model = selected.model;
  const level = configured.level ?? selected.level;
  for (const name of agent.tools ?? [])
    if (!parent.tools.includes(name))
      throw Error(`tools: "${name}" is unavailable in the parent active tools`);
  const availableSkills = new Set([
    ...parent.skills,
    ...(parent.privateSkills ?? []),
    ...(agent.privateSkills ?? []).map((skill) => skill.name),
  ]);
  for (const name of agent.skills ?? [])
    if (!availableSkills.has(name))
      throw Error(
        `skill "${name}" is unavailable; add it to the agent bundle or configure its path in Pi settings`,
      );
  if (
    secured &&
    agent.permissions &&
    ["full-access", "dangerously-unrestricted"].includes(agent.permissions)
  )
    throw Error(`permissionMode "${agent.permissions}" is unavailable for delegated agents`);
  return {
    model: { provider: model.provider, id: model.id },
    thinking: agent.thinking ?? level ?? parent.thinking,
    tools: agent.tools,
    skills: agent.skills ?? [
      ...parent.skills,
      ...(agent.privateSkills ?? []).map((skill) => skill.name),
    ],
    permissionMode: agent.permissions,
  };
}
