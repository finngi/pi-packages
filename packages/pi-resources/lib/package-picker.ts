import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
  type ResourceEntry,
} from "pi-resource-browser";
import type { installSessionSetup } from "pi-resources/session-setup";
import { resourcePickerControls, type PickerMember } from "./picker.ts";

const kinds = ["skills", "agents", "instructions"] as const;

export function registerPackagePicker(
  pi: ExtensionAPI,
  setup: ReturnType<typeof installSessionSetup>,
  diagnostics: () => string[],
) {
  pi.registerCommand("packages", {
    description:
      "Select package guidance for this session; save project or personal defaults explicitly",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const inspect = () => setup.inspect(ctx);
      const contributions = inspect();
      const candidates = contributions
        .flatMap((value) => value.candidates)
        .filter((candidate) => kinds.includes(candidate.kind as (typeof kinds)[number]));
      const members = (id: string) => candidates.filter((candidate) => candidate.packName === id);
      const entries: ResourceEntry[] = contributions
        .filter((value) => value.kind === "packages")
        .flatMap((value) => value.candidates)
        .map((pack) => ({
          id: pack.id,
          name: pack.name.replace(/^@[^/]+\/pi-/, ""),
          description: pack.description,
          keywords: pack.keywords,
          selected: false,
          toggleable: members(pack.id).length > 0,
          globalDefaultable:
            members(pack.id).length > 0 &&
            members(pack.id).every((member) => member.globalDefaultable !== false),
          preview: async () => ({
            fields: [
              { label: "Package", value: pack.id },
              ...kinds.map((kind) => ({
                label: kind[0].toUpperCase() + kind.slice(1),
                value:
                  members(pack.id)
                    .filter((candidate) => candidate.kind === kind)
                    .map((candidate) => candidate.name)
                    .join(", ") || "none",
              })),
            ],
          }),
        }));
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Use session_setup to select package guidance in a headless session.",
          "info",
        );
        return;
      }
      await showResourceBrowser(ctx, {
        title: "Packages",
        ...resourceBrowserNavigation(pi, "packages"),
        entries,
        selectionScope: "session",
        defaultsScope: "project",
        notice: diagnostics().join("\n") || undefined,
        ...resourcePickerControls({
          ctx,
          setup,
          entries,
          members: (entry) => members(entry.id) as PickerMember[],
          bulkMembers: candidates.filter((candidate) => !candidate.packName) as PickerMember[],
        }),
      });
    },
  });
}
