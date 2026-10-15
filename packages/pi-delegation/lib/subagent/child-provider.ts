import type { ExtensionAPI, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SelectedModel } from "pi-contracts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { providerRegistrationForTransfer } from "pi-runtime/provider-transfer";

export interface ChildProvider {
  model: Model<Api>;
  config?: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>;
}

/** Transfer native configuration, never a resolved OAuth/access-token snapshot or a stream adapter. */
export function prepareChildProvider(
  registry: ModelRegistry,
  selected: SelectedModel,
  providerExtension?: string,
): ChildProvider | undefined {
  const model = registry.find(selected.provider, selected.id);
  if (!model) throw Error("Selected child model is unavailable");
  const { native, config } = providerRegistrationForTransfer(
    registry.getRegisteredNativeProvider(selected.provider),
    registry.getRegisteredProviderConfig(selected.provider),
  );
  // Executable provider callbacks must be loaded from a trusted native extension entrypoint.
  if (providerExtension) return undefined;
  if (native) throw Error("Child provider requires its trusted native extension entrypoint");
  const value = { model, ...(config ? { config } : {}) } as ChildProvider;
  const encoded = JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "function")
      throw Error("Child provider callbacks require a trusted native extension entrypoint");
    return entry;
  });
  if (Buffer.byteLength(encoded) > 1024 * 1024)
    throw Error("Child provider configuration too large");
  return JSON.parse(encoded) as ChildProvider;
}

/** Apply model/header overrides through Pi; authentication remains owned by its native runtime. */
export function installChildProvider(
  pi: ExtensionAPI,
  runtime: ModelRuntime,
  value: ChildProvider,
) {
  const provider = value.model.provider;
  const models = new Map<
    string,
    NonNullable<NonNullable<ChildProvider["config"]>["models"]>[number]
  >(runtime.getAllModels(provider).map((model) => [`${model.type ?? "chat"}:${model.id}`, model]));
  for (const model of value.config?.models ?? [])
    models.set(`${model.type ?? "chat"}:${model.id}`, model);
  models.set(`${value.model.type ?? "chat"}:${value.model.id}`, value.model);
  pi.registerProvider(provider, { ...value.config, models: [...models.values()] });
}
