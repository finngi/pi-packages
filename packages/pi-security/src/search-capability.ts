import { permitsNetwork, networkAllows } from "./permissions.ts";
import type { Bindings } from "./gate.ts";
import type { LoadedPolicy, CallInput } from "./types.ts";
export interface SearchSpec {
  toolCallId: string;
  input: CallInput;
  signal?: AbortSignal;
}
export interface SearchCapability {
  origin: string;
  signal: AbortSignal;
  assertCurrent(params: unknown): void;
  release(): void;
  dispatch<T>(
    params: unknown,
    url: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
import { inputHash } from "./gate.ts";
export const searchOrigin = "https://chatgpt.com";
const paths = new Set(["/backend-api/codex/models", "/backend-api/codex/responses"]);
export function createSearchCapabilities({
  bindings,
  getLoaded,
}: {
  bindings: Bindings;
  getLoaded: () => LoadedPolicy | undefined;
}) {
  const live = new Map<string, SearchCapability>();
  let closed = false;
  return {
    prepareSearch({ toolCallId, input, signal, ...extra }: SearchSpec) {
      if (
        Object.keys(extra).length ||
        typeof toolCallId !== "string" ||
        !input ||
        typeof input !== "object" ||
        Array.isArray(input)
      )
        throw Error("invalid search preparation request");
      if (live.has(toolCallId)) throw Error("duplicate search capability");
      if (closed || signal?.aborted) throw Error("search capability unavailable");
      const loaded = getLoaded();
      if (!loaded) throw Error("search policy unavailable");
      const binding = bindings.take(toolCallId, "codex_search", input);
      const grantsHost =
        !!binding.decision.permissions &&
        permitsNetwork(binding.decision.permissions, new URL(searchOrigin));
      if (
        !grantsHost ||
        !binding.decision.permissions ||
        !binding.decision.permissions.network.length ||
        !networkAllows(loaded.policy.resources.network, new URL(searchOrigin))
      )
        throw Error("search requires approved chatgpt.com network permission");
      const controller = new AbortController(),
        hash = inputHash("codex_search", input);
      let current = true;
      const release = () => {
        if (!current) return;
        current = false;
        live.delete(toolCallId);
        signal?.removeEventListener("abort", release);
        controller.abort();
      };
      signal?.addEventListener("abort", release, { once: true });
      const assertCurrent = (params: unknown) => {
        if (!current || closed || controller.signal.aborted || getLoaded() !== loaded) {
          release();
          throw Error("search capability expired");
        }
        if (inputHash("codex_search", params) !== hash)
          throw Error("search capability input differs");
      };
      const capability: SearchCapability = {
        origin: searchOrigin,
        signal: controller.signal,
        assertCurrent,
        release,
        async dispatch<T>(
          params: unknown,
          url: string,
          operation: (signal: AbortSignal) => Promise<T>,
        ) {
          assertCurrent(params);
          const parsed = new URL(url);
          if (
            parsed.origin !== searchOrigin ||
            parsed.username ||
            parsed.password ||
            parsed.hash ||
            !paths.has(parsed.pathname) ||
            (parsed.search &&
              !(
                parsed.pathname.endsWith("/models") &&
                [...parsed.searchParams.keys()].length === 1 &&
                parsed.searchParams.has("client_version") &&
                /^[\w.-]{1,64}$/.test(parsed.searchParams.get("client_version") ?? "")
              ))
          )
            throw Error("search destination refused");
          if (typeof operation !== "function") throw Error("invalid search operation");
          const result = await operation(controller.signal);
          assertCurrent(params);
          return result;
        },
      };
      live.set(toolCallId, capability);
      return capability;
    },
    release(id: string) {
      live.get(id)?.release();
    },
    revoke() {
      for (const capability of [...live.values()]) capability.release();
    },
    close() {
      closed = true;
      for (const capability of [...live.values()]) capability.release();
    },
  };
}
