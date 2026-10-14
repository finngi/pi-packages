import type {
  LoadedPolicy,
  PreparedChild,
  Decision,
  ToolCall,
  AskContext,
  RpcSelect,
} from "./types.ts";
const prefix = "pi-security-ask:v1:";
const denied = (decision: Decision): Decision => ({
  verdict: "deny",
  ruleIds: decision?.ruleIds ?? [],
  reason: "child ask denied or invalid",
});
const choices = () => ["Allow", "Deny"];
export async function forwardChildAsk({
  call,
  decision,
  childLoaded,
  ctx,
}: {
  call: ToolCall;
  decision: Decision;
  childLoaded: LoadedPolicy;
  ctx?: AskContext;
}): Promise<Decision> {
  if (!childLoaded.launchId || typeof ctx?.ui?.select !== "function" || !ctx.hasUI)
    return denied(decision);
  const frame = {
    version: 1,
    launchId: childLoaded.launchId,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    cwd: childLoaded.project,
  };
  const title = prefix + JSON.stringify(frame);
  if (Buffer.byteLength(title) > 16384) return denied(decision);
  const options = choices();
  try {
    const result = await ctx.ui.select(title, options);
    if (result === "Deny" || !options.includes(result ?? "")) return denied(decision);
    return {
      verdict: "allow",
      ruleIds: decision.ruleIds ?? [],
      permissions: decision.permissions,
      reason: "parent approved",
      writeGrants: decision.writeGrants,
    };
  } catch {
    return denied(decision);
  }
}
export async function handleChildAsk({
  request,
  launch,
  parentCheck,
  parentResolve,
}: {
  request: RpcSelect;
  launch?: PreparedChild;
  parentCheck: (call: ToolCall, launch: PreparedChild) => Promise<Decision>;
  parentResolve: (call: ToolCall, decision: Decision, launch: PreparedChild) => Promise<Decision>;
}) {
  const response = { type: "extension_ui_response", id: request?.id, value: "Deny" };
  if (
    !request ||
    typeof request.id !== "string" ||
    request.method !== "select" ||
    typeof request.title !== "string" ||
    !request.title.startsWith(prefix) ||
    Buffer.byteLength(request.title) > 16384 ||
    !launch?.live
  )
    return response;
  try {
    const frame = JSON.parse(request.title.slice(prefix.length));
    if (
      Object.keys(frame).sort().join(",") !== "cwd,input,launchId,toolCallId,toolName,version" ||
      frame.version !== 1 ||
      frame.launchId !== launch.id ||
      frame.cwd !== launch.cwd ||
      typeof frame.toolCallId !== "string" ||
      typeof frame.toolName !== "string" ||
      !frame.input ||
      typeof frame.input !== "object" ||
      Array.isArray(frame.input)
    )
      return response;
    launch.askSeen ??= new Set();
    if (launch.askSeen.has(frame.toolCallId) || launch.askSeen.has("rpc:" + request.id))
      return response;
    launch.askSeen.add(frame.toolCallId);
    launch.askSeen.add("rpc:" + request.id);
    if (JSON.stringify(request.options) !== JSON.stringify(choices())) return response;
    const call = {
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      input: frame.input,
      cwd: launch.cwd,
    };
    const checked = await parentCheck(call, launch);
    if (!checked || checked.verdict === "deny") return response;
    const decision = await parentResolve(call, { ...checked, verdict: "ask" }, launch);
    if (!launch.live || decision?.verdict !== "allow" || !decision.permissions) return response;
    response.value = "Allow";
    return response;
  } catch {
    return response;
  }
}
