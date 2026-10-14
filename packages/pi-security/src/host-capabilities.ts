import type { HostCapability } from "./types.ts";
export function assertHostCapabilities(capabilities: readonly HostCapability[] = []) {
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((value) => !["gpu", "host-execution"].includes(value)) ||
    (capabilities.includes("gpu") && process.platform !== "darwin")
  )
    throw Error("unsupported host capability");
}
/** Launch configuration is trusted; model calls cannot select host device capabilities. */
export function hostCapabilitiesFromEnvironment(): HostCapability[] {
  const value = process.env.PI_SECURITY_HOST_CAPABILITIES;
  const capabilities = value ? (value.split(",") as HostCapability[]) : [];
  assertHostCapabilities(capabilities);
  return [...new Set(capabilities)];
}
