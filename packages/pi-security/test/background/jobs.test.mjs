import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBackgroundJobs } from "../../src/background-jobs.ts";
import { wrapShell } from "../../src/wrap-shell.ts";
import { loadPolicy } from "../../src/policy.ts";
import { policy } from "../skeleton/fixture.mjs";
test("background wrapShell writes own scope, refuses outside, retains lease and cancels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-security-background-")),
    saved = { ...process.env };
  let jobs;
  try {
    const project = path.join(root, "project"),
      tmp = path.join(root, "tmp"),
      home = path.join(root, "home");
    await Promise.all([project, tmp, home].map((p) => mkdir(p)));
    Object.assign(process.env, { HOME: home, TMPDIR: tmp + "/" });
    const file = path.join(root, "policy.json");
    await writeFile(file, JSON.stringify(policy()));
    const loaded = await loadPolicy(file, { project, tmp });
    let releases = 0;
    jobs = createBackgroundJobs({
      prepare: async ({ command, decision }) => ({
        ...wrapShell(command, decision.permissions, loaded),
        release: async () => {
          releases++;
        },
      }),
    });
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    const one = await jobs.start({ command: "touch own-marker", cwd: project, decision });
    assert.equal(releases, 0);
    assert.equal((await one.done).exitCode, 0);
    assert.equal(await readFile(path.join(project, "own-marker"), "utf8"), "");
    assert.equal(releases, 1);
    const two = await jobs.start({
      command: `touch '${path.join(root, "outside-marker")}'`,
      cwd: project,
      decision,
    });
    const result = await two.done;
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /permitted|Permission/);
    await assert.rejects(readFile(path.join(root, "outside-marker")), { code: "ENOENT" });
    const three = await jobs.start({ command: "sleep 30", cwd: project, decision });
    assert.equal(jobs.status(three.id).state, "running");
    await jobs.cancel(three.id);
    assert.equal(jobs.status(three.id).state, "done");
    assert.equal(releases, 3);
    const controller = new AbortController();
    const four = await jobs.start({
      command: "sleep 0.2; printf retained > turn-abort-marker",
      cwd: project,
      decision,
      signal: controller.signal,
    });
    controller.abort();
    assert.equal(jobs.status(four.id).state, "running");
    assert.equal(releases, 3, "The process keeps its confinement lease after the turn ends");
    assert.equal((await four.done).exitCode, 0);
    assert.equal(await readFile(path.join(project, "turn-abort-marker"), "utf8"), "retained");
    assert.equal(releases, 4);
    assert.equal(jobs.list().length, 4);
    const five = await jobs.start({ command: "sleep 30", cwd: project, decision, timeout: 0.05 });
    assert.notEqual((await five.done).exitCode, 0, "Explicit timeout stops the owned process");
    assert.equal(releases, 5);
    await assert.rejects(
      jobs.start({ command: "sleep 30", cwd: project, decision, timeout: -1 }),
      /finite positive number/,
    );
    assert.throws(() => jobs.read("unknown"));
    console.log(JSON.stringify({ fixture: root, inside: true, outsideEPERM: true, releases }));
  } finally {
    await jobs?.close();
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
test("cancellation reaches pending preparation before a background process starts", async () => {
  const controller = new AbortController();
  let received;
  const jobs = createBackgroundJobs({
    prepare: ({ signal }) => {
      received = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    spawnProcess: () => {
      throw Error("cancelled preparation must not spawn");
    },
  });
  try {
    const pending = jobs.start({
      command: "true",
      cwd: process.cwd(),
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
      signal: controller.signal,
    });
    assert.equal(received, controller.signal);
    controller.abort();
    await assert.rejects(pending, /aborted/i);
  } finally {
    await jobs.close();
  }
});

test("abort after preparation releases and starts no process", async () => {
  const controller = new AbortController();
  let releases = 0;
  const jobs = createBackgroundJobs({
    prepare: async () => {
      controller.abort();
      return {
        release: () => {
          releases++;
        },
      };
    },
  });
  await assert.rejects(
    jobs.start({ command: "ignored", decision: { verdict: "allow" }, signal: controller.signal }),
    /aborted/,
  );
  assert.equal(releases, 1);
  await jobs.close();
});

test("a process close clears its pending timeout escalation", async () => {
  const child = fakeProcess();
  child.pid = 424242;
  const { root, jobs } = await backgroundFixture(undefined, () => child);
  const originalKill = process.kill;
  const signals = [];
  process.kill = (pid, signal) => {
    signals.push(signal);
    if (signal === "SIGTERM") setImmediate(() => finishProcess(child, 143));
    return true;
  };
  try {
    const job = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
      timeout: 0.01,
    });
    await job.done;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    process.kill = originalKill;
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("signal failures return bounded cancellation and shutdown results without releasing a live job", async () => {
  const child = fakeProcess();
  child.pid = 424243;
  let releases = 0;
  const { root, jobs } = await backgroundFixture(
    async () => ({
      profile: "(deny default)",
      argv: ["/bin/sh", "-c", "true"],
      sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
      env: { ...process.env, TMPDIR: root },
      profileRoot: root,
      release: () => {
        releases++;
      },
    }),
    () => child,
  );
  const originalKill = process.kill;
  const signals = [];
  process.kill = (_pid, signal) => {
    if (signal === "SIGTERM") signals.push(signal);
    if (signal === "SIGKILL") signals.push(signal);
    const error = new Error(`failed ${signal}`);
    error.code = "EPERM";
    throw error;
  };
  try {
    const job = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
      timeout: 0.01,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
    await assert.rejects(jobs.cancel(job.id), /is still running after cancellation/);
    assert.equal(jobs.status(job.id).state, "running");
    assert.equal(releases, 0, "the confinement lease stays active while the process lives");
    const pendingCleanup = jobs.whenIdle();
    assert.deepEqual(
      await jobs.close(),
      { activeJobs: [job.id], pendingStarts: 0 },
      "shutdown returns a bounded live-job report",
    );
    assert.equal(jobs.status(job.id).state, "running", "shutdown does not claim the job stopped");
    assert.equal(releases, 0, "shutdown does not release a live process lease");
    finishProcess(child, 143);
    const result = await job.done;
    await pendingCleanup;
    assert.match(result.stderr, /could not send SIGTERM: EPERM/);
    assert.match(result.stderr, /could not send SIGKILL: EPERM/);
    assert.equal(releases, 1, "the confinement lease releases after the process closes");
  } finally {
    process.kill = originalKill;
    finishProcess(child, 143);
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown signals live jobs while a second launch is still preparing", async () => {
  const child = fakeProcess();
  child.pid = 424246;
  let releasePreparation;
  let preparations = 0;
  const { root, jobs } = await backgroundFixture(
    async () => {
      preparations++;
      if (preparations === 2) await new Promise((resolve) => (releasePreparation = resolve));
      return {
        profile: "(deny default)",
        argv: ["/bin/sh", "-c", "true"],
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        env: { ...process.env, TMPDIR: root },
        profileRoot: root,
      };
    },
    () => child,
  );
  const originalKill = process.kill;
  const signals = [];
  process.kill = (_pid, signal) => {
    signals.push(signal);
    return true;
  };
  try {
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    const live = await jobs.start({ command: "true", cwd: root, decision });
    const pending = jobs.start({ command: "true", cwd: root, decision });
    const pendingFailure = assert.rejects(pending, /aborted/);
    await new Promise((resolve) => setImmediate(resolve));

    const startedAt = Date.now();
    assert.deepEqual(await jobs.close(), { activeJobs: [live.id], pendingStarts: 1 });
    assert.ok(Date.now() - startedAt < 1_500, "shutdown should stay within its time bound");
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(jobs.status(live.id).state, "running");

    releasePreparation();
    await pendingFailure;
    assert.equal(preparations, 2);
    assert.equal(jobs.list().length, 1, "the pending launch must not spawn after shutdown");
    finishProcess(child, 143);
    await live.done;
    await jobs.whenIdle();
  } finally {
    process.kill = originalKill;
    releasePreparation?.();
    finishProcess(child, 143);
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred cleanup waits for live jobs after another job cleanup rejects", async () => {
  const children = [];
  let preparations = 0;
  const { root, jobs } = await backgroundFixture(
    async () => {
      const index = preparations++;
      return {
        profile: "(deny default)",
        argv: ["/bin/sh", "-c", "true"],
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        env: { ...process.env, TMPDIR: root },
        profileRoot: root,
        release: () => {
          if (index === 0) throw new Error("fixture release failure");
        },
      };
    },
    () => {
      const child = fakeProcess();
      children.push(child);
      return child;
    },
  );
  try {
    const first = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
    });
    const second = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
    });
    const failedFirst = first.done.catch((error) => error);
    let idle = false;
    const waiting = jobs.whenIdle().then(() => {
      idle = true;
    });
    finishProcess(children[0]);
    assert.match((await failedFirst).message, /fixture release failure/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(idle, false, "a failed cleanup cannot hide a still-running job");
    finishProcess(children[1]);
    await second.done;
    await waiting;
    assert.equal(idle, true);
  } finally {
    for (const child of children) finishProcess(child);
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated cancellation cannot postpone the first escalation deadline", async () => {
  const child = fakeProcess();
  child.pid = 424244;
  const { root, jobs } = await backgroundFixture(undefined, () => child);
  const originalKill = process.kill;
  const signals = [];
  process.kill = (_pid, signal) => {
    signals.push({ signal, at: Date.now() });
    return true;
  };
  try {
    const job = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
    });
    const firstTermAt = Date.now();
    void jobs.cancel(job.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    void jobs.cancel(job.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const escalation = signals.find(({ signal }) => signal === "SIGKILL");
    assert.ok(escalation, "SIGKILL should be sent after the first TERM");
    assert.ok(escalation.at - firstTermAt < 260, "a repeated cancel must not reset the timer");
    finishProcess(child, 143);
    await job.done;
  } finally {
    process.kill = originalKill;
    finishProcess(child, 143);
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup diagnostics stay within the retained stderr cap", async () => {
  const child = fakeProcess();
  child.pid = 424245;
  const { root, jobs } = await backgroundFixture(undefined, () => child);
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error("x".repeat(300_000));
    error.code = "EPERM";
    throw error;
  };
  try {
    const job = await jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
    });
    void jobs.cancel(job.id);
    assert.ok(jobs.read(job.id).stderr.length <= 256 * 1024);
    finishProcess(child, 143);
    await job.done;
  } finally {
    process.kill = originalKill;
    finishProcess(child, 143);
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = () => true;
  return child;
}

function finishProcess(child, code = 0) {
  child.emit("close", code, null);
  child.stdout.end();
  child.stderr.end();
}

async function backgroundFixture(prepare, spawnProcess) {
  const root = await mkdtemp(path.join("/tmp", "pi-security-background-limits-"));
  const jobs = createBackgroundJobs({
    prepare:
      prepare ??
      (async () => ({
        profile: "(deny default)",
        argv: ["/bin/sh", "-c", "true"],
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        env: { ...process.env, TMPDIR: root },
        profileRoot: root,
      })),
    spawnProcess:
      spawnProcess ??
      (() => {
        const child = fakeProcess();
        setImmediate(() => finishProcess(child));
        return child;
      }),
  });
  return { root, jobs };
}

test("background admission rejects a fifth active job", async () => {
  const children = [];
  const { root, jobs } = await backgroundFixture(undefined, () => {
    const child = fakeProcess();
    children.push(child);
    return child;
  });
  try {
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    const running = await Promise.all(
      Array.from({ length: 4 }, () => jobs.start({ command: "true", cwd: root, decision })),
    );
    assert.equal(children.length, 4);
    await assert.rejects(
      jobs.start({ command: "true", cwd: root, decision }),
      /At most 4 background processes may run at once/,
    );
    for (const child of children) finishProcess(child);
    await Promise.all(running.map((job) => job.done));
    await jobs.close();
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background history prunes the oldest completed job at its retention limit", async () => {
  const { root, jobs } = await backgroundFixture();
  try {
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    let oldest;
    for (let index = 0; index < 33; index++) {
      const job = await jobs.start({ command: "true", cwd: root, decision });
      oldest ??= job.id;
      await job.done;
    }
    assert.equal(jobs.list().length, 32);
    assert.throws(() => jobs.status(oldest), /unknown background job/);
    assert.equal(jobs.list().at(-1).state, "done");
    await jobs.close();
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed background preparation preserves completed history", async () => {
  let failPreparation = false;
  const { root, jobs } = await backgroundFixture(async () => {
    if (failPreparation) throw Error("fixture preparation failed");
    return {
      profile: "(deny default)",
      argv: ["/bin/sh", "-c", "true"],
      sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
      env: { ...process.env, TMPDIR: root },
      profileRoot: root,
    };
  });
  try {
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    let oldest;
    for (let index = 0; index < 32; index++) {
      const job = await jobs.start({ command: "true", cwd: root, decision });
      oldest ??= job.id;
      await job.done;
    }
    failPreparation = true;
    await assert.rejects(
      jobs.start({ command: "true", cwd: root, decision }),
      /fixture preparation failed/,
    );
    assert.equal(jobs.status(oldest).state, "done");
    assert.equal(jobs.list().length, 32);
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background start reservations bound concurrent asynchronous preparation", async () => {
  let entered = 0;
  let allEntered;
  const enteredFour = new Promise((resolve) => {
    allEntered = resolve;
  });
  let releasePreparation;
  const preparationGate = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  const { root, jobs } = await backgroundFixture(async () => {
    entered++;
    if (entered === 4) allEntered();
    await preparationGate;
    return {
      profile: "(deny default)",
      argv: ["/bin/sh", "-c", "true"],
      sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
      env: { ...process.env, TMPDIR: root },
      profileRoot: root,
    };
  });
  try {
    const decision = { verdict: "allow", permissions: { write: true, network: [] } };
    const starts = Array.from({ length: 4 }, () =>
      jobs.start({ command: "true", cwd: root, decision }),
    );
    await enteredFour;
    await assert.rejects(
      jobs.start({ command: "true", cwd: root, decision }),
      /At most 4 background processes may run at once/,
    );
    assert.equal(entered, 4, "the rejected start did not begin preparation");
    releasePreparation();
    const running = await Promise.all(starts);
    await Promise.all(running.map((job) => job.done));
    await jobs.close();
  } finally {
    releasePreparation();
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("background close waits for held preparation, releases it, and refuses spawn", async () => {
  let enterPreparation;
  const preparationEntered = new Promise((resolve) => {
    enterPreparation = resolve;
  });
  let releasePreparation;
  const preparationGate = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  let releases = 0;
  let spawns = 0;
  const { root, jobs } = await backgroundFixture(
    async () => {
      enterPreparation();
      await preparationGate;
      return {
        profile: "(deny default)",
        argv: ["/bin/sh", "-c", "true"],
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        env: { ...process.env, TMPDIR: root },
        profileRoot: root,
        release: () => {
          releases++;
        },
      };
    },
    () => {
      spawns++;
      return fakeProcess();
    },
  );
  let start;
  try {
    start = jobs.start({
      command: "true",
      cwd: root,
      decision: { verdict: "allow", permissions: { write: true, network: [] } },
    });
    await preparationEntered;
    let closeSettled = false;
    const closing = jobs.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false, "close waits for an unresolved preparation");

    releasePreparation();
    await assert.rejects(start, /aborted/);
    await closing;
    assert.equal(closeSettled, true);
    assert.equal(spawns, 0, "shutdown prevents the prepared command from spawning");
    assert.equal(releases, 1, "shutdown releases the prepared confinement lease");
  } finally {
    releasePreparation();
    await start?.catch(() => {});
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent starts reserve distinct completed evictions and restore failed reservations", async () => {
  async function runCase(failingStart) {
    let preparationCount = 0;
    const entered = [0, 1].map(() => {
      let resolve;
      const promise = new Promise((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const gates = [0, 1].map(() => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    const { root, jobs } = await backgroundFixture(async () => {
      const call = preparationCount++;
      if (call >= 32 && call < 34) {
        const index = call - 32;
        entered[index].resolve();
        await gates[index].promise;
        if (index === failingStart) throw Error(`preparation ${index} failed`);
      }
      return {
        profile: "(deny default)",
        argv: ["/bin/sh", "-c", "true"],
        sandboxArgv: ["/usr/bin/bwrap", "--", "/bin/true"],
        env: { ...process.env, TMPDIR: root },
        profileRoot: root,
      };
    });
    try {
      const decision = { verdict: "allow", permissions: { write: true, network: [] } };
      const originalIds = [];
      for (let index = 0; index < 32; index++) {
        const job = await jobs.start({ command: "true", cwd: root, decision });
        originalIds.push(job.id);
        await job.done;
      }

      const starts = [0, 1].map(() => jobs.start({ command: "true", cwd: root, decision }));
      await Promise.all(entered.map(({ promise }) => promise));
      assert.equal(jobs.list().length, 32);
      assert.equal(jobs.status(originalIds[0]).state, "done");
      assert.equal(jobs.status(originalIds[1]).state, "done");

      gates[failingStart].release();
      await assert.rejects(starts[failingStart], new RegExp(`preparation ${failingStart} failed`));
      const successfulStart = 1 - failingStart;
      assert.equal(
        jobs.status(originalIds[failingStart]).state,
        "done",
        "a failed preparation retains its reserved completed record",
      );

      gates[successfulStart].release();
      const created = await starts[successfulStart];
      await created.done;
      assert.throws(() => jobs.status(originalIds[successfulStart]), /unknown background job/);
      assert.equal(jobs.status(originalIds[failingStart]).state, "done");
      assert.equal(jobs.list().length, 32);

      const afterFailure = await jobs.start({ command: "true", cwd: root, decision });
      await afterFailure.done;
      assert.throws(() => jobs.status(originalIds[failingStart]), /unknown background job/);
      assert.equal(jobs.list().length, 32);
    } finally {
      for (const gate of gates) gate.release();
      await jobs.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  await runCase(0);
  await runCase(1);
});

test("approved host background execution has no profile and retains cleanup and cancellation", async () => {
  let releases = 0;
  const jobs = createBackgroundJobs({
    prepare: async ({ command }) => ({
      execution: "host",
      profile: "",
      argv: ["/bin/bash", "--noprofile", "--norc", "-c", command],
      env: { PATH: "/usr/bin:/bin", TMPDIR: "/private/tmp" },
      release: () => {
        releases++;
      },
    }),
  });
  try {
    const decision = {
      verdict: "allow",
      permissions: { execution: "host", write: true, network: [["*"]] },
    };
    const one = await jobs.start({ command: "printf host-ready", cwd: "/private/tmp", decision });
    assert.equal((await one.done).stdout, "host-ready");
    assert.equal(releases, 1);
    const two = await jobs.start({ command: "sleep 30", cwd: "/private/tmp", decision });
    await jobs.cancel(two.id);
    assert.equal(jobs.status(two.id).state, "done");
    assert.equal(releases, 2);
    const three = await jobs.start({
      command: "sleep 30",
      cwd: "/private/tmp",
      decision,
      timeout: 0.05,
    });
    assert.notEqual((await three.done).exitCode, 0);
    assert.equal(releases, 3);
  } finally {
    await jobs.close();
  }
});
