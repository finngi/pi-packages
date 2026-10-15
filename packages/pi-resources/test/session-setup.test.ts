import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSetupContribution } from "pi-contracts";
import {
  installSessionSetup,
  planSessionSetup,
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_STATE,
  sessionSetupService,
  validateSessionSetupRequest,
} from "../lib/session-setup.ts";
import { resourcePickerControls } from "../lib/picker.ts";

const testRoot = mkdtempSync(join(tmpdir(), "pi-scope-engine-"));
const agentDir = join(testRoot, "agent");
mkdirSync(agentDir);
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(testRoot, { recursive: true, force: true });
});

const contributions: SessionSetupContribution[] = [
  {
    kind: "packages",
    candidates: [
      {
        kind: "packages",
        id: "corpus",
        name: "Corpus",
        description: "Evidence work",
        keywords: "bm25",
      },
    ],
    selected: [],
  },
  {
    kind: "skills",
    candidates: [
      { kind: "skills", id: "native", name: "Native", description: "Default skill" },
      {
        kind: "skills",
        id: "lexical",
        name: "Lexical",
        description: "Search documents",
        packName: "corpus",
      },
    ],
    selected: ["native"],
  },
  {
    kind: "agents",
    candidates: [
      {
        kind: "agents",
        id: "analyst",
        name: "Analyst",
        description: "Review records",
        packName: "corpus",
      },
    ],
    selected: [],
  },
  {
    kind: "instructions",
    candidates: [
      {
        kind: "instructions",
        id: "evidence",
        name: "Evidence",
        description: "Check source origins",
        packName: "corpus",
      },
    ],
    selected: [],
  },
];

function fixture() {
  writeFileSync(join(agentDir, "settings.json"), "{}");
  const cwd = mkdtempSync(join(testRoot, "project-"));
  mkdirSync(join(cwd, ".pi"));
  const save = (scope: "global" | "project", value: object) =>
    writeFileSync(
      scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json"),
      JSON.stringify(value),
    );
  const listeners = new Map<string, Array<(value: any) => void>>();
  let active = ["read", "write", "session_setup"],
    failAppend = false;
  const entries: any[] = [];
  const resources = structuredClone(contributions);
  const tools = ["read", "write", "session_setup", "deferred", "hidden"].map((name) => ({
    name,
    description: name,
    exposure: name === "hidden" ? "hidden" : name === "deferred" ? "deferred" : "direct",
  }));
  const events = {
    on(name: string, callback: (value: any) => void) {
      listeners.set(name, [...(listeners.get(name) ?? []), callback]);
    },
    emit(name: string, value: any) {
      for (const callback of listeners.get(name) ?? []) callback(value);
    },
  };
  events.on(SESSION_SETUP_CONTRIBUTIONS, (request) => resources.forEach(request.contribute));
  const hooks = new Map<string, Function>();
  const pi: any = {
    on(name: string, handler: Function) {
      hooks.set(name, handler);
    },
    events,
    registerTool() {},
    registerCommand() {},
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names.filter((name) =>
        tools.some((tool) => tool.name === name && tool.exposure === "direct"),
      );
    },
    appendEntry: (customType: string, data: unknown) => {
      if (failAppend) throw Error("storage failed");
      entries.push({ type: "custom", customType, data: structuredClone(data) });
    },
  };
  const ctx: any = {
    hasUI: false,
    mode: "tui",
    cwd,
    isProjectTrusted: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "first" },
  };
  const setup = installSessionSetup(pi);
  setup.restore(ctx);
  return {
    setup,
    save,
    events,
    hooks,
    pi,
    ctx,
    entries,
    resources,
    tools,
    failAppend: () => {
      failAppend = true;
    },
    active: () => [...active],
    setActive: (names: string[]) => {
      active = names;
    },
  };
}

test("a CLI tool pool excluding session setup keeps native tools and resource defaults", () => {
  const f = fixture();
  f.pi.getAllTools = () => [{ name: "read", description: "Read", exposure: "direct" }];
  f.pi.setActiveTools(["read"]);
  f.ctx.sessionManager.getSessionId = () => "restricted-new-session";
  f.ctx.sessionManager.getBranch = () => [];
  f.setup.restore(f.ctx);
  assert.deepEqual(f.pi.getActiveTools(), ["read"]);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.setup.execute({ op: "list" }, f.ctx).error, undefined);
});

