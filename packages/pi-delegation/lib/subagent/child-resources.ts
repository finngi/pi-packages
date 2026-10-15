import { constants, realpathSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ChildResources, ResourceAuthority, ResourceSpec } from "pi-contracts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export class WideningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WideningError";
  }
}
export const childTools = ["read", "write", "edit", "ls", "find", "grep", "bash"];
/** Reuse active native tool provenance instead of maintaining a second package loader. */
export function childToolAuthority(pi: ExtensionAPI, communicationExtension?: string) {
  const registered = new Map((pi.getAllTools?.() ?? []).map((tool) => [tool.name, tool]));
  const toolSources: Record<string, string> = {};
  const tools = pi.getActiveTools().filter((name) => {
    const source = registered.get(name)?.sourceInfo?.path;
    // A live MCP connection is not an executable entrypoint that can be transferred.
    if (source === "builtin:mcp") return false;
    if (name === "session_setup" || name === "subagent" || name.startsWith("subagent_"))
      return false;
    if (
      (communicationExtension !== undefined && source === communicationExtension) ||
      name === "agent_message" ||
      name === "agent_list"
    )
      return false;
    if (source && (path.isAbsolute(source) || source.startsWith("builtin:"))) {
      toolSources[name] = source;
      return true;
    }
    return childTools.includes(name);
  });
  return { tools, toolSources };
}
const fail: (message: string) => never = (message) => {
  throw new WideningError(message);
};
const names = (value: unknown, label: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string" || !/^[\w.-]+$/.test(x)) ||
    new Set(value).size !== value.length
  )
    fail(`invalid ${label}`);
  return value;
};
function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
function isGitMetadata(root: string, candidate: string): boolean {
  return path.relative(root, candidate).split(path.sep).includes(".git");
}
function canonicalBundle(bundle: NonNullable<ResourceSpec["agentBundle"]>) {
  if (!path.isAbsolute(bundle.root) || !Array.isArray(bundle.privateSkills))
    fail("invalid agent bundle");
  let root: string;
  try {
    root = realpathSync(bundle.root);
  } catch {
    return fail("agent bundle is unavailable");
  }
  const privateSkills = [];
  const seen = new Set<string>();
  for (const skill of bundle.privateSkills) {
    if (
      !skill ||
      typeof skill.name !== "string" ||
      typeof skill.path !== "string" ||
      !path.isAbsolute(skill.path)
    )
      fail("invalid private bundle skill");
    let file: string;
    try {
      file = realpathSync(skill.path);
    } catch {
      continue;
    }
    if (!within(root, file) || !file.endsWith(`${path.sep}SKILL.md`)) continue;
    if (seen.has(skill.name)) fail(`duplicate private bundle skill: ${skill.name}`);
    seen.add(skill.name);
    privateSkills.push({
      name: skill.name,
      path: file,
      ...(skill.description ? { description: skill.description } : {}),
    });
  }
  return { root, privateSkills };
}
export function resolveChildResources(
  spec: ResourceSpec,
  parent?: ResourceAuthority,
): ChildResources {
  if (
    spec.instructions !== undefined &&
    (typeof spec.instructions !== "string" ||
      spec.instructions.includes("\0") ||
      Buffer.byteLength(spec.instructions) > 256 * 1024)
  )
    fail("invalid child instructions");
  const inherited: ResourceAuthority = parent ?? { tools: childTools, skills: [], thinking: "off" };
  const tools = spec.tools === undefined ? [...inherited.tools] : names(spec.tools, "tools");
  if (tools.some((x) => !inherited.tools.includes(x))) fail("child tools unavailable or widened");
  for (const name of tools) {
    const source = inherited.toolSources?.[name];
    if (
      !childTools.includes(name) &&
      (!source || (!path.isAbsolute(source) && !source.startsWith("builtin:")))
    )
      fail(`child native tool source unavailable: ${name}`);
  }
  const requestedSkills = spec.skills === undefined ? undefined : names(spec.skills, "skills");
  const agentBundle = spec.agentBundle ? canonicalBundle(spec.agentBundle) : undefined;
  const privateSkills = agentBundle?.privateSkills ?? [];
  const publicByName = new Map(inherited.skills.map((skill) => [skill.name, skill]));
  const privateByName = new Map(privateSkills.map((skill) => [skill.name, skill]));
  const skillNames = requestedSkills ?? [
    ...inherited.skills.map((skill) => skill.name),
    ...privateSkills.map((skill) => skill.name),
  ];
  const skills = [...new Set(skillNames)].map((name) => {
    const privateSkill = privateByName.get(name);
    const matches = privateSkill
      ? [privateSkill]
      : publicByName.has(name)
        ? [publicByName.get(name)!]
        : [];
    if (
      matches.length !== 1 ||
      typeof matches[0].path !== "string" ||
      !path.isAbsolute(matches[0].path)
    )
      fail(`child skill unavailable: ${name}`);
    return { name, path: matches[0].path };
  });
  const requested = spec.model ?? inherited.model;
  if (
    requested &&
    (typeof requested !== "object" ||
      Object.keys(requested).sort().join(",") !== "id,provider" ||
      [requested.id, requested.provider].some(
        (x) => typeof x !== "string" || !x || /[\x00-\x1f]/.test(x),
      ))
  )
    fail("invalid child model");
  const model =
    requested &&
    inherited.models?.find((x) => x.provider === requested.provider && x.id === requested.id);
  if (requested && !model) fail(`child model unavailable: ${requested.provider}/${requested.id}`);
  const thinking = spec.thinking ?? inherited.thinking ?? "off";
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking) ||
    (model ? !getSupportedThinkingLevels(model).includes(thinking) : thinking !== "off")
  )
    fail("child thinking unavailable for selected model");
  if (
    spec.staticContext !== undefined &&
    (!spec.staticContext ||
      !path.isAbsolute(spec.staticContext.originalCwd) ||
      !Array.isArray(spec.staticContext.files) ||
      spec.staticContext.files.some(
        (file) =>
          !file ||
          typeof file.path !== "string" ||
          typeof file.content !== "string" ||
          file.content.includes("\0"),
      ) ||
      (spec.staticContext.instructions !== undefined &&
        (typeof spec.staticContext.instructions !== "string" ||
          spec.staticContext.instructions.includes("\0"))) ||
      Buffer.byteLength(JSON.stringify(spec.staticContext)) > 512 * 1024)
  )
    fail("invalid inherited static context");
  const extensions = [
    ...new Set(
      tools.flatMap((name) => {
        const source = inherited.toolSources?.[name];
        return source && (!source.startsWith("builtin:") || !childTools.includes(name))
          ? [source]
          : [];
      }),
    ),
  ];
  return {
    ...(extensions.length ? { extensions } : {}),
    instructions: spec.instructions ?? "",
    tools: [
      ...tools,
      ...(spec.communication && inherited.communicationExtension
        ? ["agent_message", "agent_list"]
        : []),
    ],
    skills,
    ...(requested ? { model: { provider: requested.provider, id: requested.id } } : {}),
    thinking,
    requested: {
      tools: spec.tools !== undefined,
      skills: spec.skills !== undefined,
      model: spec.model !== undefined,
      thinking: spec.thinking !== undefined,
    },
    ...(agentBundle ? { agentBundle } : {}),
    ...(spec.staticContext ? { staticContext: spec.staticContext } : {}),
  };
}
const MAX_AGENT_BUNDLE_ENTRIES = 2048;
const MAX_AGENT_BUNDLE_BYTES = 16 * 1024 * 1024;
const bundleByteLimitMessage = "agent bundle exceeds 16 MiB byte limit";

