import type { ExecutionPermissions, LoadedPolicy, Rule } from "./types.ts";
import { canonicalizeHost } from "./fetch-proxy.ts";

export const localPermissions = (write = false): ExecutionPermissions => ({ write, network: [] });
export function rulePermissions(
  rule: Rule,
  loaded: LoadedPolicy,
  write: boolean,
  defaultNetwork: string[] = [],
): ExecutionPermissions {
  const hosts = rule.permissions?.network ?? defaultNetwork.filter((host) => host !== "*");
  return { write: rule.permissions?.write ?? write, network: hosts.length ? [hosts] : [] };
}
export function normalizePermissions(
  value: ExecutionPermissions,
  loaded: LoadedPolicy,
): ExecutionPermissions {
  if (
    !value ||
    typeof value.write !== "boolean" ||
    !Array.isArray(value.network) ||
    value.network.some(
      (group) =>
        !Array.isArray(group) || !group.length || group.some((host) => typeof host !== "string"),
    )
  )
    throw Error("invalid execution permissions");
  if (value.execution === "host") {
    if (
      !loaded.capabilities?.includes("host-execution") ||
      loaded.limits?.write === false ||
      loaded.limits?.network === false
    )
      throw Error("host execution is not enabled for this session");
    if (!value.write || JSON.stringify(value.network) !== '[["*"]]')
      throw Error("invalid host execution permissions");
    return { execution: "host", write: true, network: [["*"]] };
  }
  if (value.execution !== undefined && value.execution !== "sandbox")
    throw Error("invalid execution mode");
  const ceiling = loaded.policy?.resources?.network ?? [];
  const network = value.network.map((group) =>
    (group.includes("*") ? ceiling : group.map(canonicalizeHost)).filter((host) =>
      networkScopeWithin(host, ceiling),
    ),
  );
  if (network.some((group) => !group.length))
    return { write: value.write && loaded.limits?.write !== false, network: [] };
  return {
    write: value.write && loaded.limits?.write !== false,
    network: loaded.limits?.network === false ? [] : network,
  };
}
export function assertPermissions(value: ExecutionPermissions, loaded: LoadedPolicy): void {
  const bounded = normalizePermissions(value, loaded);
  if (JSON.stringify(value) !== JSON.stringify(bounded))
    throw Error("execution permissions exceed hard limits");
}
export function requestedNetwork(value: unknown, loaded: LoadedPolicy): string[] {
  if (!Array.isArray(value) || value.some((host) => typeof host !== "string"))
    throw Error("permissions.network must be an array of hosts");
  const hosts = [...new Set(value.map(canonicalizeHost))];
  if (
    (hosts.length > 0 && loaded.limits?.network === false) ||
    hosts.some((host) => !networkScopeWithin(host, loaded.policy?.resources?.network ?? []))
  )
    throw Error("requested network access exceeds hard limits");
  return hosts;
}

export function networkAllows(hosts: string[], url: URL): boolean {
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return hosts.some((item) => {
    if (item === "*") return true;
    const host = canonicalizeHost(item),
      rule = new URL(`http://${host}`);
    const explicit = host.startsWith("[") ? /\]:(\d+)$/.exec(host)?.[1] : /:(\d+)$/.exec(host)?.[1];
    return (
      rule.hostname === url.hostname &&
      (explicit ? Number(explicit) === port : port === 80 || port === 443)
    );
  });
}
export const permitsNetwork = (permissions: ExecutionPermissions, url: URL) =>
  permissions.network.length > 0 && permissions.network.every((group) => networkAllows(group, url));

export function networkScopeWithin(host: string, ceiling: string[]): boolean {
  if (host === "*") return ceiling.includes("*");
  const explicit = host.startsWith("[") ? /\]:(\d+)$/.exec(host)?.[1] : /:(\d+)$/.exec(host)?.[1];
  return explicit
    ? networkAllows(ceiling, new URL(`http://${host}`))
    : networkAllows(ceiling, new URL(`http://${host}`)) &&
        networkAllows(ceiling, new URL(`https://${host}`));
}
