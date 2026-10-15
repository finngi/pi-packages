import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { createChildRuntime } from "./child-rpc.ts";
import { prepareChildProvider } from "./child-provider.ts";

const ai = import.meta.resolve("@earendil-works/pi-ai");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-child-native-rpc-"));
  const native = join(root, "native"),
    child = join(root, "child");
  await Promise.all([mkdir(native), mkdir(child)]);
  const previous = new Map(
    ["PI_CHILD_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_CHILD_PROVIDER_CONFIG"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  process.env.PI_CHILD_AGENT_DIR = native;
  process.env.PI_CODING_AGENT_DIR = child;
  delete process.env.PI_CHILD_PROVIDER_CONFIG;
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModels("openai-codex")[0];
  assert.ok(model);
  const credential = (access: string) => ({
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "fixture-refresh-never-used",
      expires: Date.now() + 60 * 60 * 1000,
    },
  });
  await writeFile(join(native, "auth.json"), JSON.stringify(credential("native-first")));
  return {
    root,
    native,
    child,
    model,
    credential,
    args: ["--mode", "rpc", "--provider", model.provider, "--model", model.id, "--tools", "read"],
    async cleanup() {
      for (const [name, value] of previous)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("child resolves and refreshes OAuth through the original native backing without credential copies", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    runtime = await createChildRuntime(f.args);
    const registry = new ModelRegistry(runtime.services.modelRuntime);
    const first = await registry.getProviderAuth("openai-codex");
    assert.equal(first?.source, "OAuth");
    assert.equal(first?.auth.apiKey, "native-first");
    assert.equal(
      runtime.services.modelRuntime.getRegisteredProviderConfig("openai-codex"),
      undefined,
    );
    await writeFile(join(f.native, "auth.json"), JSON.stringify(f.credential("native-second")));
    const next = await registry.getProviderAuth("openai-codex");
    assert.equal(next?.source, "OAuth");
    assert.equal(next?.auth.apiKey, "native-second");
    assert.equal((await readdir(f.child)).includes("auth.json"), false);
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("native authentication retains selected same-id metadata and other model types", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    await writeFile(
      join(f.native, "auth.json"),
      JSON.stringify({
        ...f.credential("native-first"),
        openai: { type: "api_key", key: "fixture-openai-key" },
      }),
    );
    const parent = await ModelRuntime.create({
      authPath: join(f.native, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const original = parent.getModels("openai")[0];
    const catalogue = parent.getAllModels("openai");
    assert.ok(catalogue.some((model) => model.type === "classifier"));
    const selected = {
      ...original,
      baseUrl: "https://fixture-parent.invalid/backend",
      contextWindow: 12345,
    };
    parent.registerProvider(original.provider, {
      models: catalogue.map((model) =>
        model.id === selected.id && (model.type ?? "chat") === "chat" ? selected : model,
      ),
    });
    const providerPath = join(f.root, "provider.json");
    await writeFile(
      providerPath,
      JSON.stringify(prepareChildProvider(new ModelRegistry(parent), selected)),
    );
    process.env.PI_CHILD_PROVIDER_CONFIG = providerPath;
    runtime = await createChildRuntime([
      "--provider",
      selected.provider,
      "--model",
      selected.id,
      "--tools",
      "read",
    ]);
    assert.equal(runtime.session.model?.baseUrl, selected.baseUrl);
    assert.equal(runtime.session.model?.contextWindow, selected.contextWindow);
    const identity = (model: { type?: string; id: string }) =>
      `${model.type ?? "chat"}:${model.id}`;
    assert.deepEqual(
      runtime.services.modelRuntime.getAllModels("openai").map(identity).sort(),
      catalogue.map(identity).sort(),
    );
    const registration = runtime.services.modelRuntime.getRegisteredProviderConfig("openai");
    assert.equal(registration?.apiKey, undefined);
    assert.equal(registration?.streamSimple, undefined);
    const oauth = await runtime.services.modelRuntime.getAuth("openai-codex");
    assert.equal(oauth?.source, "OAuth");
    assert.equal(oauth?.auth.apiKey, "native-first");
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("static provider routing headers retain native model precedence and OAuth refresh", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    await writeFile(
      join(f.native, "models.json"),
      JSON.stringify({
        providers: {
          "openai-codex": {
            modelOverrides: { [f.model.id]: { headers: { "X-Fixture-Priority": "model" } } },
          },
        },
      }),
    );
    const parent = await ModelRuntime.create({
      authPath: join(f.native, "auth.json"),
      modelsPath: join(f.native, "models.json"),
      allowModelNetwork: false,
    });
    const providerHeaders = {
      "x-fixture-routing": "parent-selected",
      "X-Fixture-Priority": "provider",
    };
    parent.registerProvider(f.model.provider, { headers: providerHeaders });
    const providerPath = join(f.root, "provider.json");
    const configuration = prepareChildProvider(new ModelRegistry(parent), f.model);
    assert.deepEqual(configuration?.config?.headers, providerHeaders);
    assert.equal(Object.hasOwn(configuration!, "auth"), false);
    await writeFile(providerPath, JSON.stringify(configuration));
    process.env.PI_CHILD_PROVIDER_CONFIG = providerPath;
    runtime = await createChildRuntime(f.args);
    const registry = new ModelRegistry(runtime.services.modelRuntime);
    const resolved = await registry.getApiKeyAndHeaders(runtime.session.model!);
    assert.ok(resolved.ok);
    assert.equal(resolved.headers?.["x-fixture-routing"], "parent-selected");
    assert.equal(resolved.headers?.["X-Fixture-Priority"], "model");
    assert.equal((await registry.getProviderAuth(f.model.provider))?.source, "OAuth");
    await writeFile(join(f.native, "auth.json"), JSON.stringify(f.credential("native-second")));
    const next = await registry.getApiKeyAndHeaders(runtime.session.model!);
    assert.ok(next.ok);
    assert.equal(next.apiKey, "native-second");
    assert.equal(next.headers?.["x-fixture-routing"], "parent-selected");
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("native child and another runtime serialize OAuth refresh through the original file lock", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    runtime = await createChildRuntime(f.args);
    const other = await ModelRuntime.create({
      authPath: join(f.native, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    let refreshes = 0;
    for (const current of [runtime.services.modelRuntime, other]) {
      const provider = current.getProvider("openai-codex")!;
      current.registerNativeProvider({
        ...provider,
        auth: {
          oauth: {
            ...provider.auth.oauth!,
            async refresh(credential) {
              refreshes++;
              await new Promise((resolve) => setTimeout(resolve, 20));
              return {
                ...credential,
                access: "fixture-refreshed",
                expires: Date.now() + 3_600_000,
              };
            },
          },
        },
      });
    }
    const expired = f.credential("fixture-expired");
    expired["openai-codex"].expires = Date.now() - 1;
    await writeFile(join(f.native, "auth.json"), JSON.stringify(expired));
    const resolved = await Promise.all([
      runtime.services.modelRuntime.getAuth("openai-codex"),
      other.getAuth("openai-codex"),
    ]);
    assert.equal(refreshes, 1);
    assert.ok(
      resolved.every(
        (auth) => auth?.source === "OAuth" && auth.auth.apiKey === "fixture-refreshed",
      ),
    );
    assert.equal(
      JSON.parse(await readFile(join(f.native, "auth.json"), "utf8"))["openai-codex"].access,
      "fixture-refreshed",
    );
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("child loads only explicit native extension files and honors the native tool allowlist", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    const unrelated = join(f.root, "unrelated.mjs");
    const sentinel = join(f.root, "unrelated-loaded");
    await writeFile(
      unrelated,
      `import {writeFileSync} from 'node:fs'; export default () => writeFileSync(${JSON.stringify(sentinel)}, 'loaded');`,
    );
    const settings = JSON.stringify({
      packages: ["npm:must-not-be-installed-child-fixture"],
      extensions: [unrelated],
    });
    await writeFile(join(f.native, "settings.json"), settings);
    await writeFile(join(f.child, "settings.json"), settings);
    const selected = join(f.root, "selected.mjs");
    await writeFile(
      selected,
      `import {Type} from ${JSON.stringify(ai)};
export default function(pi) {
  for (const name of ['selected_fixture', 'unselected_sibling']) pi.registerTool({name, label:name, description:name, parameters:Type.Object({}), execute:async()=>({content:[{type:'text',text:name}]})});
}`,
    );
    runtime = await createChildRuntime([
      ...f.args,
      "--tools",
      "read,selected_fixture",
      "-e",
      selected,
    ]);
    assert.deepEqual(runtime.session.getActiveToolNames().sort(), ["read", "selected_fixture"]);
    assert.equal(
      runtime.session.getAllTools().some(({ name }) => name === "unselected_sibling"),
      false,
    );
    assert.deepEqual(runtime.services.settingsManager.getSettings(), {});
    assert.equal(await readFile(sentinel, "utf8").catch(() => undefined), undefined);
    assert.equal(await readFile(join(f.native, "settings.json"), "utf8"), settings);
    assert.equal(await readFile(join(f.child, "settings.json"), "utf8"), settings);
    assert.equal(runtime.session.getSessionStats().sessionFile, undefined);
    assert.equal(await readFile(join(f.native, "package.json")).catch(() => undefined), undefined);
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("child refuses package sources before the native loader can install them", async () => {
  await assert.rejects(
    createChildRuntime(["-e", "npm:never-install-this"]),
    /prepared absolute paths/,
  );
});

test("native tool search loads explicitly without widening the child tool list", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    runtime = await createChildRuntime([
      ...f.args,
      "--tools",
      "tool_search",
      "-e",
      "builtin:tool-search",
    ]);
    assert.deepEqual(runtime.session.getActiveToolNames(), ["tool_search"]);
    const tools = runtime.session.getAllTools();
    assert.equal(
      tools.find(({ name }) => name === "tool_search")?.sourceInfo.path,
      "builtin:tool-search",
    );
    assert.equal(
      tools.some(({ name }) => name === "read"),
      false,
    );
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("prepared child entrypoint serves the stock RPC protocol without saving a session", async () => {
  const f = await fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.resolve("pi-delegation/child-rpc")), ...f.args],
      {
        cwd: f.root,
        env: process.env,
        input: '{"type":"get_state","id":"state"}\n',
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const response = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((value) => value.id === "state");
    assert.equal(response?.success, true);
    assert.equal(response.data.model.provider, "openai-codex");
    assert.equal(response.data.model.id, f.model.id);
    assert.equal(response.data.sessionFile, undefined);
    assert.equal((await readdir(f.child)).includes("sessions"), false);
  } finally {
    await f.cleanup();
  }
});

test("explicit native provider extensions retain executable stream registration", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    const provider = join(f.root, "provider.mjs");
    const model = {
      ...f.model,
      provider: "child-fixture",
      id: "fixture",
      api: "openai-completions",
    };
    await writeFile(
      provider,
      `export default pi => pi.registerProvider('child-fixture', {api:'openai-completions',apiKey:'fixture',baseUrl:'http://localhost',models:[${JSON.stringify(model)}],streamSimple(){throw Error('fixture stream')}});`,
    );
    runtime = await createChildRuntime([
      "--provider",
      model.provider,
      "--model",
      model.id,
      "--tools",
      "read",
      "-e",
      provider,
    ]);
    assert.equal(
      runtime.services.modelRuntime.getRegisteredProviderConfig(model.provider)?.apiKey,
      "fixture",
    );
    assert.equal(runtime.session.model?.id, model.id);
    const independent = await new ModelRegistry(runtime.services.modelRuntime).getProviderAuth(
      "openai-codex",
    );
    assert.equal(independent?.source, "OAuth");
    assert.equal(independent?.auth.apiKey, "native-first");
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});

test("ephemeral native provider configuration uses native authentication without a fallback stream", async () => {
  const f = await fixture();
  let runtime: Awaited<ReturnType<typeof createChildRuntime>> | undefined;
  try {
    const model = { ...f.model, provider: "sdk-only", id: "selected", api: "openai-completions" };
    const parent = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    parent.registerProvider(model.provider, {
      api: model.api,
      apiKey: "fixture-sdk-key",
      models: [model],
    });
    const configPath = join(f.root, "provider.json");
    await writeFile(
      configPath,
      JSON.stringify(prepareChildProvider(new ModelRegistry(parent), model)),
    );
    process.env.PI_CHILD_PROVIDER_CONFIG = configPath;
    runtime = await createChildRuntime([
      "--provider",
      model.provider,
      "--model",
      model.id,
      "--tools",
      "read",
    ]);
    assert.equal(runtime.session.model?.provider, model.provider);
    assert.equal(runtime.session.model?.id, model.id);
    assert.equal(
      runtime.services.modelRuntime.getRegisteredProviderConfig(model.provider)?.streamSimple,
      undefined,
    );
    assert.equal(
      (await runtime.services.modelRuntime.getAuth(model.provider))?.auth.apiKey,
      "fixture-sdk-key",
    );
    parent.registerProvider(model.provider, {
      api: model.api,
      streamSimple() {
        throw Error("fixture callback");
      },
    });
    assert.throws(
      () => prepareChildProvider(new ModelRegistry(parent), model),
      /callbacks require/,
    );
    assert.equal(
      prepareChildProvider(new ModelRegistry(parent), model, "/trusted/provider.ts"),
      undefined,
    );
  } finally {
    await runtime?.dispose();
    await f.cleanup();
  }
});
