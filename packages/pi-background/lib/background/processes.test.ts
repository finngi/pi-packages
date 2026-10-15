import assert from "node:assert/strict";
import test from "node:test";
import {
  BackgroundProcesses,
  type LaunchSpec,
  OutputBuffer,
  outputPreview,
} from "pi-runtime/processes";
import { MAX_NODE_TIMER_DELAY_MS } from "pi-runtime/timers";

const spec = (script: string, extras: Partial<LaunchSpec> = {}): LaunchSpec => ({
  command: process.execPath,
  args: ["-e", script],
  cwd: process.cwd(),
  owner: "fixture",
  label: "fixture",
  ...extras,
});
const wait = async (fn: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out");
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("real process stdin request/reply, stderr, EOF and byte cursors", async () => {
  const manager = new BackgroundProcesses();
  try {
    const run = manager.launch(
      spec(
        "const r=require('node:readline').createInterface({input:process.stdin}); console.log('ready');r.on('line',s=>{console.log('reply:'+s);console.error('err:'+s)});",
        { stdin: "pipe" },
      ),
    );
    await wait(() => manager.status(run.id).outputBytes > 0);
    const first = manager.read(run.id);
    assert.match(outputPreview(first), /ready/);
    await manager.write(run.id, Buffer.from("hello\n"));
    await wait(() =>
      manager
        .read(run.id, first.nextCursor)
        .chunks.some(
          (chunk) => chunk.stream === "stdout" && chunk.data.includes(Buffer.from("reply:hello")),
        ),
    );
    await wait(() =>
      manager
        .read(run.id, first.nextCursor)
        .chunks.some(
          (chunk) => chunk.stream === "stderr" && chunk.data.includes(Buffer.from("err:hello")),
        ),
    );
    await wait(() => manager.status(run.id).outputBytes > first.nextCursor + 10);
    const second = manager.read(run.id, first.nextCursor);
    assert.match(outputPreview(second), /reply:hello/);
    assert.match(outputPreview(second), /err:hello/);
    await manager.write(run.id, Buffer.alloc(0), true);
    const done = await run.done;
    assert.equal(done.status, "completed");
    assert(done.streamsClosed);
    await assert.rejects(manager.write(run.id, Buffer.from("late")), /closed/);
  } finally {
    await manager.close();
  }
});

test("retained output reports gaps and preserves byte limits", async () => {
  const manager = new BackgroundProcesses({ outputBytes: 256 });
  const run = manager.launch(spec("process.stdout.write('x'.repeat(10000)+'tail');"));
  await run.done;
  const read = manager.read(run.id, 0, 128);
  assert(read.gap);
  assert.equal(read.retainedFrom, 9748);
  assert.equal(
    read.chunks.reduce((n, c) => n + c.data.length, 0),
    128,
  );
  const tail = manager.read(run.id, read.nextCursor, 128);
  assert.match(outputPreview(tail), /tail/);
  assert.equal(tail.nextCursor, 10004);
  assert.throws(() => manager.read(run.id, 10005), /beyond/);
  await manager.close();
});

test("rejects timeout values outside the Node timer range before spawning", async () => {
  const manager = new BackgroundProcesses();
  assert.throws(
    () => manager.launch(spec("process.exit(0)", { timeoutMs: MAX_NODE_TIMER_DELAY_MS + 1 })),
    /no greater than 2147483647 ms/,
  );
  assert.throws(
    () => new BackgroundProcesses({ writeMs: MAX_NODE_TIMER_DELAY_MS + 1 }),
    /writeMs must be between 0 and 2147483647 ms/,
  );
  const run = manager.launch(spec("process.exit(0)", { timeoutMs: MAX_NODE_TIMER_DELAY_MS }));
  assert.equal((await run.done).status, "completed");
  await manager.close();
});

test("rejects invalid output and input capacities when the session is created", () => {
  for (const outputBytes of [0, -1, 1.5, Number.POSITIVE_INFINITY])
    assert.throws(
      () => new BackgroundProcesses({ outputBytes }),
      /outputBytes.*positive safe integer/,
    );
  for (const inputBytes of [0, -1, 1.5, Number.NaN])
    assert.throws(
      () => new BackgroundProcesses({ inputBytes }),
      /inputBytes.*positive safe integer/,
    );
});

test("rejects invalid concurrency and retention limits when the session is created", () => {
  for (const concurrent of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(
      () => new BackgroundProcesses({ concurrent }),
      /concurrent.*positive safe integer/,
    );
  for (const retained of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new BackgroundProcesses({ retained }), /retained.*positive safe integer/);
});

test("invalid timeout does not evict retained process history", async () => {
  const manager = new BackgroundProcesses({ retained: 1 });
  const run = manager.launch(spec("process.exit(0)"));
  assert.equal((await run.done).status, "completed");
  assert.throws(
    () => manager.launch(spec("process.exit(0)", { timeoutMs: MAX_NODE_TIMER_DELAY_MS + 1 })),
    /no greater than 2147483647 ms/,
  );
  assert.equal(manager.status(run.id).status, "completed");
  await manager.close();
});

test("UTF-8 split across stream data events remains intact in complete preview", async () => {
  const manager = new BackgroundProcesses();
  const run = manager.launch(
    spec(
      "const b=Buffer.from('😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30);",
    ),
  );
  await run.done;
  assert.equal(outputPreview(manager.read(run.id)), "[stdout] 😀");
  await manager.close();
});

test("fragmented writes stay bounded and coalesce into a single retained stream chunk", () => {
  const capacity = 16 * 1024 * 1024;
  const bytesWritten = 100_000;
  const output = new OutputBuffer(capacity);
  const byte = Buffer.from("x");
  for (let i = 0; i < bytesWritten; i++) output.append("stdout", byte);

  const read = output.read(0, bytesWritten);
  assert.equal(read.chunks.length, 1);
  assert.equal(read.chunks[0].data.length, bytesWritten);
  assert.equal(read.chunks[0].data[0], 0x78);
  assert.equal(read.chunks[0].data.at(-1), 0x78);
  assert.equal(read.retainedFrom, 0);
  const allocated = output as unknown as { data: Buffer; stderrBits: Uint8Array };
  assert.ok(allocated.data.byteLength < capacity / 100);
  assert.ok(allocated.stderrBits.byteLength < capacity / 100);
});

test("large stream ranges retain mixed-stream metadata across ring wrap", () => {
  const capacity = 64 * 1024;
  const output = new OutputBuffer(capacity);
  output.append("stdout", Buffer.alloc(capacity - 4, 0x61));
  output.append("stderr", Buffer.from("er"));
  output.append("stdout", Buffer.from("tail-wrap!"));

  const read = output.read(0, capacity);
  assert.equal(read.gap, true);
  assert.deepEqual(
    read.chunks.map(({ stream, start, end }) => [stream, end - start]),
    [
      ["stdout", capacity - 12],
      ["stderr", 2],
      ["stdout", 10],
    ],
  );
  assert.equal(read.chunks.at(-1)?.data.toString(), "tail-wrap!");
});

test("output preview preserves interleaved stream order across ring wrap and gaps", () => {
  const output = new OutputBuffer(5);
  output.append("stdout", Buffer.from("ab"));
  output.append("stderr", Buffer.from("C"));
  output.append("stdout", Buffer.from("de"));
  output.append("stderr", Buffer.from("F"));

  const read = output.read(0, 5);
  assert.equal(read.gap, true);
  assert.equal(read.retainedFrom, 1);
  assert.equal(outputPreview(read), "[stdout] b\n[stderr] C\n[stdout] de\n[stderr] F");
  assert.deepEqual(
    read.chunks.map(({ stream, start, end }) => [stream, start, end]),
    [
      ["stdout", 1, 2],
      ["stderr", 2, 3],
      ["stdout", 3, 5],
      ["stderr", 5, 6],
    ],
  );
});

test("output buffer rejects invalid capacities and preserves split UTF-8 bytes", () => {
  assert.throws(() => new OutputBuffer(0), /positive safe integer/);
  assert.throws(() => new OutputBuffer(Number.POSITIVE_INFINITY), /positive safe integer/);
  const output = new OutputBuffer(8);
  const encoded = Buffer.from("😀");
  for (const byte of encoded) output.append("stdout", Buffer.from([byte]));
  assert.equal(outputPreview(output.read(0, 8)), "[stdout] 😀");
});

test("output preview keeps split UTF-8 intact when another stream completes first", () => {
  const output = new OutputBuffer(8);
  const encoded = Buffer.from("😀");
  output.append("stdout", encoded.subarray(0, 2));
  output.append("stderr", Buffer.from("x"));
  output.append("stdout", encoded.subarray(2));

  assert.equal(outputPreview(output.read(0, 8)), "[stderr] x\n[stdout] 😀");
});

test("output preview replaces a truncated UTF-8 sequence instead of dropping it", () => {
  const output = new OutputBuffer(8);
  output.append("stdout", Buffer.from([0xf0, 0x9f]));

  assert.equal(outputPreview(output.read(0, 8)), "[stdout] �");
});

test("write deadline closes transport instead of releasing an indefinitely queued reservation", async () => {
  const manager = new BackgroundProcesses({ writeMs: 20, killGraceMs: 20 });
  const run = manager.launch(spec("setInterval(()=>{},1000)", { stdin: "pipe" }));
  let failed = false;
  for (let i = 0; i < 16; i++) {
    try {
      await manager.write(run.id, Buffer.alloc(65536));
    } catch {
      failed = true;
      break;
    }
  }
  assert(failed);
  await assert.rejects(manager.write(run.id, Buffer.alloc(65536)), /closed/);
  assert.equal((await run.done).status, "cancelled");
  await manager.close();
});

test("cancel stops TERM-resistant grandchildren in the owned process group", async () => {
  const manager = new BackgroundProcesses({ killGraceMs: 40 });
  const childScript = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const run = manager.launch(
    spec(
      `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000);`,
    ),
  );
  await wait(() => manager.status(run.id).outputBytes > 0);
  const pid = Number(manager.read(run.id).chunks[0].data.toString().trim());
  assert(alive(pid));
  manager.cancel(run.id);
  assert.equal((await run.done).status, "cancelled");
  await wait(() => !alive(pid));
  await manager.close();
});

test("normal leader exit cleans descendants even if they closed inherited output pipes", async () => {
  const manager = new BackgroundProcesses();
  const run = manager.launch(
    spec(
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();",
    ),
  );
  await run.done;
  const pid = Number(manager.read(run.id).chunks[0].data.toString().trim());
  await wait(() => !alive(pid));
  await manager.close();
});

test("inherited grandchild pipes have a bounded output drain deadline", async () => {
  const manager = new BackgroundProcesses({ drainMs: 30 });
  const run = manager.launch(
    spec(
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});console.log(c.pid);c.unref();",
    ),
  );
  const done = await run.done;
  assert(done.executionExited);
  assert.match(done.reason ?? "", /drain deadline/);
  await manager.close();
});

