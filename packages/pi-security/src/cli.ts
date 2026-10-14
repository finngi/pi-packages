#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { loadPolicy } from "./policy.ts";
import { decide } from "./gate.ts";
import { compileProfile } from "./profiles.ts";
const [action, command, ...extra] = process.argv.slice(2);
if (action !== "explain" || typeof command !== "string" || extra.length) {
  console.error('Usage: pi-security explain "<command>"');
  process.exitCode = 2;
} else {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-security-explain-"));
  try {
    const policyPath =
      process.env.PI_SECURITY_POLICY ||
      path.join(
        process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent"),
        "policy.json",
      );
    const loaded = await loadPolicy(policyPath, { project: process.cwd(), tmp });
    const decision = decide("bash", { command }, loaded);
    const fetchDiagnostic =
      (decision.permissions?.network.length ?? 0) > 0
        ? {
            proxyPort: "allocated-at-execution",
            diagnosticProfilePort: 65535,
            note: "Diagnostic placeholder only; no proxy is started and this profile is not an execution capability.",
          }
        : {};
    console.log(
      JSON.stringify({
        verdict: decision.verdict,
        ruleIds: decision.ruleIds ?? [],
        permissions: decision.permissions ?? null,
        reason: decision.reason,
        ...fetchDiagnostic,
      }),
    );
    if (decision.permissions)
      console.log(
        compileProfile(loaded, decision.permissions, {
          policyPath,
          extensionPath: new URL(
            import.meta.url.endsWith(".js") ? "./extension.js" : "./extension.ts",
            import.meta.url,
          ).pathname,
          ...((decision.permissions?.network.length ?? 0) > 0
            ? { fetchLease: { port: 65535 } }
            : {}),
        }),
      );
  } catch (error) {
    console.error("pi-security: " + (error as Error).message);
    process.exitCode = 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
