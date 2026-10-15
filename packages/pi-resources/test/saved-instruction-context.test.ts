import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  savedInstructionContext,
  type SavedInstructionContextRequest,
} from "../lib/saved-instruction-context.ts";

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
