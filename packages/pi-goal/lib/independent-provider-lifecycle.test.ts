import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { prepareChildProvider } from "../../pi-delegation/lib/subagent/child-provider.ts";
import { GoalAdmission } from "./continuation.ts";
import { GoalRequests } from "./usage.ts";

const model: Model<Api> = {
  id: "lifecycle",
  name: "Lifecycle fixture",
  provider: "lifecycle-fixture",
  api: "openai-responses",
  baseUrl: "http://invalid.local",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
};

function provider(name: string, call: () => unknown): Provider {
  return {
    id: model.provider,
    name,
    auth: { apiKey: "fixture-only" },
    getModels: () => [model],
    stream: () => "fixture-stream" as any,
    streamSimple: () => call() as any,
  } as unknown as Provider;
}

function nativeHarness(original: Provider) {
  let effective = original;
  let native: Provider | undefined = original;
  let config: any;
  let registrations = 0;
  let unregistrations = 0;
  const registry: any = {
    getAll: () => [model],
    getProvider: () => effective,
    getRegisteredNativeProvider: () => native,
    getRegisteredProviderConfig: () => config,
  };
  const pi: any = {
    registerProvider(providerOrId: Provider | string, next?: any) {
      registrations++;
      if (typeof providerOrId === "string") {
        config = { ...config, ...next };
        native = undefined;
        effective = { ...original, streamSimple: config.streamSimple };
      } else {
        config = undefined;
        native = providerOrId;
        effective = providerOrId;
      }
    },
    unregisterProvider() {
      unregistrations++;
      config = undefined;
      native = undefined;
      effective = original;
    },
  };
  return {
    pi,
    registry,
    current: () => ({ effective, native, config, registrations, unregistrations }),
    replaceNative(next: Provider) {
      native = next;
      effective = next;
    },
  };
}

function configHarness(initial: any) {
  let config = { ...initial };
  const rawStream = initial.streamSimple;
  let effective: Provider = {
    ...provider("Configured fixture", () => "unused"),
    streamSimple: rawStream,
  } as Provider;
  let registrations = 0;
  let unregistrations = 0;
  const registry: any = {
    getAll: () => [model],
    getProvider: () => effective,
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => config,
  };
  const pi: any = {
    registerProvider(providerOrId: Provider | string, next?: any) {
      registrations++;
      if (typeof providerOrId !== "string")
        throw Error("config fixture expects provider-id registration");
      config = { ...config, ...next };
      effective = {
        ...provider("Configured fixture", () => "unused"),
        streamSimple: config.streamSimple,
      } as Provider;
    },
    unregisterProvider() {
      unregistrations++;
      config = {};
      effective = {
        ...provider("Configured fixture", () => "unused"),
        streamSimple: rawStream,
      } as Provider;
    },
  };
  return {
    pi,
    registry,
    current: () => ({ effective, config, registrations, unregistrations }),
    partialUpdate(next: any) {
      config = { ...config, ...next };
      effective = {
        ...provider("Configured fixture", () => "unused"),
        streamSimple: config.streamSimple,
      } as Provider;
    },
    replaceStream(next: any) {
      config = { ...config, streamSimple: next };
      effective = {
        ...provider("Third-party config", () => "unused"),
        streamSimple: config.streamSimple,
      } as Provider;
    },
  };
}

const context = (registry: any) => ({ modelRegistry: registry }) as unknown as ExtensionContext;
const admissionFor = (pi: any) =>
  new GoalAdmission(pi as ExtensionAPI, new GoalRequests(), () => ({
    sessionId: "session",
    branchToken: "branch",
    disarmed: false,
  }));

test("native provider wrapper reloads once and cleanup preserves later provider ownership", () => {
  let delegatedCalls = 0;
  const original = provider("Original native fixture", () => {
    delegatedCalls++;
    return "original-simple";
  });
  const harness = nativeHarness(original);
  const admission = admissionFor(harness.pi);
  const ctx = context(harness.registry);

  admission.install(ctx);
  const firstWrapper = harness.current().effective;
  assert.notEqual(firstWrapper, original);
  admission.install(ctx);
  assert.equal(
    harness.current().effective,
    firstWrapper,
    "repeated install recognizes its current wrapper",
  );
  assert.equal(harness.current().registrations, 1);
  assert.equal(
    firstWrapper.streamSimple(model, { messages: [] } as any, {} as any),
    "original-simple",
  );
  assert.equal(delegatedCalls, 1);

  admission.dispose(ctx);
  assert.equal(
    harness.current().native,
    original,
    "cleanup restores the exact captured native provider",
  );
  assert.equal(harness.current().effective, original);
  admission.install(ctx);
  const secondWrapper = harness.current().effective;
  assert.notEqual(secondWrapper, firstWrapper, "reload wraps the restored original afresh");
  assert.equal(
    secondWrapper.streamSimple(model, { messages: [] } as any, {} as any),
    "original-simple",
  );
  assert.equal(delegatedCalls, 2, "reinstall does not nest wrappers");

  const thirdParty = provider("Later third-party fixture", () => "third-party");
  harness.replaceNative(thirdParty);
  const registrationCount = harness.current().registrations;
  admission.dispose(ctx);
  assert.equal(
    harness.current().native,
    thirdParty,
    "cleanup does not overwrite a later native registration",
  );
  assert.equal(harness.current().effective, thirdParty);
  assert.equal(harness.current().registrations, registrationCount);
});

