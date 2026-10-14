import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import subagents from "../packages/pi-subagents/extensions/subagent.ts";
import instructions from "../packages/pi-local-context/extensions/context.ts";
const ns = "resources";
initTheme("dark", false);
const put = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
};
test("actual resource commands search pack metadata with the existing BM25 picker without public private-skill entries", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pack-search-"))),
    agentDir = join(root, "agent"),
    project = join(root, "project"),
    pack = join(root, "packs/sample");
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR,
    savedChild = process.env.PI_SUBAGENT;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_SUBAGENT;
  try {
    mkdirSync(project, { recursive: true });
    put(join(agentDir, "settings.json"), JSON.stringify({ packages: [pack] }));
    put(
      join(pack, "package.json"),
      JSON.stringify({
        name: "sample",
        description: "Swarm coordination",
        keywords: ["bm25", "rpc"],
        pi: {
          extensions: [],
          skills: ["skills"],
          agents: [`./${ns}/agents`],
          instructions: [`./${ns}/instructions`],
        },
      }),
    );
    put(
      join(pack, "skills/public-work/SKILL.md"),
      "---\nname: public-work\ndescription: Perform work.\n---\nPUBLIC_BODY",
    );
    put(
      join(pack, ns, "agents/worker/worker.md"),
      "---\nname: worker\ndescription: Work independently.\nskills: [secret-private-check]\n---\nAGENT_BODY",
    );
    put(
      join(pack, ns, "agents/worker/skills/secret-private-check/SKILL.md"),
      "---\nname: secret-private-check\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY",
    );
    put(
      join(pack, ns, "instructions/rule.md"),
      "---\ntitle: Guidance\ndescription: Guide behavior.\nnotes: HUMAN_NOTE\n---\nINSTRUCTION_BODY",
    );
    put(
      join(pack, ns, "instructions/z-malformed.md"),
      "---\ntitle: [\n---\nMALFORMED_METADATA_BODY",
    );
    const commands = new Map<string, { handler: Function }>(),
      handlers = new Map<string, Function[]>();
    const pi = {
      on(name: string, fn: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      },
      registerCommand(name: string, cmd: { handler: Function }) {
        commands.set(name, cmd);
      },
      registerFlag() {},
      getFlag() {},
      registerMessageRenderer() {},
      registerTool() {},
      appendEntry() {},
      getActiveTools: () => ["read"],
      getThinkingLevel: () => "low",
      getCommands: () => [
        {
          name: "skill:public-work",
          source: "skill",
          description: "Perform work",
          sourceInfo: {
            path: join(pack, "skills/public-work/SKILL.md"),
            source: pack,
            scope: "user",
            origin: "package",
            baseDir: pack,
          },
        },
      ],
      events: { on() {}, emit() {} },
    };
    subagents(pi as never);
    instructions(pi as never);
    let current = "";
    const expected: Record<string, string> = {
      skills: "public-work",
      agents: "worker",
      instructions: "Guidance",
    };
    const ctx = {
      cwd: project,
      hasUI: true,
      isProjectTrusted: () => true,
      waitForIdle: async () => {},
      isIdle: () => true,
      reload: async () => {
        throw Error("inspection must not reload");
      },
      modelRegistry: { getAvailableOfType: async () => [] },
      sessionManager: { getBranch: () => [], getEntries: () => [] },
      ui: {
        notify() {},
        setStatus() {},
        setWidget() {},
        async custom(factory: Function) {
          let close!: Function;
          const done = new Promise((resolve) => {
            close = resolve;
          });
          const browser = await factory(
            { terminal: { rows: 42 }, requestRender() {} },
            {
              fg: (_c: string, t: string) => t,
              bg: (_c: string, t: string) => t,
              bold: (t: string) => t,
            },
            {},
            close,
          );
          try {
            for (const query of ["bm25", "swarm", "rpc"]) {
              browser.input.setValue("");
              browser.handleInput(query);
              await new Promise((resolve) => setImmediate(resolve));
              const text = browser.render(160).map(stripTerminalSequences).join("\n");
              assert.match(
                text,
                new RegExp(expected[current]),
                `${current} finds ${query} from manifest metadata`,
              );
              assert.doesNotMatch(text, /PRIVATE_BODY|PRIVATE_DESCRIPTION|HUMAN_NOTE/);
            }
            browser.input.setValue("");
            browser.handleInput("secret-private-check");
            await new Promise((resolve) => setImmediate(resolve));
            assert.match(
              browser.render(160).map(stripTerminalSequences).join("\n"),
              /No matching resources/,
            );
            browser.handleInput("\x1b");
            return await done;
          } finally {
            browser.dispose();
          }
        },
      },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    for (current of ["skills", "agents", "instructions"])
      await commands.get(current)!.handler("", ctx);
  } finally {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedChild === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = savedChild;
    rmSync(root, { recursive: true, force: true });
  }
});
