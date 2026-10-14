interface LaunchConfiguration {
  version: number;
  identity: string;
  mode: string;
  placement?: { kind: string; verified: boolean };
  allowedModes: string[];
  mcp: { name: string }[];
}
interface McpReceipt {
  version: number;
  identity: string;
  sessionGeneration: number;
  isCurrent(): boolean;
  connections: { name: string; state: string; identity: string; connectionGeneration: number }[];
}
export function launchOptions(env = process.env) {
  const activation = env.PI_SECURITY_ACTIVATION ?? "active";
  const placement = env.PI_SECURITY_PLACEMENT ?? "host";
  const transport = env.PI_SECURITY_TRANSPORT ?? "internal";
  if (
    !["active", "shadow"].includes(activation) ||
    !["host", "wall"].includes(placement) ||
    !["internal", "extensions"].includes(transport)
  )
    throw Error("invalid trusted security launch configuration");
  return { activation, placement, transport };
}
export function compatibility({
  placement,
  initialized,
}: {
  placement: string;
  initialized: () => boolean;
}) {
  let configured: LaunchConfiguration | undefined,
    generation = 0,
    epoch = 0,
    receipt: McpReceipt | undefined;
  const check = () => {
    if (!initialized()) throw Error("security initialization not ready");
  };
  return {
    version: 1,
    configureLaunch(value: LaunchConfiguration) {
      if (
        configured ||
        value?.version !== 1 ||
        typeof value.identity !== "string" ||
        !value.identity ||
        ![
          "sandbox",
          "auto",
          "contained",
          "manual",
          "full-access",
          "dangerously-unrestricted",
        ].includes(value.mode)
      )
        throw Error("invalid or repeated launch configuration");
      if (
        value.placement?.kind !== "container" ||
        value.placement.verified !== true ||
        placement !== "wall"
      )
        throw Error("container configuration requires preselected wall placement");
      if (
        !Array.isArray(value.allowedModes) ||
        !value.allowedModes.includes(value.mode) ||
        !Array.isArray(value.mcp)
      )
        throw Error("invalid launch modes or MCP selection");
      configured = structuredClone(value);
    },
    started() {
      generation++;
      epoch++;
      receipt = undefined;
    },
    async ready() {
      check();
      if (!configured) throw Error("launch not configured");
      if (configured.mcp.length && (!receipt || !receipt.isCurrent()))
        throw Error("MCP readiness missing or stale");
      return {
        version: 1,
        identity: configured.identity,
        mode: configured.mode,
        nativeReady: true,
        sessionGeneration: generation,
        policyEpoch: epoch,
        reviewer: "not-required",
      };
    },
    registerToolEffect() {},
    registerMcpToolDefinition<T>(definition: T) {
      return definition;
    },
    registerMcpResourceDefinition<T>(definition: T) {
      return definition;
    },
    mcpExecutionBoundary() {
      check();
      if (configured?.mcp.length && (!receipt || !receipt.isCurrent()))
        throw Error("MCP readiness stale");
    },
    getMcpBindingIdentity() {
      check();
      return { sessionGeneration: generation };
    },
    acknowledgeMcpReady(value: McpReceipt) {
      check();
      if (
        !configured ||
        value?.version !== 1 ||
        value.identity !== configured.identity ||
        value.sessionGeneration !== generation ||
        typeof value.isCurrent !== "function" ||
        !value.isCurrent() ||
        !Array.isArray(value.connections) ||
        configured.mcp.some(
          ({ name }) =>
            !value.connections.some(
              (c) =>
                c.name === name &&
                c.state === "connected" &&
                typeof c.identity === "string" &&
                Number.isSafeInteger(c.connectionGeneration),
            ),
        )
      )
        throw Error("invalid MCP readiness receipt");
      receipt = value;
    },
  };
}