export async function readBundleFile(
  source: string,
  maxBytes: number,
  expectedIdentity: { dev: number; ino: number },
) {
  if (typeof constants.O_NOFOLLOW !== "number")
    fail("agent bundle staging requires no-follow file opens");
  let handle: FileHandle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      fail("agent bundle file changed during staging");
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expectedIdentity.dev ||
      opened.ino !== expectedIdentity.ino
    )
      fail("agent bundle file changed during staging");
    if (opened.size > maxBytes) fail(bundleByteLimitMessage);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.byteLength;
      if (size > maxBytes) fail(bundleByteLimitMessage);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await handle.close();
  }
}

async function copyBundle(
  source: string,
  destination: string,
  root: string,
  budget = { entries: 0, bytes: 0 },
  ancestors = new Set<string>(),
): Promise<void> {
  const canonicalSource = realpathSync(source);
  if (!within(root, canonicalSource)) fail(`agent bundle symlink escapes bundle root: ${source}`);
  if (ancestors.has(canonicalSource))
    fail(`agent bundle contains a directory symlink cycle: ${source}`);
  const nextAncestors = new Set(ancestors).add(canonicalSource);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for await (const entry of await opendir(source)) {
    if (entry.name === ".git") continue;
    budget.entries += 1;
    if (budget.entries > MAX_AGENT_BUNDLE_ENTRIES)
      fail(`agent bundle exceeds ${MAX_AGENT_BUNDLE_ENTRIES} entry limit`);
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    const info = await lstat(from);
    const resolved = info.isSymbolicLink() ? realpathSync(from) : from;
    if (!within(root, resolved)) fail(`agent bundle symlink escapes bundle root: ${from}`);
    if (isGitMetadata(root, resolved)) continue;
    const targetInfo = info.isSymbolicLink() ? await lstat(resolved) : info;
    if (targetInfo.isDirectory()) await copyBundle(resolved, to, root, budget, nextAncestors);
    else if (targetInfo.isFile()) {
      const remainingBytes = MAX_AGENT_BUNDLE_BYTES - budget.bytes;
      if (targetInfo.size > remainingBytes) fail(bundleByteLimitMessage);
      const body = await readBundleFile(resolved, remainingBytes, targetInfo);
      budget.bytes += body.byteLength;
      const stagedMode = 0o400 | (targetInfo.mode & 0o111);
      await writeFile(to, body, { flag: "wx", mode: stagedMode });
      await chmod(to, stagedMode);
    }
  }
  await chmod(destination, 0o700);
}
const stripContextFrontmatter = (content: string) => {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const header = /^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/.exec(normalized)?.[0];
  // Only complete standalone delimiters identify metadata, including malformed YAML.
  return header ? normalized.slice(header.length).trim() : normalized;
};
const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export async function installChildResources(resources: ChildResources, directory: string) {
  const instructions = path.join(directory, "instructions.md");
  let instructionText = "";
  if (resources.staticContext?.files.length) {
    const contextDir = path.join(directory, "context");
    await mkdir(contextDir, { mode: 0o700 });
    for (const [index, file] of resources.staticContext.files.entries()) {
      const dest = path.join(contextDir, `${String(index + 1).padStart(3, "0")}.md`);
      await writeFile(dest, stripContextFrontmatter(file.content), { flag: "wx", mode: 0o400 });
    }
    await chmod(contextDir, 0o700);
    instructionText +=
      `\n\n<inherited_static_context original_project="${xml(resources.staticContext.originalCwd)}">\n` +
      resources.staticContext.files
        .map((file) => `## Source: ${file.path}\n\n${stripContextFrontmatter(file.content)}`)
        .join("\n\n") +
      "\n</inherited_static_context>\nThe original project path above identifies where these instructions applied. Your writable workspace is set separately. This is a snapshot of static instruction files only; parent session state and conversation are not included.";
  }
  if (resources.staticContext?.instructions)
    instructionText += `\n\n<instructions>\n${resources.staticContext.instructions}\n</instructions>`;
  instructionText += `\n\n${resources.instructions}`;
  const skillPaths = [];
  let stagedBundle: string | undefined;
  if (resources.agentBundle) {
    stagedBundle = path.join(directory, "bundles", "agent");
    await mkdir(path.dirname(stagedBundle), { recursive: true, mode: 0o700 });
    await copyBundle(resources.agentBundle.root, stagedBundle, resources.agentBundle.root);
    await chmod(path.dirname(stagedBundle), 0o700);
    instructionText += `\n\n<agent_bundle path="${xml(stagedBundle)}" />\nResolve relative supporting paths in your agent instructions against this bundle directory. Resolve skill-relative paths against the skill's SKILL.md directory. Write outputs in your workspace.`;
  }
  await writeFile(instructions, instructionText, { flag: "wx", mode: 0o400 });
  for (const [index, skill] of resources.skills.entries()) {
    if (stagedBundle && within(resources.agentBundle!.root, skill.path)) {
      skillPaths.push(
        path.join(stagedBundle, path.relative(resources.agentBundle!.root, skill.path)),
      );
      continue;
    }
    const base = path.join(directory, "skills", String(index));
    await mkdir(base, { recursive: true, mode: 0o700 });
    const body = await readFile(skill.path);
    const installed = path.join(base, "SKILL.md");
    await writeFile(installed, body, { flag: "wx", mode: 0o600 });
    // Preserve trusted supporting-resource paths without reading or copying their contents.
    for (const name of await readdir(path.dirname(skill.path))) {
      if (name === path.basename(skill.path) || name === "SKILL.md") continue;
      await symlink(path.join(path.dirname(skill.path), name), path.join(base, name));
    }
    skillPaths.push(installed);
  }
  return { instructions, skillPaths, bundlePath: stagedBundle };
}
