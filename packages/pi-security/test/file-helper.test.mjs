import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function grepWith(fakeRg, source, t, context = 0) {
  const helperPath = fileURLToPath(new URL("../src/file-helper.ts", import.meta.url));
  const helper = spawn(process.execPath, [helperPath, fakeRg, "/usr/bin/false"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => helper.kill("SIGKILL"));
  let buffer = "",
    stderr = "",
    settled = false;
  const response = await new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(Error(`file helper response timeout; stderr: ${stderr || "(empty)"}`)),
      10000,
    );
    helper.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const frame = JSON.parse(line);
        if (frame.ready) {
          helper.stdin.write(
            `${JSON.stringify({
              id: 1,
              op: "grep",
              args: { path: source, pattern: "needle", literal: true, limit: 2, context },
            })}\n`,
          );
        } else if (frame.id === 1 && (frame.result !== undefined || frame.error)) {
          helper.stdin.end();
          finish(null, frame);
        }
      }
    });
    helper.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    helper.once("error", (error) => finish(error));
    helper.once("close", (code, signal) => {
      if (!settled)
        finish(
          Error(
            `file helper exited before response (code=${code}, signal=${signal}); stderr: ${stderr || "(empty)"}`,
          ),
        );
    });
  });
  return response;
}

async function fixture(t, script) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-file-helper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "matches.txt"),
    fakeRg = path.join(directory, "rg");
  await writeFile(source, "needle\n");
  const event = {
    type: "match",
    data: { path: { text: source }, line_number: 1, lines: { text: "needle\n" } },
  };
  await writeFile(fakeRg, script(event), { mode: 0o700 });
  return { source, fakeRg };
}

test("grep bounds subprocess output and reports when the search budget is reached", async (t) => {
  const f = await fixture(t, (event) =>
    [
      "#!/usr/bin/env node",
      'const { once } = require("node:events");',
      `const line = JSON.stringify(${JSON.stringify(event)}) + "\\n";`,
      '(async () => { for (;;) { if (!process.stdout.write(line)) await once(process.stdout, "drain"); } })();',
      "",
    ].join("\n"),
  );

  const response = await grepWith(f.fakeRg, f.source, t);

  assert.equal(response.error, undefined);
  assert.ok(response.result, JSON.stringify(response));
  assert.ok(response.result.details, JSON.stringify(response.result));
  assert.equal(response.result.details.matchLimitReached, 2);
  assert.match(response.result.content[0].text, /Search output limit reached/);
  assert.equal((response.result.content[0].text.match(/matches\.txt:\d+:/g) ?? []).length, 2);
});

test("grep reports ripgrep errors even when its output budget is reached", async (t) => {
  const f = await fixture(t, (event) =>
    [
      "#!/usr/bin/env node",
      'const { once } = require("node:events");',
      'process.stderr.write("synthetic ripgrep failure\\n");',
      `const line = JSON.stringify(${JSON.stringify(event)}) + "\\n";`,
      '(async () => { for (;;) { if (!process.stdout.write(line)) await once(process.stdout, "drain"); } })();',
      "",
    ].join("\n"),
  );

  const response = await grepWith(f.fakeRg, f.source, t);

  assert.match(response.error?.message ?? "", /synthetic ripgrep failure/);
  assert.equal(response.result, undefined);
});

test("grep skips oversized context files without loading them into memory", async (t) => {
  const f = await fixture(t, (event) =>
    [
      "#!/usr/bin/env node",
      `process.stdout.write(JSON.stringify(${JSON.stringify(event)}) + "\\n");`,
      "",
    ].join("\n"),
  );
  await writeFile(f.source, Buffer.alloc(300 * 1024, 97));

  const response = await grepWith(f.fakeRg, f.source, t, 1);

  assert.equal(response.error, undefined);
  assert.match(response.result.content[0].text, /matches\.txt:1: needle/);
  assert.match(response.result.content[0].text, /Context omitted for files exceeding/);
});

