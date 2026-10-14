import { test } from "node:test";
import assert from "node:assert/strict";
import { Bindings, decide } from "../../src/gate.ts";
import { createSearchCapabilities } from "../../src/search-capability.ts";
const url = "https://chatgpt.com/backend-api/codex/responses";
test("search capability binds call input, exact origin/path, network authority and lifecycle", async () => {
  const bindings = new Bindings(),
    input = { query: "fixture" };
  const loaded = { policy: { resources: { network: ["chatgpt.com"] } } };
  const service = createSearchCapabilities({ bindings, getLoaded: () => loaded });
  const bind = (id, network = [["chatgpt.com"]]) =>
    bindings.put(id, "codex_search", input, { permissions: { write: false, network } });
  bind("low", []);
  assert.throws(() => service.prepareSearch({ toolCallId: "low", input }), /network/);
  bindings.put("narrow", "codex_search", input, {
    permissions: { write: false, network: [["other.example"]] },
  });
  assert.throws(() => service.prepareSearch({ toolCallId: "narrow", input }), /network permission/);
  bindings.put("empty", "codex_search", input, { permissions: { write: false, network: [] } });
  assert.throws(() => service.prepareSearch({ toolCallId: "empty", input }), /network permission/);
  bind("first");
  const abort = new AbortController(),
    cap = service.prepareSearch({ toolCallId: "first", input, signal: abort.signal });
  await assert.rejects(
    cap.dispatch({ query: "different" }, url, () => {}),
    /input differs/,
  );
  bindings.put("first", "codex_search", input, {
    permissions: { write: false, network: [["chatgpt.com"]] },
  });
  assert.throws(() => service.prepareSearch({ toolCallId: "first", input }), /duplicate/);
  let called = 0;
  for (const address of [
    "http://chatgpt.com/backend-api/codex/responses",
    "https://evil.invalid/backend-api/codex/responses",
    "https://chatgpt.com/other",
    "https://chatgpt.com/backend-api/codex/responses?x=1",
    "https://user@chatgpt.com/backend-api/codex/responses",
    "https://chatgpt.com/backend-api/codex/models?client_version=x&other=y",
  ])
    await assert.rejects(
      cap.dispatch(input, address, () => called++),
      /destination/,
    );
  assert.equal(called, 0);
  assert.equal(
    await cap.dispatch(
      input,
      "https://chatgpt.com/backend-api/codex/models?client_version=1.1.0",
      (signal) => {
        assert.equal(signal, cap.signal);
        return "ok";
      },
    ),
    "ok",
  );
  abort.abort();
  assert.equal(cap.signal.aborted, true);
  await assert.rejects(
    cap.dispatch(input, url, () => called++),
    /expired/,
  );
  bind("second");
  const second = service.prepareSearch({ toolCallId: "second", input });
  let finish;
  const pending = second.dispatch(input, url, () => new Promise((resolve) => (finish = resolve)));
  service.close();
  finish("late");
  await assert.rejects(pending, /expired/);
  assert.equal(second.signal.aborted, true);
  bind("third");
  assert.throws(() => service.prepareSearch({ toolCallId: "third", input }), /unavailable/);
});
test("host refusal consumes binding and owner replacement revokes outstanding dispatch", async () => {
  const bindings = new Bindings(),
    input = { query: "fixture" };
  let loaded = { policy: { resources: { network: [] } } };
  const service = createSearchCapabilities({ bindings, getLoaded: () => loaded });
  bindings.put("a", "codex_search", input, {
    permissions: { write: false, network: [["chatgpt.com"]] },
  });
  assert.throws(() => service.prepareSearch({ toolCallId: "a", input }), /network permission/);
  assert.throws(() => service.prepareSearch({ toolCallId: "a", input }), /differs/);
  loaded.policy.resources.network.push("chatgpt.com");
  bindings.put("b", "codex_search", input, {
    permissions: { write: false, network: [["chatgpt.com"]] },
  });
  const cap = service.prepareSearch({ toolCallId: "b", input });
  loaded = structuredClone(loaded);
  assert.throws(() => cap.assertCurrent(input), /expired/);
  assert.equal(cap.signal.aborted, true);
  cap.release();
});

test("fixed-origin requests remain inside the configured host ceiling", () => {
  const loaded = {
    policy: {
      deny: [],
      resources: { network: ["other.example"] },
      allow: [
        {
          id: "search",
          tool: "codex_search",
          permissions: { write: false, network: ["other.example"] },
        },
      ],
    },
  };
  assert.equal(
    decide("codex_search", { query: "fixture" }, loaded).verdict,
    "deny",
    "fixed-origin host is outside the hard ceiling",
  );
});
