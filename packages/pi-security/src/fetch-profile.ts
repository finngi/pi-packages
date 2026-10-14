export function fetchProfileRules(lease?: { port: number }) {
  if (!lease || !Number.isInteger(lease.port) || lease.port < 1 || lease.port > 65535)
    throw Error("valid fetch lease required");
  return `(allow network-outbound (remote ip "localhost:${lease.port}"))\n(allow mach-lookup (global-name "com.apple.trustd.agent"))\n`;
}