test("bounded exact requests reject paths, malformed arrays and unsupported operations", () => {
  for (const value of [
    { op: "install" },
    { op: "apply", path: "/arbitrary" },
    { op: "apply", skills: [" x"] },
    { op: "apply", tools: ["read", "read"] },
    { op: "apply", skills: Array(251).fill("x") },
    { op: "list", query: "x".repeat(4097) },
    { op: "list", limit: 51 },
    { op: "reset", packages: [] },
  ])
    assert.throws(() => validateSessionSetupRequest(value));
});

test("packs replace only public resource subsets and explicit same-call IDs union without touching tools", () => {
  const catalogue: SessionSetupContribution[] = [
    ...contributions,
    {
      kind: "tools",
      candidates: [{ kind: "tools", id: "read", name: "read", description: "Read" }],
      selected: ["read"],
    },
  ];
  const original = { skills: ["native"], tools: ["read"] };
  const expanded = planSessionSetup(
    { op: "apply", packages: ["corpus"], skills: ["native"] },
    original,
    catalogue,
  );
  assert.deepEqual(expanded, {
    skills: ["lexical", "native"],
    agents: ["analyst"],
    instructions: ["evidence"],
    tools: ["read"],
  });
  assert.deepEqual(original, { skills: ["native"], tools: ["read"] });
  assert.deepEqual(planSessionSetup({ op: "apply", packages: [] }, expanded, catalogue), {
    skills: [],
    agents: [],
    instructions: [],
    tools: ["read"],
  });
  assert.throws(
    () => planSessionSetup({ op: "apply", skills: ["private-child"] }, {}, contributions),
    /Unknown or unavailable/,
  );
  assert.deepEqual(
    planSessionSetup(
      { op: "apply", packages: ["corpus"] },
      {},
      contributions.filter((value) => value.kind !== "instructions"),
    ),
    { skills: ["lexical"], agents: ["analyst"] },
    "Selecting an agent/skill package needs no instructions extension or invisible override",
  );
});

test("metadata search, atomic validation and recovery tool preserve actual native state", () => {
  const f = fixture();
  const list = f.setup.execute({ op: "list", query: "bm25", limit: 1 }, f.ctx);
  assert.equal(list.candidates[0]?.id, "corpus");
  assert.deepEqual(list.selected.skills, ["native"]);
  assert.throws(
    () => f.setup.execute({ op: "apply", skills: ["lexical"], agents: ["unknown"] }, f.ctx),
    /Unknown or unavailable/,
  );
  assert.equal(f.entries.length, 0);
  assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected.skills, ["native"]);
  const result = f.setup.execute({ op: "apply", skills: ["lexical"], tools: [] }, f.ctx);
  assert.deepEqual(result.selected.tools, ["session_setup"]);
  assert.deepEqual(sessionSetupService(f.pi.events)?.selection("skills"), ["lexical"]);
  assert.equal(f.entries.length, 1);
});

test("native unactivatable tools and failed persistence rollback without a committed override", () => {
  const f = fixture();
  assert.throws(
    () => f.setup.execute({ op: "apply", tools: ["hidden"] }, f.ctx),
    /Unknown or unavailable/,
  );
  assert.throws(
    () => f.setup.execute({ op: "apply", skills: ["lexical"], tools: ["deferred"] }, f.ctx),
    /Native tool activation refused/,
  );
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
  assert.equal(f.entries.length, 0);
  f.failAppend();
  assert.throws(
    () => f.setup.execute({ op: "apply", skills: ["lexical"], tools: [] }, f.ctx),
    /storage failed/,
  );
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
  assert.equal(f.entries.length, 0);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
});

test("branch restore preserves explicit choices and ignores unavailable resources", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", skills: ["lexical"], tools: [] }, f.ctx);
  f.setup.execute({ op: "apply", skills: [] }, f.ctx);
  f.setup.restore(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), []);
  const saved = structuredClone(f.entries);
  f.entries.length = 0;
  f.setup.restore(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
  f.entries.push(...saved, {
    type: "custom",
    customType: SESSION_SETUP_STATE,
    data: {
      version: 1,
      overrides: { skills: ["vanished"] },
      baseTools: ["read", "write", "session_setup"],
    },
  });
  f.setup.restore(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), []);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
  assert.equal(f.setup.execute({ op: "list" }, f.ctx).error, undefined);
  f.setup.execute({ op: "reset" }, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
});

