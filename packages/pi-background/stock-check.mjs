// Loads pi-background through pinned stock Pi. --standalone loads no sibling extension.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = await mkdtemp(join(tmpdir(), "pi-background-stock-check-"));
const agentDir = join(root, "agent");
const home = join(root, "home");
await mkdir(agentDir, { recursive: true });
await mkdir(home, { recursive: true });
const envKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_SECURITY_TRANSPORT",
  "PI_SECURITY_ACTIVATION",
  "PI_SUBAGENT",
];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home, ".config");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SECURITY_ACTIVATION = "active";

try {
  const piPath = fileURLToPath(
    new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url),
  );
  const pi = await import(pathToFileURL(piPath));
  const literalDashArgs = pi.parseArgs(["--tools", "read", "--", "--help"]);
  assert.deepEqual(literalDashArgs.tools, ["read"]);
  assert.deepEqual(literalDashArgs.messages, ["--help"]);
  const backgroundFactory = (await import("./extensions/background-process.ts")).default;
  let backgroundEvents;
  const background = (api) => {
    backgroundEvents = api.events;
    backgroundFactory(api);
  };
  const standalone = process.argv.includes("--standalone");
  const securityExtension = standalone
    ? undefined
    : (await import("../pi-security/src/extension.ts")).default;
  const sentinelExtension = (extensionApi) => {
    extensionApi.registerTool({
      name: "sentinel_tool",
      description: "A tool registered by another extension.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: [{ type: "text", text: "sentinel" }] };
      },
    });
  };
  const credentials = {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw Error("read only");
    },
    async delete() {
      throw Error("read only");
    },
  };
  const modelRuntime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const cases = [
    { name: "plain", selected: false, provider: false, factories: [background] },
    {
      name: "plain-child-read-write",
      selected: false,
      provider: false,
      child: true,
      tools: ["read", "write"],
      factories: [background],
    },
    {
      name: "parent-read-only",
      selected: false,
      provider: false,
      tools: ["read"],
      factories: [background],
    },
    {
      name: "parent-wildcard",
      selected: false,
      provider: false,
      tools: ["read", "background_*"],
      expectedActive: ["read", "background_process"],
      factories: [background],
    },
    {
      name: "parent-modifier",
      selected: false,
      provider: false,
      tools: ["+background_process"],
      expectedActive: ["read", "bash", "edit", "write", "background_process"],
      factories: [background],
    },
    {
      name: "parent-exclusion",
      selected: false,
      provider: false,
      excludeTools: ["background_process"],
      expectedActive: ["read", "bash", "edit", "write"],
      factories: [background],
    },
    {
      name: "default-tools-sentinel",
      selected: false,
      provider: false,
      defaultTools: ["read", "bash", "edit", "write"],
      factories: [background, sentinelExtension],
    },
    ...(standalone ? [] : ["internal", "extensions"]).flatMap((transport) =>
      [
        [background, securityExtension],
        [securityExtension, background],
      ].map((factories, order) => ({
        name: `${transport}-${order ? "security-first" : "bg-first"}`,
        selected: transport === "extensions",
        provider: true,
        factories,
      })),
    ),
    { name: "selected-missing", selected: true, provider: false, factories: [background] },
  ];
  for (const current of cases) {
    let currentService;
    if (current.selected) process.env.PI_SECURITY_TRANSPORT = "extensions";
    else delete process.env.PI_SECURITY_TRANSPORT;
    if (current.child) process.env.PI_SUBAGENT = "1";
    else delete process.env.PI_SUBAGENT;
    const cwd = join(root, current.name);
    const currentAgentDir = join(agentDir, current.name);
    await mkdir(cwd);
    await mkdir(currentAgentDir);
    if (current.defaultTools)
      await writeFile(
        join(currentAgentDir, "settings.json"),
        JSON.stringify({ defaultTools: current.defaultTools }),
      );
    const settingsManager = pi.SettingsManager.create(cwd, currentAgentDir, {
      projectTrusted: true,
    });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd,
      agentDir: currentAgentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: current.factories,
    });
    await resourceLoader.reload();
    const { session } = await pi.createAgentSession({
      cwd,
      agentDir: currentAgentDir,
      modelRuntime,
      resourceLoader,
      settingsManager,
      tools: current.tools,
      excludeTools: current.excludeTools,
      sessionManager: pi.SessionManager.inMemory(cwd),
    });
    await session.bindExtensions({
      mode: "print",
      uiContext: { notify() {}, setStatus() {}, setWidget() {} },
    });
    await session.extensionRunner.emit({ type: "session_start", reason: "startup" });
    const registered = session.extensionRunner.getAllRegisteredTools();
    const extensionTools = registered.map((tool) => tool.definition.name);
    const allTools = session.getAllTools().map((tool) => tool.name);
    if (current.tools || current.excludeTools) {
      const expectedActive = current.expectedActive ?? current.tools;
      assert.deepEqual(session.extensionRunner.getActiveTools().sort(), [...expectedActive].sort());
      assert.equal(
        allTools.includes("bash"),
        expectedActive.includes("bash"),
        "only the native selection activates Bash",
      );
      assert.equal(
        allTools.includes("background_process"),
        expectedActive.includes("background_process"),
        "only an explicit native selection activates the process inspector",
      );
      assert.ok(
        extensionTools.includes("bash"),
        "inactive Bash remains registered with defaultActive:false",
      );
      assert.ok(
        extensionTools.includes("background_process"),
        "inactive process inspector remains available for native explicit selection",
      );
    } else {
      assert.ok(allTools.includes("bash"), "stock Pi continues to expose its Bash tool");
      assert.ok(extensionTools.includes("bash"));
      assert.ok(extensionTools.includes("background_process"));
      assert.ok(
        allTools.includes("background_process"),
        "plain parent keeps the process inspector alongside Bash",
      );
      if (current.defaultTools) {
        assert.ok(session.extensionRunner.getActiveTools().includes("sentinel_tool"));
        assert.deepEqual(
          session.extensionRunner
            .getActiveTools()
            .filter((name) => name !== "sentinel_tool" && name !== "background_process")
            .sort(),
          [...current.defaultTools].sort(),
          "defaultTools do not filter unrelated extension tools",
        );
        assert.ok(session.extensionRunner.getActiveTools().includes("background_process"));
      }
    }
    const bash = session.extensionRunner.getToolDefinition("bash");
    const backgroundTool = session.extensionRunner.getToolDefinition("background_process");
    if (current.selected && !current.provider) {
      await assert.rejects(
        bash.execute("selected-without-security", { command: "printf must-not-run" }),
        /Security is selected, but the secured Bash tool is unavailable/,
      );
    } else if (!current.provider) {
      const result = await bash.execute(
        "stock-host-bash",
        { command: "printf 'stock-host-bash\\n'" },
        undefined,
        undefined,
        {
          cwd,
          sessionManager: { getSessionId: () => "stock-test", getSessionFile: () => undefined },
        },
      );
      assert.equal(result.structuredContent.exit_code, 0);
      assert.match(result.structuredContent.output, /stock-host-bash/);
      assert.equal(typeof result.structuredContent.wall_time_seconds, "number");
      if (current.name === "plain") {
        // Use the same event capability optional clients receive; no goal, agents or security loaded.
        backgroundEvents.emit("background:service", {
          respond: (value) => {
            currentService = value;
          },
        });
        assert.ok(currentService);
        const job = currentService.launch(
          {
            command: process.execPath,
            args: ["-e", "process.stdout.write('standalone-job\\n');setInterval(()=>{},1000)"],
            cwd,
            env: process.env,
            owner: "bash",
            label: "standalone stock job",
            mode: "host",
            stdin: "closed",
          },
          { notify: false },
        );
        try {
          for (let attempt = 0; attempt < 200; attempt++) {
            const read = currentService.read(job.id, 0, 1024);
            if (read.chunks.some((chunk) => chunk.data.includes("standalone-job"))) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(currentService.status(job.id).status, "running");
          const read = await backgroundTool.execute("read-standalone", {
            id: job.id,
            action: "read",
          });
          assert.match(read.content[0].text, /standalone-job/);
        } finally {
          await backgroundTool.execute("cancel-standalone", { id: job.id, action: "cancel" });
          await job.done;
        }
        assert.notEqual(currentService.status(job.id).status, "running");
      }
    } else {
      const result = await bash.execute(
        "security-owner",
        { command: "printf 'plain-host-must-not-run'" },
        session.extensionRunner.createToolContext("security-owner", undefined),
      );
      assert.equal(
        result.isError,
        true,
        "active pi-security owns Bash and fails closed without policy",
      );
      assert.doesNotMatch(JSON.stringify(result), /plain-host-must-not-run/);
      if (!current.selected) {
        const backgroundResult = await backgroundTool.execute(
          "security-background-owner",
          { action: "list" },
          session.extensionRunner.createToolContext("security-background-owner", undefined),
        );
        assert.equal(
          backgroundResult.isError,
          true,
          "internal pi-security owns background_process",
        );
      } else {
        const backgroundResult = await backgroundTool.execute("extension-background-owner", {
          action: "list",
        });
        assert.equal(backgroundResult.content[0]?.text, "No background jobs.");
      }
    }
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "shutdown" });
    if (currentService)
      assert.throws(() => currentService.status("ended-session"), /ended session/);
    await session.dispose();
  }
  process.stdout.write(
    JSON.stringify({
      ok: true,
      checks: [
        "stock Pi plain Bash via managed host processes",
        "standalone background launch, read, cancellation and session shutdown",
        "native tool selection remains authoritative",
        "selected security without provider fails closed",
        "standard cost and exit fields",
        ...(standalone
          ? []
          : [
              "pi-security owns Bash in internal and extension transports",
              "registration order does not bypass security",
              "background_process owner follows transport",
            ]),
      ],
    }) + "\n",
  );
} finally {
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await rm(root, { recursive: true, force: true });
}