test("spawn error completes once, synchronous codec errors cannot block teardown", async () => {
  const manager = new BackgroundProcesses();
  let calls = 0;
  const missing = manager.launch(
    spec("", {
      command: "/no-such-background-process",
      onComplete: () => {
        calls++;
        return { text: "failure" };
      },
    }),
  );
  const missingResult = await missing.done;
  assert.equal(missingResult.status, "failed");
  assert.equal(missingResult.executionExited, true);
  assert.equal(missingResult.streamsClosed, true);
  assert.match(missingResult.reason ?? "", /ENOENT/);
  assert.deepEqual(manager.status(missing.id), missingResult);
  await manager.close();
  assert.equal(calls, 1);
  const other = new BackgroundProcesses();
  const run = other.launch(spec("", { onComplete: (() => new Promise(() => {})) as any }));
  assert.equal((await run.done).status, "failed");
  assert.match(other.status(run.id).reason ?? "", /synchronously/);
  const rejected = other.launch(
    spec("", {
      onComplete: (() => Promise.reject(new Error("late codec failure"))) as any,
    }),
  );
  assert.equal((await rejected.done).status, "failed");
  await new Promise((r) => setTimeout(r, 20));
  await other.close();
});

test("a post-spawn process error settles without falsely claiming the child exited", async () => {
  const manager = new BackgroundProcesses({ killGraceMs: 20 });
  const run = manager.launch(spec("setInterval(() => {}, 1000)"));
  const processObject = (manager as any).jobs.get(run.id).process;
  try {
    await wait(() => processObject.pid !== undefined && (manager as any).jobs.get(run.id).spawned);
    processObject.emit(
      "error",
      Object.assign(new Error("simulated kill failure"), { code: "EPERM" }),
    );
    const done = await run.done;
    assert.equal(done.status, "failed");
    assert.equal(done.executionExited, false);
    assert.equal(done.streamsClosed, false);
    assert.match(done.reason ?? "", /did not produce a close event/);
  } finally {
    if (processObject.pid) {
      try {
        process.kill(processObject.pid, "SIGKILL");
      } catch {}
    }
    await manager.close();
  }
});

