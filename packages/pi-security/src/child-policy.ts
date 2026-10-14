import type { PermissionLimits, ChildSpec, LoadedPolicy } from "./types.ts";
import { realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { contains } from "./temp-scope.ts";
import { WideningError } from "pi-runtime";
import { assertHostCapabilities } from "./host-capabilities.ts";
import { networkScopeWithin } from "./permissions.ts";
import { materializeFilesystem } from "./policy.ts";
export { WideningError } from "pi-runtime";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const reject: (message: string) => never = (message) => {
  throw new WideningError(message);
};
export function childPermissionLimits(parent: LoadedPolicy, spec: ChildSpec): PermissionLimits {
  const limits = { write: parent.limits?.write ?? true, network: parent.limits?.network ?? true };
  if (spec.permissions !== undefined) {
    if (
      !spec.permissions ||
      typeof spec.permissions !== "object" ||
      Array.isArray(spec.permissions) ||
      Object.keys(spec.permissions).some((key) => !["write", "network"].includes(key))
    )
      reject("invalid child permissions");
    for (const key of ["write", "network"] as const) {
      const requested = spec.permissions[key];
      if (requested !== undefined && typeof requested !== "boolean")
        reject("invalid child permission limit");
      if (requested === true && !limits[key]) reject(`${key} permission widened`);
      limits[key] = requested ?? limits[key];
    }
  }
  return limits;
}
const list = (value: unknown, name: string): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((x) => typeof x !== "string" || !x || /[\x00-\x1f]/.test(x))
  )
    reject(`invalid ${name}`);
  return value;
};
const canonical = (value: string): string => {
  if (!path.isAbsolute(value)) reject("relative authority path");
  try {
    return realpathSync(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(canonical(path.dirname(value)), path.basename(value));
  }
};
const root = (value: string) => (value.endsWith("/**") ? value.slice(0, -3) : value);
const subset = (child: string[], parent: string[], name: string) => {
  if (
    child.some((x) =>
      name === "network"
        ? x === "*"
          ? !parent.includes("*")
          : !networkScopeWithin(x, parent)
        : !parent.includes(x),
    )
  )
    reject(`${name} widened`);
};
export function narrow(
  parent: LoadedPolicy,
  spec: ChildSpec,
  { tmp, tempBase, launchDir }: { tmp: string; tempBase: string; launchDir: string },
): LoadedPolicy {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) reject("invalid child spec");
  for (const key of Object.keys(spec))
    if (
      ![
        "task",
        "allowIds",
        "writeAllow",
        "networkHosts",
        "permissions",
        "readDeny",
        "writeDeny",
        "instructions",
        "tools",
        "skills",
        "model",
        "thinking",
        "permissionMode",
        "communication",
      ].includes(key)
    )
      reject(`unknown spec key ${key}`);
  if (typeof spec.task !== "string") reject("task must be text");
  tmp = canonical(tmp);
  tempBase = canonical(tempBase);
  launchDir = canonical(launchDir);
  if (lstatSync(tmp).isSymbolicLink() || !contains(parent.tmp, tmp) || tmp === parent.tmp)
    reject("invalid child temp");
  const limits = childPermissionLimits(parent, spec);
  const p = structuredClone(parent.policy);
  if (spec.permissionMode !== undefined) {
    if (!["auto", "manual"].includes(spec.permissionMode)) reject("invalid permission mode");
    p.mode = spec.permissionMode;
  }
  if (spec.allowIds !== undefined) {
    const ids = list(spec.allowIds, "allowIds");
    if (ids.some((id) => !p.allow.some((rule) => rule.id === id))) reject("unknown allow id");
    p.allow = p.allow.filter((rule) => rule.id !== undefined && ids.includes(rule.id));
  }
  const writes =
    spec.writeAllow === undefined ? [tmp] : list(spec.writeAllow, "writeAllow").map(canonical);
  if (
    !writes.length ||
    writes.some(
      (x) =>
        !contains(tmp, x) || !parent.filesystem.writeAllow.some((p) => contains(canonical(p), x)),
    )
  )
    reject("write roots widened");
  const filesystem = {
    readDeny: [
      ...parent.filesystem.readDeny,
      ...list(spec.readDeny ?? [], "readDeny").map(
        (x) => canonical(root(x)) + (x.endsWith("/**") ? "/**" : ""),
      ),
    ],
    writeDeny: [
      ...parent.filesystem.writeDeny,
      ...list(spec.writeDeny ?? [], "writeDeny").map(
        (x) => canonical(root(x)) + (x.endsWith("/**") ? "/**" : ""),
      ),
    ],
    writeAllow: writes,
  };
  const hosts = spec.networkHosts ?? p.resources.network;
  subset(hosts, p.resources.network, "network");
  p.resources.network = hosts;
  materializeFilesystem(p, filesystem);
  const child: LoadedPolicy = {
    policy: p,
    filesystem,
    project: tmp,
    tmp,
    limits,
    capabilities: [...(parent.capabilities ?? [])],
    agentDepth: (parent.agentDepth ?? 0) + 1,
    childTask: spec.task,
    tempIsolation: { base: tempBase, own: tmp, launchDir },
  };
  assertNarrows(child, parent);
  return child;
}
export function assertNarrows(child: LoadedPolicy, parent: LoadedPolicy) {
  if (!child || !child.policy || !child.filesystem) reject("invalid child authority");
  const p = parent.policy,
    c = child.policy;
  if (child.resources) {
    const r = child.resources,
      a = parent.resourceAuthority;
    if (
      typeof r.instructions !== "string" ||
      !Array.isArray(r.tools) ||
      r.tools.some(
        (x) =>
          ![
            "read",
            "write",
            "edit",
            "ls",
            "find",
            "grep",
            "bash",
            "agent_message",
            "agent_list",
          ].includes(x),
      ) ||
      !Array.isArray(r.skills)
    )
      reject("invalid selected child resources");
    if (a) {
      subset(r.tools, a.tools, "selected tools");
      for (const skill of r.skills)
        if (
          !a.skills.some((x) => x.name === skill.name && x.path === skill.path) &&
          !a.privateSkills?.some((x) => x.name === skill.name && x.path === skill.path)
        )
          reject("selected skills widened");
    }
  }
  assertHostCapabilities(child.capabilities);
  subset(child.capabilities ?? [], parent.capabilities ?? [], "host capabilities");
  if (!["auto", "manual"].includes(c.mode)) reject("invalid mode");
  for (const key of ["version", "classifier", "approvalTimeoutSec", "env"] as const)
    if (!same(c[key], p[key])) reject(`${key} altered`);
  if (
    !same(c.resources.write, child.filesystem.writeAllow) ||
    !same(c.resources.denyRead, child.filesystem.readDeny) ||
    !same(c.resources.denyWrite, child.filesystem.writeDeny)
  )
    reject("resolved filesystem mismatch");
  for (const field of ["readDeny", "writeDeny"] as const)
    subset(parent.filesystem[field], child.filesystem[field], field);
  if (!same(c.deny, p.deny)) reject("deny rules altered");
  for (const rule of c.allow) if (!p.allow.some((x) => same(x, rule))) reject("allow rule altered");
  subset(c.resources.network, p.resources.network, "network");
  if (!child.limits || Object.keys(child.limits).sort().join(",") !== "network,write")
    reject("invalid child limits");
  for (const key of ["write", "network"] as const) {
    if (
      typeof child.limits[key] !== "boolean" ||
      (child.limits[key] && parent.limits?.[key] === false)
    )
      reject(`${key} permission widened`);
  }
  if (child.agentDepth !== (parent.agentDepth ?? 0) + 1 || typeof child.childTask !== "string")
    reject("invalid child metadata");
  if (
    child.authorization &&
    !same(child.authorization, parent.authorization ?? { userMessages: [] })
  )
    reject("child user authority altered");
  if (
    child.communication &&
    (!child.resources?.tools.includes("agent_message") ||
      !parent.resourceAuthority?.tools.includes("agent_message") ||
      !path.isAbsolute(child.communication.extensionPath))
  )
    reject("unbound child communication");
  const tmp = canonical(child.tmp);
  if (
    child.project !== tmp ||
    child.tmp !== tmp ||
    !contains(parent.tmp, tmp) ||
    tmp === parent.tmp
  )
    reject("child temp widened");
  const t = child.tempIsolation;
  if (!t || t.own !== tmp || !contains(t.base, tmp) || contains(tmp, t.launchDir))
    reject("invalid temp isolation");
  const protectedResources = child.launchResources;
  if (child.resources) {
    if (
      !protectedResources ||
      !path.isAbsolute(protectedResources.directory) ||
      protectedResources.directory !== canonical(protectedResources.directory) ||
      !contains(t.launchDir, protectedResources.directory) ||
      protectedResources.directory === t.launchDir
    )
      reject("invalid protected resource directory");
    if (
      protectedResources.instructions?.path !==
        path.join(protectedResources.directory, "instructions.md") ||
      !Array.isArray(protectedResources.skills) ||
      protectedResources.skills.length !== child.resources.skills.length
    )
      reject("invalid protected resources");
    const bundle = protectedResources.bundle;
    if (bundle) {
      const expectedBundlePath = path.join(protectedResources.directory, "bundles", "agent");
      if (
        bundle.path !== expectedBundlePath ||
        bundle.path !== canonical(bundle.path) ||
        !contains(protectedResources.directory, bundle.path) ||
        !path.isAbsolute(bundle.sourceRoot) ||
        bundle.sourceRoot !== canonical(bundle.sourceRoot) ||
        !Array.isArray(bundle.skills)
      )
        reject("invalid protected agent bundle");
      for (const entry of bundle.skills) {
        const relative = path.relative(bundle.sourceRoot, entry.sourcePath);
        if (
          !parent.resourceAuthority?.privateSkills?.some(
            (x) => x.name === entry.name && x.path === entry.sourcePath,
          ) ||
          !path.isAbsolute(entry.sourcePath) ||
          entry.sourcePath !== canonical(entry.sourcePath) ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          entry.path !== path.join(bundle.path, relative) ||
          entry.path !== canonical(entry.path) ||
          !contains(bundle.path, entry.path) ||
          !protectedResources.skills.some((x) => x.name === entry.name && x.path === entry.path)
        )
          reject("invalid protected bundle skill");
      }
      if (
        bundle.skills.length !== parent.resourceAuthority?.privateSkills?.length ||
        bundle.skills.some(
          (entry) =>
            !child.resources!.skills.some(
              (x) => x.name === entry.name && x.path === entry.sourcePath,
            ),
        )
      )
        reject("private bundle metadata mismatch");
    } else if ((parent.resourceAuthority?.privateSkills?.length ?? 0) > 0) {
      reject("missing protected agent bundle");
    }
    for (const [index, skill] of protectedResources.skills.entries()) {
      const bundled = bundle?.skills.some((x) => x.name === skill.name && x.path === skill.path);
      if (
        skill.name !== child.resources.skills[index].name ||
        (bundled
          ? !bundle!.skills.some(
              (x) =>
                x.name === skill.name &&
                x.path === skill.path &&
                x.sourcePath === child.resources!.skills[index].path,
            )
          : skill.path !==
              path.join(protectedResources.directory, "skills", String(index), "SKILL.md") ||
            skill.path !== canonical(skill.path))
      )
        reject("invalid protected skill");
    }
    if (
      !same(t.resourceReadAllow, [
        ...protectedResources.skills.map((x) => path.dirname(x.path)),
        ...(bundle ? [bundle.path] : []),
      ])
    )
      reject("selected resource read roots widened");
  } else if ((t.resourceReadAllow ?? []).length) reject("unbound selected resource read roots");
  if (
    (t.resourceReadAllow ?? []).some(
      (x) => !path.isAbsolute(x) || !contains(t.launchDir, x) || contains(tmp, x),
    )
  )
    reject("invalid selected resource read roots");
  if (
    parent.tempIsolation &&
    (t.base !== parent.tempIsolation.base || t.launchDir !== parent.tempIsolation.launchDir)
  )
    reject("temp metadata altered");
  if (
    !child.filesystem.writeAllow.length ||
    child.filesystem.writeAllow.some(
      (x) =>
        x !== canonical(x) ||
        !contains(tmp, x) ||
        !parent.filesystem.writeAllow.some((p) => contains(canonical(p), x)),
    )
  )
    reject("write roots widened");
}
