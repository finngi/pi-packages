import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test(
  "stock headless child can launch, read and cancel host Bash jobs and closes jobs at shutdown",
  { timeout: 25000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-background-"));
    const agentDir = join(root, "agent");
    const provider = join(root, "provider.mjs");
    const model = {
      id: "fixture",
      name: "Fixture",
      api: "background-fixture",
      provider: "background-fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 256,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const commands = {
      launch: `printf 'background-ready:%s\\n' "$PI_SESSION_ID"; printf '%s' "$$" > cancelled.pid; sleep 60`,
      cancelProof: `attempt=0; while kill -0 "$(cat cancelled.pid)" 2>/dev/null; do attempt=$((attempt+1)); [ "$attempt" -lt 200 ] || exit 1; sleep 0.01; done; printf cancelled-proof`,
      shutdown: `printf '%s' "$$" > shutdown.pid; printf shutdown-ready; sleep 60`,
    };
    await mkdir(agentDir);
    await writeFile(
      provider,
      `
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/compat"))};
import { writeFileSync } from "node:fs";
export default function(pi) {
  let step = 0;
  const model = ${JSON.stringify(model)};
  pi.on("session_shutdown", () => writeFileSync(${JSON.stringify(join(root, "shutdown"))}, "closed"));
  pi.registerProvider(model.provider, {
    api: model.api, apiKey: "fixture", baseUrl: model.baseUrl, models: [model],
    streamSimple(m, ctx) {
      if (step === 0) writeFileSync(${JSON.stringify(join(root, "tools.json"))}, JSON.stringify(pi.getActiveTools()));
      const launched = ctx.messages.filter(m => m.role === "toolResult" && m.toolName === "bash" && m.details?.id);
      const steps = [
        { name: "bash", arguments: { command: ${JSON.stringify(commands.launch)}, background: true } },
        { name: "bash", arguments: { command: "while [ ! -s cancelled.pid ]; do sleep 0.01; done; printf foreground-proof", background: false } },
        { name: "background_process", arguments: { action: "read", id: launched[0]?.details.id } },
        { name: "background_process", arguments: { action: "cancel", id: launched[0]?.details.id } },
        { name: "bash", arguments: { command: ${JSON.stringify(commands.cancelProof)} } },
        { name: "bash", arguments: { command: ${JSON.stringify(commands.shutdown)}, background: true } },
        { name: "bash", arguments: { command: "while [ ! -s shutdown.pid ]; do sleep 0.01; done; printf shutdown-started" } },
        { name: "background_process", arguments: { action: "status", id: launched[1]?.details.id } },
      ];
      const next = steps[step++];
      const reason = next ? "toolUse" : "stop";
      const message = {
        role: "assistant", content: next ? [{ type: "toolCall", id: "fixture-" + step, ...next }] : [{ type: "text", text: "BACKGROUND_CHILD_DONE" }],
        api: m.api, provider: m.provider, model: m.id, stopReason: reason, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); stream.end(); });
      return stream;
    },
  });
}
`,
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const env = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, ".config"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT: "1",
      };
      child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
              import.meta.url,
            ),
          ),
          "--mode",
          "json",
          "--print",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--extension",
          fileURLToPath(new URL("./background-process.ts", import.meta.url)),
          "--extension",
          provider,
          "--tools",
          "bash,background_process",
          "--model",
          "background-fixture/fixture",
          "Exercise managed host background jobs.",
        ],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (data) => {
        stdout += data;
      });
      child.stderr!.on("data", (data) => {
        stderr += data;
      });
      const timeout = setTimeout(() => child?.kill("SIGTERM"), 18000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      }).finally(() => clearTimeout(timeout));
      assert.equal(code, 0, stderr + stdout);
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const results = events.filter((event) => event.type === "tool_execution_end");
      assert.equal(results.length, 8, stdout + stderr);
      assert.ok(
        results.every((event) => !event.isError),
        stdout + stderr,
      );
      assert.deepEqual(JSON.parse(await readFile(join(root, "tools.json"), "utf8")).sort(), [
        "background_process",
        "bash",
      ]);
      const launch = results[0].result;
      assert.equal(launch.details.running, true);
      assert.equal(typeof launch.details.id, "string");
      assert.deepEqual(launch.structuredContent, launch.details);
      assert.deepEqual(JSON.parse(launch.content[0].text), launch.details);
      const foreground = results[1].result.structuredContent;
      assert.equal(foreground.output, "foreground-proof");
      assert.equal(foreground.exit_code, 0);
      assert.equal(typeof foreground.wall_time_seconds, "number");
      assert.match(results[2].result.content[0].text, /background-ready:[^\s]+/);
      assert.equal(results[4].result.structuredContent.output, "cancelled-proof");
      assert.equal(results[7].result.details.status, "running");
      assert.equal(await readFile(join(root, "shutdown"), "utf8"), "closed");
      for (const name of ["cancelled.pid", "shutdown.pid"]) {
        const pid = Number(await readFile(join(root, name), "utf8"));
        assert.throws(
          () => process.kill(pid, 0),
          { code: "ESRCH" },
          `${name} process must be gone`,
        );
      }
    } finally {
      child?.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    }
  },
);