test("configured callback provider remains observable, partial updates survive cleanup, and callback replacement survives", () => {
  let callbackCalls = 0;
  const rawCallback = () => {
    callbackCalls++;
    return "configured-callback";
  };
  const initial = {
    api: model.api,
    apiKey: "fixture-only",
    baseUrl: model.baseUrl,
    models: [model],
    streamSimple: rawCallback,
  };
  const harness = configHarness(initial);
  const admission = admissionFor(harness.pi);
  const ctx = context(harness.registry);

  admission.install(ctx);
  const guardedCallback = harness.current().config.streamSimple;
  assert.notEqual(guardedCallback, rawCallback);
  assert.equal(harness.current().config.apiKey, "fixture-only");
  assert.equal(
    harness.current().effective.streamSimple(model, { messages: [] } as any, {} as any),
    "configured-callback",
  );
  assert.equal(callbackCalls, 1);
  admission.install(ctx);
  assert.equal(
    harness.current().config.streamSimple,
    guardedCallback,
    "repeated install does not nest the configured stream wrapper",
  );

  harness.partialUpdate({ baseUrl: "http://changed.invalid" });
  admission.install(ctx);
  assert.equal(
    harness.current().config.streamSimple,
    guardedCallback,
    "unrelated config merge retains the installed guard",
  );
  admission.dispose(ctx);
  assert.equal(
    harness.current().config.streamSimple,
    rawCallback,
    "cleanup restores the original configured callback",
  );
  assert.equal(
    harness.current().config.baseUrl,
    "http://changed.invalid",
    "cleanup retains another owner's partial config update",
  );
  assert.equal(
    harness.current().effective.streamSimple(model, { messages: [] } as any, {} as any),
    "configured-callback",
  );
  assert.equal(callbackCalls, 2);

  admission.install(ctx);
  const nextGuard = harness.current().config.streamSimple;
  const thirdPartyCallback = () => "third-party callback";
  harness.replaceStream(thirdPartyCallback);
  admission.dispose(ctx);
  assert.equal(
    harness.current().config.streamSimple,
    thirdPartyCallback,
    "cleanup preserves a later callback registration",
  );
  assert.notEqual(nextGuard, thirdPartyCallback);
});

test("transparent guards preserve stock child transfer and keep custom providers nontransferable", async () => {
  const makeRegistry = (native: Provider | undefined, config?: any): ModelRegistry =>
    ({
      find: () => model,
      getRegisteredNativeProvider: () => native,
      getRegisteredProviderConfig: () => config,
      getApiKeyAndHeaders: async () => {
        throw Error("Native preparation must not resolve credentials");
      },
    }) as unknown as ModelRegistry;

  const stock = provider("Stock adapter", () => "stock");
  let registeredStock: Provider | undefined;
  const stockRegistry: any = {
    getAll: () => [model],
    getProvider: () => stock,
    getRegisteredNativeProvider: () => registeredStock,
    getRegisteredProviderConfig: () => undefined,
  };
  const stockAdmission = admissionFor({
    registerProvider: (wrapped: Provider) => {
      registeredStock = wrapped;
    },
  });
  stockAdmission.install(context(stockRegistry));
  const transferredStock = prepareChildProvider(makeRegistry(registeredStock), {
    provider: model.provider,
    id: model.id,
  });
  assert.equal(
    transferredStock?.model.id,
    model.id,
    "transparent stock wrapper retains normal native model configuration",
  );

  const customNative = provider("Custom extension callback", () => "custom");
  const customHarness = nativeHarness(customNative);
  const customApi: any = {
    registerProvider: (wrapped: Provider) => {
      customHarness.replaceNative(wrapped);
    },
  };
  const customAdmission = admissionFor(customApi);
  customAdmission.install(context(customHarness.registry));
  assert.throws(
    () =>
      prepareChildProvider(makeRegistry(customHarness.current().native), {
        provider: model.provider,
        id: model.id,
      }),
    /trusted native extension entrypoint/,
    "transparent wrapper keeps a genuine extension callback nontransferable",
  );
});
