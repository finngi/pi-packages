import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildLaunchContributionRequest } from "pi-contracts";
import { childLaunchContributions } from "../src/child-launch-contributions.ts";
import {
  savedInstructionContext,
  type SavedInstructionContextRequest,
} from "../src/saved-instruction-context.ts";

const context = {} as ExtensionContext;
test("saved child instructions have no parent-section fallback and propagate provider failures", () => {
  const read = (handler: (request: SavedInstructionContextRequest) => void) =>
    savedInstructionContext(
      {
        emit(_name, request) {
          handler(request as SavedInstructionContextRequest);
        },
      },
      context,
    );
  assert.equal(
    read(() => {}),
    undefined,
  );
  assert.equal(
    read((request) => request.contribute("")),
    "",
  );
  assert.equal(
    read((request) => request.contribute("SAVED_DEFAULTS")),
    "SAVED_DEFAULTS",
  );
  assert.throws(
    () => read((request) => request.reject("Saved settings unavailable")),
    /unavailable/,
  );
  assert.throws(
    () =>
      read((request) => {
        request.contribute("one");
        request.contribute("two");
      }),
    /Duplicate/,
  );
});

function collect(handler: (request: ChildLaunchContributionRequest) => void) {
  return childLaunchContributions(
    {
      emit(_name, value) {
        handler(value as ChildLaunchContributionRequest);
      },
    } as ExtensionAPI["events"],
    context,
  );
}

test("hook-only native extensions contribute one entrypoint and isolated configuration", () => {
  const configuration = JSON.stringify({
    policy: { mode: "auto" },
    userMessages: ["authorized task"],
  });
  const result = collect((request) => {
    assert.equal(request.ctx, context);
    request.contribute({
      extension: "/native/permissions.ts",
      env: { PI_CHILD_EXTENSION_PERMISSIONS: configuration },
    });
    request.contribute({
      extension: "/native/permissions.ts",
      env: { PI_CHILD_EXTENSION_PERMISSIONS: configuration },
    });
  });
  assert.deepEqual(result, {
    extensions: ["/native/permissions.ts"],
    env: { PI_CHILD_EXTENSION_PERMISSIONS: configuration },
  });
});

test("selected hooks can explicitly reject launch without relying on event-handler throws", () => {
  assert.throws(
    () => collect((request) => request.reject("permission policy is unavailable")),
    /policy is unavailable/,
  );
});

test("contributions cannot override launch bindings, conflict or supply malformed code sources", () => {
  for (const value of [
    { extension: "npm:must-not-install" },
    { extension: "/native/hook.ts", env: { PI_CODING_AGENT_DIR: "/outside" } },
    { extension: "/native/hook.ts", env: { PI_CHILD_EXTENSION_BAD: 2 } },
  ])
    assert.throws(
      () => collect((request) => request.contribute(value as never)),
      /Invalid|configuration may only/,
    );
  assert.throws(
    () =>
      collect((request) => {
        request.contribute({ extension: "/one.ts", env: { PI_CHILD_EXTENSION_POLICY: "one" } });
        request.contribute({ extension: "/two.ts", env: { PI_CHILD_EXTENSION_POLICY: "two" } });
      }),
    /Duplicate/,
  );
  const cyclic: any = { extension: "/native/hook.ts" };
  cyclic.self = cyclic;
  assert.throws(() => collect((request) => request.contribute(cyclic)), /Invalid/);
});