test("concurrency, result caps, retained IDs and session teardown are bounded", async () => {
  const manager = new BackgroundProcesses({ concurrent: 1, retained: 2 });
  const active = manager.launch(spec("setInterval(()=>{},1000)"));
  assert.throws(() => manager.launch(spec("")), /At most 1/);
  manager.cancel(active.id);
  await active.done;
  const second = manager.launch(
    spec("", { onComplete: () => ({ text: "x".repeat(4 * 1024 * 1024 + 1) }) }),
  );
  assert.match((await second.done).result?.text ?? "", /truncated/);
  const third = manager.launch(spec(""));
  await third.done;
  assert.throws(() => manager.status(active.id), /Unknown/);
  await manager.close();
  assert.throws(() => manager.status(third.id), /Unknown/);
  assert.throws(() => manager.launch(spec("")), /closed/);
});

test("a failed parser is disabled while a TERM-resistant producer is drained and cancelled once", async () => {
  const manager = new BackgroundProcesses({ killGraceMs: 40 });
  let calls = 0;
  const run = manager.launch(
    spec(
      "process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(65536)),1);",
      {
        onData: () => {
          calls++;
          throw new Error("protocol limit");
        },
      },
    ),
  );
  const done = await run.done;
  assert.equal(done.status, "cancelled");
  assert.equal(calls, 1);
  assert.match(done.reason ?? "", /protocol limit/);
  await manager.close();
});

