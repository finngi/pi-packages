import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSetupContribution } from "pi-contracts";
import {
  installSessionSetup,
  planSessionSetup,
  SESSION_SETUP_CONTRIBUTIONS,
  SESSION_SETUP_STATE,
  sessionSetupService,
  validateSessionSetupRequest,
} from "../src/session-setup.ts";

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
    sessionManager: { getBranch: () => entries, getSessionId: () => "first" },
  };
  const setup = installSessionSetup(pi);
  setup.restore(ctx);
  return {
    setup,
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
  assert.equal(f.setup.selection("skills"), undefined);
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
  assert.equal(f.setup.selection("skills"), undefined);
});

test("current branch restores latest entry, branch without entry resets and invalid IDs fail closed", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", skills: ["lexical"], tools: [] }, f.ctx);
  f.setup.execute({ op: "apply", skills: [] }, f.ctx);
  f.setup.restore(f.ctx);
  assert.deepEqual(f.setup.selection("skills"), []);
  const saved = structuredClone(f.entries);
  f.entries.length = 0;
  f.setup.restore(f.ctx);
  assert.equal(f.setup.selection("skills"), undefined);
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
  assert.deepEqual(f.active(), ["session_setup"]);
  assert.match(f.setup.execute({ op: "list" }, f.ctx).error!, /Unknown or unavailable/);
  f.setup.execute({ op: "reset" }, f.ctx);
  assert.equal(f.setup.selection("skills"), undefined);
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
  assert.equal(f.setup.selection("agents"), undefined);
  assert.deepEqual(f.setup.selection("skills"), ["lexical"]);
  assert.deepEqual(f.setup.selection("instructions"), ["evidence"]);
  assert.deepEqual(f.setup.execute({ op: "list" }, f.ctx).selected.tools, before);
});

test("starting defaults are recorded once and survive resume after personal defaults change", () => {
  const f = fixture();
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.entries.length, 1);
  f.resources.find((value) => value.kind === "skills")!.selected = ["lexical"];
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.equal(f.entries.length, 1, "Restoring must not append another baseline");
  f.ctx.sessionManager.getSessionId = () => "new";
  const oldBranch = [...f.entries];
  f.entries.length = 0;
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["lexical"]);
  f.entries.splice(0, f.entries.length, ...oldBranch);
  f.ctx.sessionManager.getSessionId = () => "first";
  f.hooks.get("resources_discover")!({}, f.ctx);
  assert.deepEqual(f.setup.selection("skills"), ["native"]);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
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
  assert.equal(f.setup.selection("skills"), undefined);
  assert.equal(f.setup.selection("instructions"), undefined);
  assert.deepEqual(f.entries[0].data.overrides, { agents: ["worker"] });
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

test("resuming saved choices without their provider names the missing extension and reset remedy", () => {
  const f = fixture();
  f.setup.execute({ op: "apply", skills: ["lexical"] }, f.ctx);
  f.resources.splice(
    f.resources.findIndex((value) => value.kind === "skills"),
    1,
  );
  f.setup.restore(f.ctx, true);
  assert.match(
    f.setup.execute({ op: "list" }, f.ctx).error!,
    /No skills provider is loaded.*Load pi-resources.*session_setup reset/,
  );
  assert.deepEqual(f.active(), ["session_setup"]);
  f.setup.execute({ op: "reset" }, f.ctx);
  assert.equal(f.setup.execute({ op: "list" }, f.ctx).error, undefined);
  assert.deepEqual(f.active(), ["read", "write", "session_setup"]);
});