test("new session identity captures its own baseline tools instead of the old session baseline", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", tools: [] }, f.ctx);
  f.entries.length = 0;
  f.setActive(["read", "session_setup"]);
  f.ctx.sessionManager.getSessionId = () => "second";
  f.setup.restore(f.ctx);
  f.setup.execute({ op: "apply", tools: [] }, f.ctx);
  f.setup.execute({ op: "reset" }, f.ctx);
  assert.deepEqual(f.active(), ["read", "session_setup"]);
});

test("removed registered baseline tools fail closed and reset recovers only the remaining ceiling", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", tools: ["write"] }, f.ctx);
  f.tools.splice(
    f.tools.findIndex((tool) => tool.name === "write"),
    1,
  );
  f.setup.restore(f.ctx);
  assert.deepEqual(f.active(), ["session_setup"]);
  assert.match(f.setup.execute({ op: "list" }, f.ctx).error!, /Unknown or unavailable/);
  f.setup.execute({ op: "reset" }, f.ctx);
  assert.deepEqual(f.active(), ["read", "session_setup"]);
});

test("trusted existing agent and instruction metadata refreshes without admitting new IDs or replacing public skill metadata", () => {
  const f = fixture();
  const agent = f.resources.find((value) => value.kind === "agents")!;
  agent.candidates[0].description = "CURRENT_AGENT_DESCRIPTION";
  agent.candidates[0].model = "fixture/pinned";
  agent.candidates[0].modelLocked = true;
  agent.candidates.push({
    kind: "agents",
    id: "new-agent",
    name: "new-agent",
    description: "Late addition",
  });
  f.resources.find((value) => value.kind === "instructions")!.candidates[0].description =
    "CURRENT_INSTRUCTION_DESCRIPTION";
  f.resources.find((value) => value.kind === "skills")!.candidates[0].description =
    "LATE_SKILL_DESCRIPTION";
  const list = f.setup.execute({ op: "list" }, f.ctx);
  assert.equal(
    list.candidates.find((candidate) => candidate.id === "analyst")!.description,
    "CURRENT_AGENT_DESCRIPTION",
  );
  assert.equal(list.candidates.find((candidate) => candidate.id === "analyst")!.modelLocked, true);
  assert.equal(
    list.candidates.find((candidate) => candidate.id === "evidence")!.description,
    "CURRENT_INSTRUCTION_DESCRIPTION",
  );
  assert.equal(
    list.candidates.find((candidate) => candidate.id === "native")!.description,
    "Default skill",
  );
  assert.throws(
    () => f.setup.execute({ op: "apply", agents: ["new-agent"] }, f.ctx),
    /Unknown or unavailable/,
  );
});

test("resetting one category preserves other overrides and active tools", () => {
  const f = fixture();
  f.setup.execute(
    {
      op: "apply",
      skills: ["lexical"],
      agents: ["analyst"],
      instructions: ["evidence"],
      tools: ["read"],
    },
    f.ctx,
  );
  const before = f.setup.execute({ op: "list" }, f.ctx).selected.tools;
  f.setup.execute({ op: "reset", kinds: ["agents"] }, f.ctx);
  assert.deepEqual(f.setup.selection("agents"), []);
  assert.deepEqual(f.setup.selection("skills"), ["lexical"]);
  assert.deepEqual(f.setup.selection("instructions"), ["evidence"]);
  assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected.tools, before);
});

test("startup and resume refresh defaults without recording them as explicit session choices", () => {
  const f = fixture();
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.entries.length, 0);
  f.save("global", { subagents: { skills: { native: false, lexical: true } } });
  assert.deepEqual(
    f.setup.selection("skills"),
    ["native"],
    "Active sessions keep their frozen defaults",
  );
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["lexical"]);
  assert.equal(f.entries.length, 0, "Refreshing defaults is not an explicit selection");
  f.setup.setState("skills", "native", "on", f.ctx);
  f.save("global", { subagents: { skills: { native: false, lexical: false } } });
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(
    f.setup.selection("skills"),
    ["native"],
    "Explicit session overrides survive resume",
  );
});

