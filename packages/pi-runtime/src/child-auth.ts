import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChildAuth, ChildAuthOptions, SelectedModel } from "pi-contracts";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { providerRegistrationForTransfer } from "./provider-transfer.ts";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
export async function resolveChildAuth(
  registry: ModelRegistry,
  selected: SelectedModel,
  { fixtureProviderExtension }: ChildAuthOptions = {},
): Promise<ChildAuth> {
  const model = registry.find(selected.provider, selected.id);
  if (!model) throw Error("child model unavailable");
  const { config, native } = providerRegistrationForTransfer(
    registry.getRegisteredNativeProvider?.(selected.provider),
    registry.getRegisteredProviderConfig?.(selected.provider),
  );
  const callback =
    native ||
    ["streamSimple", "images", "classifiers", "refreshModels", "oauth"].some(
      (key) => (config as unknown as Record<string, unknown> | undefined)?.[key],
    );
  const supported = [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
    "google-generative-ai",
    "google-vertex",
    "mistral-conversations",
    "bedrock-converse-stream",
    "pi-messages",
  ].includes(model.api);
  if ((callback || !supported) && !fixtureProviderExtension)
    throw Error("child custom provider cannot be transferred; requires trusted provider adapter");
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth?.ok) throw Error("child selected provider authentication unavailable");
  const plain = JSON.stringify({ model, auth });
  if (plain.length > 1024 * 1024) throw Error("child authentication configuration too large");
  return { ...JSON.parse(plain), ...(callback || !supported ? { fixture: true } : {}) };
}
export async function resolveClassifierAuth(
  registry: ModelRegistry,
  requested: string,
  options: ChildAuthOptions = {},
) {
  const model = registry
    .getAll()
    .find((m) => m.id === requested || `${m.provider}/${m.id}` === requested);
  if (!model) throw Error("child classifier unavailable or unsupported provider adapter");
  return resolveChildAuth(registry, { provider: model.provider, id: model.id }, options);
}
export default async function childAuth(pi: ExtensionAPI) {
  const payload = JSON.parse(
    process.env.PI_CHILD_AUTH ?? process.env.PI_SECURITY_CHILD_AUTH ?? "null",
  );
  if (
    !payload ||
    payload.version !== 1 ||
    typeof payload.path !== "string" ||
    typeof payload.sha256 !== "string"
  )
    throw Error("missing child authentication payload");
  const bytes = await readFile(payload.path);
  if (createHash("sha256").update(bytes).digest("hex") !== payload.sha256)
    throw Error("child authentication hash mismatch");
  const payloadAuth = JSON.parse(bytes.toString("utf8")) as Partial<ChildAuth> & {
      classifier?: ChildAuth;
    },
    selected = [
      ...(payloadAuth.model ? [payloadAuth as ChildAuth] : []),
      ...(payloadAuth.classifier ? [payloadAuth.classifier] : []),
    ];
  const providers = new Map<
    string,
    {
      model: ChildAuth["model"];
      auth: ChildAuth["auth"];
      api: NonNullable<ReturnType<typeof getApiProvider>>;
    }[]
  >();
  for (const { model, auth } of selected) {
    const api = getApiProvider(model.api);
    if (!api) throw Error("child API adapter unavailable");
    const effective = { ...model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) };
    const entries = providers.get(model.provider) ?? [];
    entries.push({ model: effective, auth, api });
    providers.set(model.provider, entries);
  }
  for (const [provider, entries] of providers)
    pi.registerProvider(provider, {
      api: entries[0].model.api,
      apiKey: "resolved-child-auth",
      baseUrl: entries[0].model.baseUrl,
      models: entries.map((x) => x.model),
      streamSimple: (requested, context, options) => {
        const entry = entries.find(
          (x) => requested.id === x.model.id && requested.provider === x.model.provider,
        );
        if (!entry) throw Error("child authentication selected model mismatch");
        return entry.api.streamSimple(entry.model, context, {
          ...options,
          apiKey: entry.auth.apiKey,
          headers: { ...options?.headers, ...entry.auth.headers },
          ...(entry.auth.env ? { env: entry.auth.env } : {}),
        });
      },
    });
}
