import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function securityFailure(reason: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `pi-security: ${reason}` }],
    isError: true,
    details: undefined,
  };
}
