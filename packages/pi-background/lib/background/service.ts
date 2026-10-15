import type { BackgroundService, LaunchSpec } from "pi-contracts";
import { BACKGROUND_SERVICE } from "pi-contracts";

export type { BackgroundService } from "pi-contracts";

interface Events {
  emit(name: string, value: unknown): void;
}
export interface ServiceRequest {
  respond: (service: BackgroundService) => void;
}
/** Capability discovery for trusted extensions. No model parameters cross this interface. */
export function backgroundService(events: Events): BackgroundService {
  let service: BackgroundService | undefined;
  events.emit(BACKGROUND_SERVICE, {
    respond: (found: BackgroundService) => {
      service = found;
    },
  } satisfies ServiceRequest);
  if (!service) throw new Error("Background process extension is not loaded");
  return service;
}
/** Discover the session capability and launch a caller-admitted process. */
export function launchBackground(
  events: Events,
  spec: LaunchSpec,
  options?: { notify?: boolean; notifyIfCurrent?: () => boolean },
) {
  return backgroundService(events).launch(spec, options);
}