test("extensions reuse one explicit session setup owner", () => {
  const f = fixture();
  assert.equal(installSessionSetup(f.pi), f.setup);
});

test("package groups are available with an instructions provider and no picker or delegation", () => {
  const f = fixture();
  f.resources.splice(0, f.resources.length, {
    kind: "instructions",
    candidates: [
      {
        kind: "instructions",
        id: "evidence",
        name: "Evidence",
        description: "Check sources",
        packName: "corpus",
        globalDefaultable: false,
      },
    ],
    selected: [],
  });
  f.setup.restore(f.ctx, true);
  const groups = f.setup.execute({ op: "list", kinds: ["packages"] }, f.ctx).candidates;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, "corpus");
  assert.equal(groups[0].globalDefaultable, false);
  const receipt = f.setup.execute({ op: "apply", packages: ["corpus"] }, f.ctx);
  assert.deepEqual(receipt.selected.instructions, ["evidence"]);
  assert.equal(receipt.overrides.skills, undefined);
  assert.equal(receipt.overrides.agents, undefined);
});

test("absent providers do not become explicit empty selections at session birth", () => {
  const f = fixture();
  f.resources.splice(0, f.resources.length, {
    kind: "agents",
    candidates: [{ kind: "agents", id: "worker", name: "worker", description: "Work" }],
    selected: ["worker"],
  });
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("agents"), ["worker"]);
  assert.deepEqual(f.setup.selection("skills"), []);
  assert.deepEqual(f.setup.selection("instructions"), []);
  assert.equal(f.entries.length, 0, "No resolved defaults are saved as overrides");
});

test("derived grouping preserves explicit package metadata and rejects duplicate providers", () => {
  const f = fixture();
  const groups = f.setup.execute(
    { op: "list", kinds: ["packages"], query: "bm25" },
    f.ctx,
  ).candidates;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].description, "Evidence work");
  f.resources.push(structuredClone(f.resources[0]));
  assert.throws(() => f.setup.inspect(f.ctx), /Duplicate or invalid/);
});

test("unloaded providers disappear without changing saved session overrides or other tools", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", skills: ["lexical"] }, f.ctx);
  f.resources.splice(
    f.resources.findIndex((value) => value.kind === "skills"),
    1,
  );
  f.setup.restore(f.ctx, true);
  assert.equal(f.setup.execute({ op: "list" }, f.ctx).error, undefined);
  assert.deepEqual(f.setup.selection("skills"), []);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
  assert.deepEqual(f.entries.at(-1).data.overrides.skills, ["lexical"]);
});

for (const [kind, id] of [
  ["skills", "native"],
  ["agents", "analyst"],
  ["instructions", "evidence"],
] as const) {
  test(`${kind}: session, project and global choices override independently and inherit restores broader choices`, async () => {
    const f = fixture();
    const settings = (selected: boolean) =>
      kind === "instructions"
        ? { localContext: { instructions: { [id]: selected } } }
        : { subagents: { [kind]: { [id]: selected } } };
    f.save("global", settings(true));
    await f.setup.refresh(f.ctx);
    assert.equal(f.setup.state(kind, id).selected, true);
    assert.equal(f.setup.state(kind, id).effectiveSource, "global");
    f.save("project", settings(false));
    await f.setup.refresh(f.ctx);
    assert.equal(f.setup.state(kind, id).selected, false);
    assert.equal(f.setup.state(kind, id).globalState, "on");
    f.setup.setState(kind, id, "on", f.ctx);
    assert.equal(f.setup.state(kind, id).selected, true);
    assert.equal(f.setup.state(kind, id).projectState, "off");
    assert.equal(f.setup.state(kind, id).effectiveSource, "session");
    f.setup.setState(kind, id, "inherit", f.ctx);
    assert.equal(f.setup.state(kind, id).selected, false);
    assert.equal(f.setup.state(kind, id).sessionState, "inherit");
    f.save("project", {});
    await f.setup.refresh(f.ctx);
    assert.equal(f.setup.state(kind, id).selected, true);
    f.setup.setState(kind, id, "off", f.ctx);
    assert.equal(f.setup.state(kind, id).selected, false);
    assert.equal(f.setup.state(kind, id).globalState, "on");
    assert.deepEqual(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
      settings(true),
      "Session actions never rewrite global settings",
    );
  });
}

