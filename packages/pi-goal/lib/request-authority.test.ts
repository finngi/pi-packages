import assert from "node:assert/strict";
import test from "node:test";
import { GoalRequests } from "./usage.ts";

test("main request correlation survives shallow copies without changing serialized history", () => {
  const requests = new GoalRequests();
  const controller = new AbortController();
  const messages = [{ role: "user", content: "Continue the real task", timestamp: 0 }];
  const request = requests.prepare(undefined, "session", "branch", controller.signal);
  const bound = requests.bind(messages, request);
  assert.equal(JSON.stringify(bound), JSON.stringify(messages));
  assert.equal(requests.find(bound, "session", controller.signal), request);
  assert.equal(
    requests.find(
      bound.map((message) => ({ ...message })),
      "session",
      controller.signal,
    ),
    request,
  );
  assert.equal(requests.find(bound, "another-session", controller.signal), undefined);
  assert.equal(requests.find(bound, "session", new AbortController().signal), undefined);
  assert.equal(requests.find(messages, "session", controller.signal), undefined);
  requests.dispatch(request);
  assert.throws(() => requests.dispatch(request), /consumed/);
  assert.equal(requests.takeResponse(), request);
  assert.equal(requests.takeResponse(), undefined);
  requests.prepare(undefined, "session", "branch", controller.signal);
  assert.equal(requests.find(bound, "session", controller.signal), undefined);
});
