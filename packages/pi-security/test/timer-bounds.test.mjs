import assert from "node:assert/strict";
import test from "node:test";
import { MAX_NODE_TIMER_DELAY_MS } from "pi-runtime";
import { createBackgroundJobs } from "../src/background-jobs.ts";
import { shellOperations } from "../src/wrap-shell.ts";

test("secured foreground shell rejects a timeout Node would clamp", async () => {
  const operations = shellOperations({}, { write: false, network: [] });
  await assert.rejects(
    operations.exec("true", process.cwd(), {
      onData() {},
      timeout: MAX_NODE_TIMER_DELAY_MS / 1000 + 0.001,
    }),
    /no greater than 2147483\.647 seconds/,
  );
});

test("secured background jobs reject an oversized timeout before preparation", async () => {
  let prepareCalls = 0;
  let spawnCalls = 0;
  const jobs = createBackgroundJobs({
    async prepare() {
      prepareCalls++;
      throw Error("must not prepare an invalid timeout");
    },
    spawnProcess() {
      spawnCalls++;
      throw Error("must not spawn an invalid timeout");
    },
  });
  await assert.rejects(
    jobs.start({
      command: "true",
      cwd: process.cwd(),
      decision: { verdict: "allow" },
      timeout: MAX_NODE_TIMER_DELAY_MS / 1000 + 0.001,
    }),
    /no greater than 2147483\.647 seconds/,
  );
  assert.equal(prepareCalls, 0);
  assert.equal(spawnCalls, 0);
  await jobs.close();
});
