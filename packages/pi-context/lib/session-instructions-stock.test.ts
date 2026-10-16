import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { type installSessionSetup, sessionSetupService } from "pi-resources/session-setup";
import { savedInstructionContext } from "pi-resources/instructions";
import context from "../extensions/context.ts";
import { catalogueInstructionId } from "./instruction-selection.ts";
const {
  buildSystemPrompt,
  buildSystemPromptSections,
  diffSystemPromptSections,
  normalizeBuildSystemPromptOptions,
} = await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);
const ns = "resources";
const put = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};

test("stock session instructions replay on resume/fork/tree, reset to fresh defaults, and leave project context and settings intact", {
  timeout: 15000,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "session-instruction-stock-"))),
    agentDir = join(root, "agent"),
    project = join(root, "project"),
    catalogue = join(root, "packs/sample/resources/instructions"),
    pack = join(root, "packs/sample");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const savedArgv = [...process.argv];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const globalPath = join(agentDir, "settings.json");
  let session: sdk.AgentSession | undefined;
  const runtime = await sdk.ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  try {
    mkdirSync(project, { recursive: true });
    put(join(project, "AGENTS.md"), "PROJECT_TEAM_CONTEXT");
    put(join(project, ".agents/instructions/local.md"), "LOCAL_SAVED_DEFAULT");
    put(join(catalogue, "old.md"), "---\nnotes: HUMAN_OLD\n---\nDEFAULT_OLD");
    put(join(catalogue, "new.md"), "---\nnotes: HUMAN_NEW\n---\nDEFAULT_NEW");
    const snippet = join(pack, ns, "instructions/selected.md");
    put(
      snippet,
      "---\nnotes: HUMAN_SELECTED\n---\n# Guidance\nSESSION_SELECTED_BODY\n<!-- KEEP_BODY_COMMENT -->",
    );
    put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "sample",
        keywords: ["rpc"],
        pi: { extensions: [], skills: [], instructions: [`./${ns}/instructions`] },
      }),
    );
    const oldId = catalogueInstructionId(catalogue, "old.md"),
      newId = catalogueInstructionId(catalogue, "new.md"),
      selectedId = catalogueInstructionId(dirname(snippet), "selected.md");
    const settings = (id: string) =>
      JSON.stringify({
        packages: [pack],
        localContext: {
          instructions: {
            [oldId]: id === oldId,
            [newId]: id === newId,
            [selectedId]: id === selectedId,
          },
        },
        theme: "dark",
      });
    put(globalPath, settings(oldId));
    const originalGlobal = readFileSync(globalPath, "utf8");
    let setup: ReturnType<typeof installSessionSetup>, ctx: sdk.ExtensionContext;
    let events: sdk.ExtensionAPI["events"];
    const childInstructions = () => savedInstructionContext(events, ctx!);
    const open = async (
      manager: sdk.SessionManager,
      reason: "startup" | "resume" | "fork" | "new",
      trusted = true,
    ) => {
      const settingsManager = sdk.SettingsManager.create(project, agentDir, {
        projectTrusted: trusted,
      });
      const loader = new sdk.DefaultResourceLoader({
        cwd: project,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          {
            path: "fixture:session-instructions",
            factory(pi) {
              events = pi.events;
              pi.on("session_start", (_, current) => {
                ctx = current;
              });
              pi.on("session_tree", (_, current) => {
                ctx = current;
              });
              context(pi);
              setup = sessionSetupService(pi.events)!;
            },
          },
        ],
      });
      await loader.reload();
      const created = await sdk.createAgentSession({
        cwd: project,
        agentDir,
        resourceLoader: loader,
        settingsManager,
        sessionManager: manager,
        modelRuntime: runtime,
        sessionStartEvent: { type: "session_start", reason },
      });
      session = created.session;
      assert.equal(loader.getExtensions().errors.length, 0);
      await session.bindExtensions({
        mode: "print",
        uiContext: { notify() {}, setStatus() {}, setWidget() {} },
      });
      assert.equal(session.getAllTools().filter((tool) => tool.name === "session_setup").length, 1);
    };
    const render = async (extra: Record<string, unknown> = {}) => {
      const options = normalizeBuildSystemPromptOptions({
        cwd: project,
        contextFiles: [{ path: join(project, "AGENTS.md"), content: "PROJECT_TEAM_CONTEXT" }],
        sections: { instructions: "CALLER_GUIDANCE" },
        ...extra,
      });
      const built = await session!.extensionRunner!.emitBeforeAgentStart(
        { messageType: "user", prompt: "fixture next run" },
        options,
      );
      return {
        prompt: buildSystemPrompt(built.systemPromptOptions),
        sections: buildSystemPromptSections(built.systemPromptOptions),
      };
    };
    const manager = sdk.SessionManager.inMemory(project);
    await open(manager, "startup");
    assert.match((await render()).prompt, /DEFAULT_OLD/);
    assert.match(childInstructions()!, /DEFAULT_OLD/);
    assert.match(childInstructions()!, /LOCAL_SAVED_DEFAULT/);
    const listed = setup!.execute({ op: "list", kinds: ["instructions"] }, ctx!);
    assert.doesNotMatch(JSON.stringify(listed.candidates), /BODY|HUMAN_|PROJECT_TEAM_CONTEXT/);
    const before = manager.getLeafId();
    assert.throws(
      () => setup!.execute({ op: "apply", instructions: [selectedId, selectedId] }, ctx!),
      /unique|duplicate/i,
    );
    assert.equal(manager.getLeafId(), before, "invalid setup never commits a session entry");
    setup!.execute({ op: "apply", instructions: [selectedId] }, ctx!);
    const selectedLeaf = manager.getLeafId()!;
    const chosen = await render();
    assert.match(chosen.prompt, /SESSION_SELECTED_BODY/);
    assert.match(chosen.prompt, /CALLER_GUIDANCE/);
    assert.match(chosen.prompt, /<project_context>[\s\S]*PROJECT_TEAM_CONTEXT/);
    assert.doesNotMatch(chosen.prompt, /HUMAN_|DEFAULT_OLD/);
    assert.doesNotMatch(chosen.prompt, /LOCAL_SAVED_DEFAULT/);
    assert.match(chosen.prompt, /KEEP_BODY_COMMENT/);
    assert.match(childInstructions()!, /DEFAULT_OLD/);
    assert.match(childInstructions()!, /LOCAL_SAVED_DEFAULT/);
    assert.doesNotMatch(childInstructions()!, /SESSION_SELECTED_BODY|CALLER_GUIDANCE|HUMAN_/);
    const projectSettings = join(project, ".pi/settings.json");
    put(
      projectSettings,
      JSON.stringify({ localContext: { instructions: { [newId]: true, [oldId]: false } } }),
    );
    assert.match(childInstructions()!, /DEFAULT_NEW/);
    assert.doesNotMatch(childInstructions()!, /DEFAULT_OLD|SESSION_SELECTED_BODY/);
    rmSync(projectSettings);
    const unchanged = await render();
    assert.equal(unchanged.prompt, chosen.prompt);
    assert.equal(diffSystemPromptSections(chosen.sections, unchanged.sections), undefined);
    assert.equal(readFileSync(globalPath, "utf8"), originalGlobal);
    assert.ok(!existsSync(join(project, ".pi/settings.json")));
    session!.dispose();
    session = undefined;
    put(globalPath, settings(newId));
    await open(manager, "resume");
    assert.match((await render()).prompt, /SESSION_SELECTED_BODY/);
    assert.match(childInstructions()!, /DEFAULT_NEW/);
    assert.doesNotMatch(childInstructions()!, /SESSION_SELECTED_BODY|DEFAULT_OLD/);
    setup!.execute({ op: "reset" }, ctx!);
    assert.match((await render()).prompt, /DEFAULT_NEW/);
    assert.doesNotMatch((await render()).prompt, /SESSION_SELECTED_BODY|DEFAULT_OLD/);
    manager.branch(selectedLeaf);
    await session!.extensionRunner!.emit({
      type: "session_tree",
      oldLeafId: null,
      newLeafId: selectedLeaf,
    });
    assert.match((await render()).prompt, /SESSION_SELECTED_BODY/);
    manager.createBranchedSession(selectedLeaf);
    session!.dispose();
    session = undefined;
    await open(manager, "fork");
    assert.match((await render()).prompt, /SESSION_SELECTED_BODY/);
    put(snippet, "---\nnotes: HUMAN_EDITED\n---\nSESSION_BODY_EDITED");
    assert.match((await render()).prompt, /SESSION_BODY_EDITED/);
    put(globalPath, settings(selectedId));
    assert.match(childInstructions()!, /SESSION_BODY_EDITED/);
    assert.doesNotMatch(childInstructions()!, /HUMAN_EDITED/);
    put(globalPath, settings(newId));
    const forced = await render({ forceSystemPrompt: "OPAQUE_CALLER_PROMPT" });
    assert.equal(forced.prompt, "OPAQUE_CALLER_PROMPT");
    session!.dispose();
    session = undefined;
    await open(sdk.SessionManager.inMemory(project), "new");
    assert.match((await render()).prompt, /DEFAULT_NEW/);
    assert.doesNotMatch((await render()).prompt, /SESSION_BODY_EDITED/);
    session!.dispose();
    session = undefined;
    put(join(project, ".agents/instructions/private-local.md"), "UNTRUSTED_LOCAL_RULE");
    await open(sdk.SessionManager.inMemory(project), "new", false);
    assert.equal(ctx!.isProjectTrusted(), false);
    assert.throws(
      () =>
        setup!.execute(
          { op: "apply", instructions: ["local:.agents/instructions/private-local.md"] },
          ctx!,
        ),
      /unknown/i,
    );
    assert.doesNotMatch((await render()).prompt, /UNTRUSTED_LOCAL_RULE/);
    assert.doesNotMatch(childInstructions()!, /UNTRUSTED_LOCAL_RULE/);
    assert.doesNotMatch(childInstructions()!, /LOCAL_SAVED_DEFAULT/);
    session!.dispose();
    session = undefined;
    process.argv.push("--no-context-files");
    await open(sdk.SessionManager.inMemory(project), "new");
    const disabled = setup!.execute({ op: "list", kinds: ["instructions"] }, ctx!);
    assert.deepEqual(disabled.candidates, []);
    assert.throws(
      () => setup!.execute({ op: "apply", instructions: [selectedId] }, ctx!),
      /unknown/i,
    );
    const disabledPrompt = (await render()).prompt;
    assert.equal(childInstructions(), "");
    assert.doesNotMatch(disabledPrompt, /DEFAULT_NEW|SESSION_BODY_EDITED|UNTRUSTED_LOCAL_RULE/);
    assert.match(disabledPrompt, /CALLER_GUIDANCE/);
    assert.equal(readFileSync(globalPath, "utf8"), settings(newId));
    assert.ok(!existsSync(join(project, ".pi/settings.json")));
  } finally {
    process.argv.splice(0, process.argv.length, ...savedArgv);
    session?.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
