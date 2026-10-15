import test from "node:test";
import assert from "node:assert/strict";
import { ResponseOffers } from "./owned-waiter.ts";
import type { OwnedWaiterOfferV1 } from "./owned-waiter.ts";
import { RpcDialogue } from "./rpc-dialogue.ts";
import type { BackgroundService } from "../background/service.ts";
function setup(accept = true) {
  let dialogue!: RpcDialogue, offer: OwnedWaiterOfferV1 | undefined;
  const writes: any[] = [],
    notifications: any[] = [];
  const service = {
    write: async (_id: string, bytes: Uint8Array) => {
      const request = JSON.parse(Buffer.from(bytes).toString());
      writes.push(request);
      queueMicrotask(() =>
        dialogue.data(
          "stdout",
          Buffer.from(
            JSON.stringify({
              type: "response",
              id: request.id,
              command: request.type,
              success: true,
              data: { disposition: "queued" },
            }) + "\n",
          ),
        ),
      );
    },
  } as unknown as BackgroundService;
  const offers = new ResponseOffers((_name, value) => {
    offer = value as OwnedWaiterOfferV1;
    offer.respond(
      accept
        ? {
            accepted: true,
            scope: { goalId: "goal", revision: 0, branchToken: "branch" },
            release() {},
          }
        : { accepted: false },
    );
  });
  dialogue = new RpcDialogue(
    service,
    "child",
    (reply) => {
      if (!offers.ownsReply("child", reply)) notifications.push(reply);
    },
    undefined,
    () => true,
    true,
  );
  const answer = () =>
    dialogue.data(
      "stdout",
      Buffer.from(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
          },
        }) + '\n{"type":"agent_settled","aborted":false}\n',
      ),
    );
  const start = () =>
    dialogue.start("task", (id) => offers.offer(dialogue, id, "session", "generation", () => true));
  return {
    dialogue,
    offers,
    writes,
    notifications,
    start,
    answer,
    get offer() {
      return offer!;
    },
  };
}
test("accepted producer offer resolves exact answer and suppresses independent wake", async () => {
  const f = setup();
  const ack = await f.start();
  f.answer();
  assert.equal((await f.offer.promise).deliveryKey, "generation:reply:1");
  assert.equal(f.notifications.length, 0);
  assert.deepEqual(f.dialogue.snapshot().replies[0].requestIds, [ack.requestId]);
  assert.throws(() => f.offer.respond({ accepted: false }), /synchronous/);
  f.dialogue.close();
  f.offers.clear();
});
test("released accepted ownership never falls back to standalone wake", async () => {
  const f = setup();
  await f.start();
  f.offers.releaseWorker("child");
  f.answer();
  await assert.rejects(f.offer.promise, /released/);
  assert.equal(f.notifications.length, 0);
  f.dialogue.close();
  f.offers.clear();
});
test("unanswered or rejected offer leaves normal notification intact", async () => {
  const f = setup(false);
  await f.start();
  f.answer();
  assert.equal(f.notifications.length, 1);
  await assert.rejects(f.offer.promise, /released/);
  f.dialogue.close();
  f.offers.clear();
});
test("stock transport uses message and follow_up, preserves exact steer request correlation", async () => {
  const f = setup(false);
  await f.start();
  const steer = await f.dialogue.message("steer text", "steer");
  const follow = await f.dialogue.message("follow text", "followUp");
  assert.deepEqual(
    f.writes.map((w) => w.type),
    ["prompt", "steer", "follow_up"],
  );
  assert.deepEqual(
    f.writes.map((w) => w.message),
    ["task", "steer text", "follow text"],
  );
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "first" }],
  };
  f.dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message })}\n${JSON.stringify({ type: "turn_end", message })}\n`,
    ),
  );
  const next = {
    role: "assistant",
    content: [{ type: "text", text: "second" }],
  };
  f.dialogue.data(
    "stdout",
    Buffer.from(
      `${JSON.stringify({ type: "message_end", message: next })}\n${JSON.stringify({ type: "turn_end", message: next })}\n{"type":"agent_settled","aborted":false}\n`,
    ),
  );
  const replies = f.dialogue.snapshot().replies;
  assert.deepEqual(replies[0].requestIds, [f.writes[0].id, steer.requestId]);
  assert.deepEqual(replies[1].requestIds, [follow.requestId]);
  f.dialogue.close();
  f.offers.clear();
});