test("default budgets retain substantial output and interpreted answers", async () => {
  const manager = new BackgroundProcesses();
  const bytes = 256 * 1024;
  const run = manager.launch(
    spec(`process.stdout.write('x'.repeat(${bytes}))`, {
      onComplete: () => ({ text: "y".repeat(bytes) }),
    }),
  );
  const done = await run.done;
  assert.equal(done.retainedFrom, 0);
  assert.equal(done.outputBytes, bytes);
  assert.equal(done.result?.text?.length, bytes);
  const read = manager.read(run.id, 0, bytes);
  assert.equal(read.gap, false);
  assert.equal(Buffer.concat(read.chunks.map((chunk) => chunk.data)).length, bytes);
  assert.equal(manager.limits.inputBytes, 16 * 1024 * 1024);
  assert.equal(manager.limits.writeMs, 30000);
  await manager.close();
});

test("default input budget delivers a payload above the previous cap", async () => {
  const manager = new BackgroundProcesses();
  const bytes = 256 * 1024;
  const run = manager.launch(
    spec(
      "let count=0;process.stdin.on('data',data=>count+=data.length);process.stdin.on('end',()=>console.log(count));",
      { stdin: "pipe" },
    ),
  );
  await manager.write(run.id, Buffer.alloc(bytes, 120), true);
  assert.equal((await run.done).status, "completed");
  assert.equal(
    Buffer.concat(manager.read(run.id).chunks.map((chunk) => chunk.data))
      .toString()
      .trim(),
    String(bytes),
  );
  await manager.close();
});

test("four agents leave shell capacity available and each pool enforces its own limit", async () => {
  const manager = new BackgroundProcesses({ concurrent: 1, concurrentAgents: 4 });
  try {
    const agents = Array.from({ length: 4 }, () =>
      manager.launch(spec("setInterval(()=>{},1000)", { owner: "subagent" })),
    );
    assert.throws(() => manager.launch(spec("", { owner: "subagent" })), /At most 4 subagents/);
    const shell = manager.launch(spec("console.log('parent remains responsive')"));
    assert.throws(() => manager.launch(spec("")), /At most 1 shell commands/);
    assert.equal((await shell.done).exitCode, 0);
    assert.match(outputPreview(manager.read(shell.id)), /parent remains responsive/);
    for (const agent of agents) manager.cancel(agent.id);
  } finally {
    await manager.close();
  }
});
