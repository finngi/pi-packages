import assert from "node:assert/strict";
import test from "node:test";
import { messageParameters, registerChildMessaging } from "./child-messaging.ts";
import { MESSAGE_BRIDGE } from "./messages.ts";

test("bound child tool advertises categories and stamps origin at emission, outside public inputs", async () => {
  const tools = new Map<string, any>();
  const frames: any[] = [];
  registerChildMessaging({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    id: "agent-access-action-active",
    name: "fixture",
    parentId: "agent-bright-brown-butter",
    parentName: "main",
    workspace: "/fixture",
  });
  assert.equal(tools.get("agent_message").parameters, messageParameters);
  assert(messageParameters.properties.kind);
  assert(!("emittedAt" in messageParameters.properties));
  const before = Date.now();
  const result = await tools
    .get("agent_message")
    .execute(
      "tool",
      { to: "agent-bright-brown-butter", message: "routine", kind: "progress" },
      undefined,
      undefined,
      {
        ui: {
          select: async (title: string) => {
            frames.push(JSON.parse(title.slice(MESSAGE_BRIDGE.length)));
            return JSON.stringify({ accepted: true, message_id: "receipt" });
          },
        },
      },
    );
  assert.equal(result.details.accepted, true);
  assert.equal(frames[0].kind, "progress");
  assert.equal(frames[0].mode, "steer");
  assert(
    Date.parse(frames[0].emittedAt) >= before && Date.parse(frames[0].emittedAt) <= Date.now(),
  );
});
