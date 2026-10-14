import type { ChildSpec, ParentResources, ChildResources } from "./types.ts";
import { resolveChildResources as resolve } from "pi-runtime";
export { childTools, installChildResources } from "pi-runtime";
export function resolveChildResources(spec: ChildSpec, parent?: ParentResources): ChildResources {
  const resources = resolve(spec, parent);
  return {
    ...resources,
    ...(spec.permissionMode === undefined
      ? { permissionMode: undefined }
      : { permissionMode: spec.permissionMode }),
  };
}
