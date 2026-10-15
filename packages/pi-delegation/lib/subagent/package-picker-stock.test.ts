import resources from "../../../pi-resources/extensions/resources.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai/compat";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { ResourceBrowser } from "./resource-browser.ts";
import subagents from "../../extensions/subagent.ts";
import context from "../../../pi-context/extensions/context.ts";

sdk.initTheme("dark", false);
test(
  "stock Pi package picker persists only on save, resumes selections and exposes guidance without private skill bodies",
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-picker-stock-")),
      initialCwd = join(root, "project"),
      agentDir = join(root, "agent"),
      pack = join(root, "package");
    let cwd = initialCwd;
    t.after(() => rm(root, { recursive: true, force: true }));
    const put = async (file: string, text: string) => {
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, text);
    };
    const global = JSON.stringify({
        packages: [pack],
        subagents: { skills: ["standalone"], agents: [] },
      }),
      local = JSON.stringify({ keep: "untouched" });
    await put(join(agentDir, "settings.json"), global);
    await put(join(cwd, ".pi/settings.json"), local);
    await put(
      join(agentDir, "skills/standalone/SKILL.md"),
      "---\nname: standalone\ndescription: STANDALONE_DESCRIPTION\n---\nSTANDALONE_BODY",
    );
    await put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "@example/pi-evidence",
        description: "Review evidence",
        keywords: ["research"],
        pi: {
          extensions: ["extension.ts"],
          skills: ["skills"],
          agents: ["agents"],
          instructions: ["instructions"],
        },
      }),
    );
    await put(join(pack, "extension.ts"), "throw Error('PACKAGE_CODE_MUST_NOT_BE_TOGGLED');");
    await put(
      join(pack, "skills/check-evidence/SKILL.md"),
      "---\nname: check-evidence\ndescription: PUBLIC_DESCRIPTION\n---\nPUBLIC_BODY",
    );
    await put(
      join(pack, "agents/verifier/verifier.md"),
      "---\nname: verifier\ndescription: VERIFIER_DESCRIPTION\nmodel: inherit\nskills: [private-check]\n---\nVERIFIER_BODY",
    );
    await put(
      join(pack, "agents/verifier/skills/private-check/SKILL.md"),
      "---\nname: private-check\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
    );
    await put(join(pack, "instructions/evidence.md"), "# Evidence attribution\nINSTRUCTION_BODY");
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(() => {
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
    });
    const model: any = {
      id: "picker-fixture",
      name: "Picker fixture",
      api: "picker-fixture",
      provider: "picker-fixture",
      baseUrl: "http://invalid.local",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    const runtime = await sdk.ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const prompts: string[] = [];
    let reset = false;
    runtime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture",
      baseUrl: model.baseUrl,
      models: [model],
      streamSimple: (_m: any, ctx: any) => {
        prompts.push(session.systemPrompt);
        const call = reset;
        reset = false;
        const stream = createAssistantMessageEventStream(),
          message: any = {
            role: "assistant",
            content: call
              ? [
                  {
                    type: "toolCall",
                    id: "reset-selection",
                    name: "session_setup",
                    arguments: { op: "reset" },
                  },
                ]
              : [{ type: "text", text: "done" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: call ? "toolUse" : "stop",
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    let session: sdk.AgentSession,
      action: (browser: ResourceBrowser) => Promise<void> = async () => {};
    const captures: Array<{ stage: string; width: number; lines: string[] }> = [];
    const open = async (manager: sdk.SessionManager) => {
      const settings = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const loader = new sdk.DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        extensionFactories: [
          {
            path: "fixture:picker",
            factory(pi) {
              subagents(pi);
              resources(pi);
              context(pi);
            },
          },
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await sdk.createAgentSession({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel: "off",
        settingsManager: settings,
        resourceLoader: loader,
        sessionManager: manager,
      }));
      await session.bindExtensions({
        mode: "tui",
        onError: (error) => {
          throw error;
        },
        commandContextActions: { waitForIdle: async () => {} } as any,
        uiContext: {
          ...session.extensionRunner!.getUIContext(),
          notify() {},
          custom: async (factory: Function) => {
            const browser: ResourceBrowser = factory(
              { terminal: { rows: 40 }, requestRender() {} },
              session.extensionRunner!.getUIContext().theme,
              {},
              () => {},
            );
            try {
              await action(browser);
              return true;
            } finally {
              browser.dispose();
            }
          },
        } as any,
      });
    };
    const close = async () => {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason: "exit" });
      session.dispose();
    };
    const capture = (browser: ResourceBrowser, stage: string) => {
      for (const width of [120, 80]) {
        const lines = browser.render(width);
        assert(lines.every((line) => visibleWidth(line) <= width));
        captures.push({ stage, width, lines });
      }
    };
    try {
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("Baseline.");
      assert.doesNotMatch(
        prompts.at(-1)!,
        /INSTRUCTION_BODY|VERIFIER_DESCRIPTION|PUBLIC_DESCRIPTION|PRIVATE_DESCRIPTION/,
      );
      const tools = session.getActiveToolNames();
      action = async (browser) => {
        capture(browser, "before");
        await browser.toggleCurrent();
        await new Promise((resolve) => setImmediate(resolve));
        capture(browser, "session selection");
      };
      await session.prompt("/packages");
      assert.equal(prompts.length, 1, "Picker must not invoke the model");
      assert.equal(await readFile(join(cwd, ".pi/settings.json"), "utf8"), local);
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), global);
      assert.deepEqual(session.getActiveToolNames(), tools);
      await session.prompt("Verify claims.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      assert.match(prompts.at(-1)!, /PUBLIC_DESCRIPTION/);
      assert.match(prompts.at(-1)!, /VERIFIER_DESCRIPTION/);
      assert.doesNotMatch(
        prompts.at(-1)!,
        /PUBLIC_BODY|PRIVATE_DESCRIPTION|PRIVATE_BODY|VERIFIER_BODY/,
      );
      const file = session.sessionManager.getSessionFile()!;
      await close();
      await open(sdk.SessionManager.open(file));
      await session.prompt("Resume verification.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      action = async (browser) => {
        await browser.saveDefaults();
        capture(browser, "project defaults saved");
      };
      await session.prompt("/packages");
      const saved = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      assert.equal(saved.keep, "untouched");
      assert.deepEqual(saved.subagents.skills, ["standalone", "check-evidence"]);
      assert.deepEqual(saved.subagents.agents, ["verifier"]);
      assert.equal(saved.localContext.instructions.length, 1);
      assert.equal(
        saved.skills,
        undefined,
        "Native package skills must not be re-registered as unfiltered paths",
      );
      reset = true;
      await session.prompt("Reset session selection.");
      await session.prompt("After reset.");
      assert.match(
        prompts.at(-1)!,
        /VERIFIER_DESCRIPTION/,
        "Reset must use saved agent defaults, not the startup snapshot",
      );
      await close();
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("Fresh verification.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      assert.match(prompts.at(-1)!, /VERIFIER_DESCRIPTION/);
      assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), global);
      const savedProject = await readFile(join(cwd, ".pi/settings.json"), "utf8");
      // Every window writes the same session overlay. A toggle must never save either defaults file.
      for (const [command, query, marker] of [
        ["/agents", "verifier", "VERIFIER_DESCRIPTION"],
        ["/skills", "check-evidence", "PUBLIC_DESCRIPTION"],
        ["/instructions", "evidence", "INSTRUCTION_BODY"],
      ]) {
        action = async (browser) => {
          browser.handleInput("/");
          browser.handleInput(query);
          await browser.toggleCurrent();
          capture(browser, command);
        };
        await session.prompt(command);
        await session.prompt("Inspect the selected prompt.");
        assert(
          !prompts.at(-1)!.includes(marker),
          command + " failed to remove " + marker + "\n" + prompts.at(-1),
        );
        assert.equal(await readFile(join(cwd, ".pi/settings.json"), "utf8"), savedProject);
        assert.equal(await readFile(join(agentDir, "settings.json"), "utf8"), global);
        action = async (browser) => {
          browser.handleInput("/");
          browser.handleInput(query);
          await browser.toggleCurrent();
        };
        await session.prompt(command);
      }
      assert.deepEqual(session.getActiveToolNames(), tools);
      const oldSessionFile = session.sessionManager.getSessionFile()!;
      await close();
      cwd = join(root, "project-b");
      await mkdir(cwd, { recursive: true });
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("B initially has no evidence defaults.");
      assert.doesNotMatch(prompts.at(-1)!, /INSTRUCTION_BODY/);
      // Native Kitty key encoding for Ctrl+Shift+S saves personal defaults from the same window.
      action = async (browser) => {
        await browser.toggleCurrent();
        browser.handleInput("\x1b[115;6u");
        for (let n = 0; n < 50; n++) {
          if (
            browser
              .render(120)
              .map(stripTerminalSequences)
              .join("\n")
              .includes("Personal defaults saved")
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        capture(browser, "personal defaults saved");
        assert.match(
          browser.render(120).map(stripTerminalSequences).join("\n"),
          /Personal defaults saved/,
        );
      };
      await session.prompt("/packages");
      let personal = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(personal.subagents.agents, ["verifier"]);
      assert.deepEqual(personal.packages, [pack]);
      assert.equal(await readFile(join(initialCwd, ".pi/settings.json"), "utf8"), savedProject);
      await close();
      cwd = join(root, "project-c");
      await mkdir(cwd, { recursive: true });
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("A new project inherits personal defaults.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      const cFile = session.sessionManager.getSessionFile()!;
      // Turn off future defaults in B, retaining A's project selection and C's recorded session choices.
      await close();
      cwd = join(root, "project-b");
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      action = async (browser) => {
        await browser.toggleCurrent();
        await browser.saveDefaults(true);
      };
      await session.prompt("/packages");
      personal = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(personal.subagents.agents, []);
      assert.deepEqual(personal.localContext.instructions, []);
      await close();
      cwd = initialCwd;
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("Project A retains its own defaults.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      await close();
      await open(sdk.SessionManager.open(oldSessionFile));
      await session.prompt("A resumed old session retains its choices.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      await close();
      cwd = join(root, "project-c");
      await open(sdk.SessionManager.open(cFile));
      await session.prompt("C resumes the original defaults, not today's defaults.");
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      await close();
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      await session.prompt("New C uses the changed personal defaults.");
      assert.doesNotMatch(prompts.at(-1)!, /INSTRUCTION_BODY/);
      assert.deepEqual(session.getActiveToolNames(), tools);
      // A package registered only in one project must never become a personal default.
      await close();
      cwd = join(root, "project-d");
      const projectPack = join(root, "project-only-package");
      await put(
        join(projectPack, "package.json"),
        JSON.stringify({
          name: "@example/pi-project-only",
          pi: { skills: ["skills"], agents: ["agents"], instructions: ["instructions"] },
        }),
      );
      await put(
        join(projectPack, "skills/project-check/SKILL.md"),
        "---\nname: project-check\ndescription: Project-only check\n---\nPROJECT_SKILL_BODY",
      );
      await put(
        join(projectPack, "agents/project-reviewer/project-reviewer.md"),
        "---\nname: project-reviewer\ndescription: Project-only reviewer\nmodel: inherit\n---\nPROJECT_AGENT_BODY",
      );
      await put(
        join(projectPack, "instructions/project-guidance.md"),
        "# Project guidance\nPROJECT_GUIDANCE_BODY",
      );
      await put(join(cwd, ".pi/settings.json"), JSON.stringify({ packages: [projectPack] }));
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      action = async (browser) => {
        browser.handleInput("/");
        browser.handleInput("project-guidance");
        browser.handleInput("\x1b[A");
        await browser.toggleCurrent();
        await browser.saveDefaults(true);
      };
      await session.prompt("/instructions");
      personal = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert.deepEqual(personal.localContext.instructions, []);
      action = async (browser) => {
        browser.handleInput("/");
        browser.handleInput("project-only");
        await browser.toggleCurrent();
        await browser.saveDefaults(true);
      };
      await session.prompt("/packages");
      personal = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
      assert(!personal.subagents.agents.includes("project-reviewer"));
      assert(!personal.subagents.skills.includes("project-check"));
      assert.deepEqual(personal.localContext.instructions, []);
      assert.deepEqual(personal.packages, [pack]);
      // The real command producers expose the preview controls with native persistence.
      await close();
      cwd = join(root, "project-e");
      await put(
        join(cwd, ".pi/settings.json"),
        JSON.stringify({
          keep: "untouched",
          subagents: { agents: [], skills: [] },
          localContext: { instructions: [] },
        }),
      );
      await open(sdk.SessionManager.create(cwd, join(agentDir, "sessions")));
      for (const [command, query] of [
        ["agents", "verifier"],
        ["skills", "standalone"],
        ["instructions", "evidence"],
      ]) {
        action = async (browser) => {
          browser.handleInput("/");
          browser.handleInput(query);
          browser.handleInput("\x1b[A");
          await browser.toggleScope("project");
          const text = browser.render(120).map(stripTerminalSequences).join("\n");
          assert.match(text, /Session: ON /);
          assert.match(text, /Project: ON /);
        };
        await session.prompt(`/${command}`);
      }
      for (const [command, query] of [
        ["agents", "verifier"],
        ["skills", "standalone"],
        ["instructions", "evidence"],
      ]) {
        action = async (browser) => {
          browser.handleInput("/");
          browser.handleInput(query);
          browser.handleInput("\x1b[A");
          await browser.toggleScope("project");
          assert.match(
            browser.render(120).map(stripTerminalSequences).join("\n"),
            /Session: ON .*Project: OFF/,
          );
        };
        await session.prompt(`/${command}`);
      }
      await session.prompt(
        "Defaults were switched off, but the current session keeps its choices.",
      );
      assert.match(prompts.at(-1)!, /VERIFIER_DESCRIPTION/);
      assert.match(prompts.at(-1)!, /STANDALONE_DESCRIPTION/);
      assert.match(prompts.at(-1)!, /INSTRUCTION_BODY/);
      const savedPerItem = JSON.parse(await readFile(join(cwd, ".pi/settings.json"), "utf8"));
      assert.deepEqual(savedPerItem.subagents.agents, []);
      assert.deepEqual(savedPerItem.subagents.skills, []);
      assert.equal(savedPerItem.localContext.instructions.length, 0);
      assert.equal(savedPerItem.keep, "untouched");
      const out = process.env.PI_PICKER_CAPTURE;
      if (out) await writeFile(out, JSON.stringify(captures, null, 2));
      assert.match(
        captures
          .find((c) => c.stage === "project defaults saved")!
          .lines.map(stripTerminalSequences)
          .join("\n"),
        /Project defaults saved/,
      );
    } finally {
      await close();
    }
  },
);
