import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  showResourceBrowser,
  resourceBrowserNavigation,
  type ResourceEntry,
} from "pi-resource-browser";
import type { installSessionSetup } from "pi-resources/session-setup";
import { resourcePickerControls } from "./picker.ts";

export function registerPackagePicker(
  pi: ExtensionAPI,
  setup: ReturnType<typeof installSessionSetup>,
  diagnostics: () => string[],
) {
  pi.registerCommand("packages", {
    description: "Choose available packages without selecting their contents",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      const inspect = () => setup.inspect(ctx);
      const contributions = inspect();
      const entries: ResourceEntry[] = contributions
        .filter((value) => value.kind === "packages")
        .flatMap((value) => value.candidates)
        .map((pack) => ({
          id: pack.id,
          name: pack.name.replace(/^@[^/]+\/pi-/, ""),
          description: pack.description,
          keywords: pack.keywords,
          selected: false,
          globalDefaultable: pack.globalDefaultable,
          preview: async () => ({
            fields: [
              { label: "Package", value: pack.id },
              {
                label: "Resources",
                value: "Discoverable when enabled; select contents separately.",
              },
              {
                label: "Code",
                value: "Native extensions load at startup; code changes need restart.",
              },
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
          members: (entry) => [
            {
              kind: "packages",
              id: entry.id,
              nativeDefault: true,
              globalDefaultable: entry.globalDefaultable,
            },
          ],
        }),
      });
    },
  });
}