test("interactive-only uses native TUI mode, not RPC dialog availability; modes and selections remain independent", async () => {
  const f = fixture();
  f.save("global", {
    subagents: { skills: { native: true } },
    resourceSessionTypes: { skills: { native: "interactive" } },
  });
  await f.setup.refresh(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.setup.state("skills", "native").globalMode, "interactive");
  for (const mode of ["rpc", "print", "json"]) {
    f.ctx.mode = mode;
    f.ctx.hasUI = mode === "rpc";
    f.setup.restore(f.ctx, true);
    assert.deepEqual(
      f.setup.selection("skills"),
      [],
      `${mode} excludes interactive-only resources`,
    );
  }
  f.ctx.mode = "rpc";
  f.ctx.hasUI = true;
  f.save("project", { resourceSessionTypes: { skills: { native: "any" } } });
  await f.setup.refresh(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.setup.state("skills", "native").globalMode, "interactive");
  f.save("project", {});
  await f.setup.refresh(f.ctx);
  assert.equal(f.setup.state("skills", "native").globalState, "on");
  assert.deepEqual(f.setup.selection("skills"), []);
  f.setup.setState("skills", "native", "off", f.ctx);
  assert.equal(f.setup.state("skills", "native").sessionState, "off");
  f.ctx.mode = "tui";
  f.setup.restore(f.ctx, true);
  assert.deepEqual(f.setup.selection("skills"), []);
});

test("session types recorded by earlier session entries are ignored", () => {
  const f = fixture();
  f.save("global", { resourceSessionTypes: { skills: { native: "interactive" } } });
  f.entries.push({
    type: "custom",
    customType: SESSION_SETUP_STATE,
    data: {
      version: 2,
      overrides: {},
      states: {},
      modes: { skills: { native: "any" } },
      baseTools: ["read", "write"],
    },
  });
  f.ctx.mode = "rpc";
  f.setup.restore(f.ctx, true);
  assert.equal(f.setup.execute({ op: "list" }, f.ctx).error, undefined);
  assert.deepEqual(f.setup.selection("skills"), []);
  assert.equal(f.setup.state("skills", "native").modeSource, "global");
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
});

test("refreshing one session does not change another session's frozen defaults", async () => {
  const first = fixture();
  first.save("global", { subagents: { agents: { analyst: true } } });
  await first.setup.refresh(first.ctx);
  const second = fixture();
  second.save("global", { subagents: { agents: { analyst: false } } });
  await second.setup.refresh(second.ctx);
  assert.deepEqual(first.setup.selection("agents"), ["analyst"]);
  assert.deepEqual(second.setup.selection("agents"), []);
  await first.setup.refresh(first.ctx);
  assert.deepEqual(first.setup.selection("agents"), []);
});

test("resource refresh preserves tools changed by the native session", async () => {
  const f = fixture();
  f.setActive(["read", "session_setup"]);
  await f.setup.refresh(f.ctx);
  assert.deepEqual(f.active(), ["read", "session_setup"]);
});

test("bulk saves write ON/OFF only, so a later global session type still applies", async () => {
  const f = fixture();
  const entries = ["native", "lexical"].map((id) => ({
    id,
    name: id,
    description: id,
    selected: true,
    preview: async () => id,
  }));
  const controls = resourcePickerControls({
    ctx: f.ctx,
    setup: f.setup,
    entries,
    members: (entry) => [{ kind: "skills", id: entry.id, nativeDefault: true }],
  });
  await controls.saveDefaults(entries);
  const project = JSON.parse(readFileSync(join(f.ctx.cwd, ".pi", "settings.json"), "utf8"));
  assert.deepEqual(project.subagents.skills, { native: true, lexical: false });
  assert.equal(project.resourceSessionTypes, undefined);
  await controls.setMode(entries[0]!, "interactive", "global");
  const state = f.setup.state("skills", "native", true);
  assert.equal(state.mode, "interactive");
  assert.equal(state.modeSource, "global");
});