test(
  "stdin EOF aborts an active search process group before the helper exits",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-file-helper-close-"));
    const source = path.join(directory, "matches.txt");
    const fakeRg = path.join(directory, "rg");
    const pidFile = path.join(directory, "child.pid");
    const descendantPidFile = path.join(directory, "descendant.pid");
    const resistantChild = path.join(directory, "resistant-child.sh");
    await writeFile(source, "needle\n");
    await writeFile(
      resistantChild,
      `#!/bin/sh\necho $$ > '${descendantPidFile}'\ntrap '' TERM\nexec 1>&- 2>&-\nexec /bin/sleep 30\n`,
      { mode: 0o700 },
    );
    await writeFile(
      fakeRg,
      `#!/bin/sh\necho $$ > '${pidFile}'\n/bin/sh '${resistantChild}' &\nwait\n`,
      {
        mode: 0o700,
      },
    );
    const helperPath = fileURLToPath(new URL("../src/file-helper.ts", import.meta.url));
    const helper = spawn(process.execPath, [helperPath, fakeRg, "/usr/bin/false"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let searchPid;
    let descendantPid;
    let stdout = "";
    let stderr = "";
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`helper did not exit; stderr: ${stderr}`)), 5000);
      helper.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        let end;
        while ((end = stdout.indexOf("\n")) >= 0) {
          const frame = JSON.parse(stdout.slice(0, end));
          stdout = stdout.slice(end + 1);
          if (frame.ready)
            helper.stdin.write(
              `${JSON.stringify({
                id: 1,
                op: "grep",
                args: { path: source, pattern: "needle", literal: true, limit: 1 },
              })}\n`,
            );
        }
      });
      helper.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      helper.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      helper.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    t.after(async () => {
      helper.kill("SIGKILL");
      if (searchPid) {
        try {
          process.kill(-searchPid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    });

    const deadline = Date.now() + 3000;
    while ((!searchPid || !descendantPid) && Date.now() < deadline) {
      searchPid = Number((await readFile(pidFile, "utf8").catch(() => "")) || 0) || undefined;
      descendantPid =
        Number((await readFile(descendantPidFile, "utf8").catch(() => "")) || 0) || undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(searchPid, "fake search subprocess started");
    assert.ok(descendantPid, "TERM-resistant descendant started");
    helper.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null });
    const stopDeadline = Date.now() + 2000;
    while (Date.now() < stopDeadline) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      } catch {
        return;
      }
    }
    assert.fail(`TERM-resistant descendant ${descendantPid} remained alive after helper shutdown`);
  },
);

test("grep caps an excessive context request", async (t) => {
  const f = await fixture(t, (event) => {
    const match = {
      ...event,
      data: { ...event.data, line_number: 150, lines: { text: "needle\n" } },
    };
    return [
      "#!/usr/bin/env node",
      `const event = ${JSON.stringify(match)};`,
      'process.stdout.write(JSON.stringify(event) + "\\n");',
      "",
    ].join("\n");
  });
  await writeFile(
    f.source,
    Array.from({ length: 300 }, (_, index) => `line-${index + 1}`).join("\n"),
  );

  const response = await grepWith(f.fakeRg, f.source, t, 1_000_000);

  assert.equal(response.error, undefined);
  const output = response.result.content[0].text;
  assert.match(output, /matches\.txt-50- line-50/);
  assert.match(output, /matches\.txt-250- line-250/);
  assert.doesNotMatch(output, /matches\.txt-49- line-49/);
  assert.doesNotMatch(output, /matches\.txt-251- line-251/);
  assert.match(output, /Context capped at 100 lines per match/);
});

test("grep rejects work beyond the bounded subprocess queue", async (t) => {
  const f = await fixture(t, (event) =>
    [
      "#!/usr/bin/env node",
      `const event = ${JSON.stringify(event)};`,
      'setTimeout(() => process.stdout.write(JSON.stringify(event) + "\\n"), 100);',
      "",
    ].join("\n"),
  );
  const helperPath = fileURLToPath(new URL("../src/file-helper.ts", import.meta.url));
  const helper = spawn(process.execPath, [helperPath, f.fakeRg, "/usr/bin/false"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => helper.kill("SIGKILL"));
  const responses = await new Promise((resolve, reject) => {
    let buffer = "",
      stderr = "";
    const collected = new Map();
    const timer = setTimeout(
      () => reject(Error(`file helper queue test timed out; stderr: ${stderr || "(empty)"}`)),
      10000,
    );
    const finish = () => {
      clearTimeout(timer);
      helper.stdin.end();
      resolve(collected);
    };
    helper.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (frame.ready) {
          for (let id = 1; id <= 19; id++)
            helper.stdin.write(
              `${JSON.stringify({
                id,
                op: "grep",
                args: { path: f.source, pattern: "needle", literal: true, limit: 1 },
              })}\n`,
            );
        } else if (typeof frame.id === "number" && (frame.result !== undefined || frame.error)) {
          collected.set(frame.id, frame);
          if (collected.size === 19) finish();
        }
      }
    });
    helper.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    helper.once("error", reject);
    helper.once("close", (code, signal) => {
      if (collected.size !== 19)
        reject(
          Error(
            `file helper exited before queue responses (code=${code}, signal=${signal}); stderr: ${stderr || "(empty)"}`,
          ),
        );
    });
  });

  assert.equal(responses.size, 19);
  assert.equal(
    [...responses.values()].filter((frame) =>
      /too many searches are queued/.test(frame.error?.message ?? ""),
    ).length,
    1,
  );
  assert.equal([...responses.values()].filter((frame) => frame.result).length, 18);
});
