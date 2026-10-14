import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_OUTPUT_SCHEMA, classify, parseClassifierOutput } from "../../src/classifier.ts";
import { classifierCases, normalizeVerdict } from "./classifier-cases.mjs";

// This runner invokes only model classification. Fixture tool arguments are data.
function argumentsFrom(argv) {
  const options = { concurrency: 3, timeoutSec: 30, cases: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw Error(`Missing value for ${flag}`);
    if (flag === "--model") options.model = value;
    else if (flag === "--output") options.output = value;
    else if (flag === "--concurrency") options.concurrency = Number(value);
    else if (flag === "--timeout-sec") options.timeoutSec = Number(value);
    else if (flag === "--case") options.cases.push(value);
    else throw Error(`Unknown argument ${flag}`);
  }
  if (!options.model || options.model.indexOf("/") < 1)
    throw Error("--model provider/id is required");
  if (!options.output || !isAbsolute(options.output) || !options.output.endsWith(".json"))
    throw Error("--output must be an absolute path to a temporary JSON report");
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 3)
    throw Error("--concurrency must be an integer from 1 through 3");
  if (!Number.isFinite(options.timeoutSec) || options.timeoutSec <= 0 || options.timeoutSec > 120)
    throw Error("--timeout-sec must be greater than 0 and at most 120");
  const known = new Set(classifierCases.map((entry) => entry.id));
  if (options.cases.some((id) => !known.has(id))) throw Error("Unknown --case identifier");
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node evaluate-classifier.mjs --model provider/id --output /private/tmp/report.json [--concurrency 1..3] [--timeout-sec 30] [--case id]",
    );
    return;
  }
  const selection = classifierCases.filter(
    (entry) => !options.cases.length || options.cases.includes(entry.id),
  );
  const split = options.model.indexOf("/");
  const provider = options.model.slice(0, split),
    id = options.model.slice(split + 1);
  const runtimeDir = await mkdtemp(join(tmpdir(), "pi-classifier-eval-"));
  const agentDir = getAgentDir();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const modelsStorePath = join(runtimeDir, "models-store.json");
    // SDK authentication may lock/refresh its file; keep those writes temporary.
    const authPath = join(runtimeDir, "auth.json");
    await copyFile(join(agentDir, "auth.json"), authPath);
    await chmod(authPath, 0o600);
    try {
      await copyFile(join(agentDir, "models-store.json"), modelsStorePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw Error("Could not prepare temporary model catalog cache");
    }
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath,
      allowModelNetwork: false,
    });
    const model = runtime.getModel(provider, id);
    if (!model)
      throw Error(
        "The explicitly requested chat model is not available in the current Pi model catalog",
      );
    if (!["openai-responses", "openai-codex-responses"].includes(model.api))
      throw Error(
        "The explicitly requested model does not use a supported constrained Responses transport",
      );
    if (!runtime.hasConfiguredAuth(provider))
      throw Error("The explicitly requested provider has no configured authentication");
    const results = new Array(selection.length);
    let next = 0;
    async function evaluate(entry, index) {
      const callStarted = performance.now();
      let wire, raw, usage, providerResponse;
      const client = {
        complete: async (target, context, requestOptions) => {
          const response = await runtime.complete(target, context, {
            ...requestOptions,
            onPayload: async (payload, ...args) => {
              const body = await requestOptions.onPayload(payload, ...args);
              wire = {
                reasoningEffort: body.reasoning?.effort ?? null,
                formatType: body.text?.format?.type ?? null,
                strict: body.text?.format?.strict === true,
                schemaMatches:
                  JSON.stringify(body.text?.format?.schema) ===
                  JSON.stringify(CLASSIFIER_OUTPUT_SCHEMA),
                toolChoice: body.tool_choice ?? null,
              };
              return body;
            },
          });
          raw = response.content
            ?.filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          providerResponse = {
            stopReason: response.stopReason,
            rawStopReason: response.rawStopReason ?? null,
            textBlocks: response.content?.filter((block) => block.type === "text").length ?? 0,
            toolCalls: response.content?.filter((block) => block.type === "toolCall").length ?? 0,
          };
          return response;
        },
      };
      const classification = await classify(
        entry.view,
        { model, client, timeoutSec: options.timeoutSec },
        (value) => {
          usage = value;
        },
      );
      const structured = typeof raw === "string" ? parseClassifierOutput(raw) : undefined;
      const structuredSuccess = Boolean(
        structured &&
          structured.reason.trim() &&
          classification.reasonCode === "classifier-chat" &&
          providerResponse?.textBlocks === 1 &&
          providerResponse?.toolCalls === 0,
      );
      const actual = normalizeVerdict(classification.verdict);
      const verdictMatches = entry.expected.includes(actual);
      const constrained = Boolean(
        wire?.formatType === "json_schema" &&
          wire.strict &&
          wire.schemaMatches &&
          wire.toolChoice === "none",
      );
      const reasonNone = wire?.reasoningEffort === "none";
      const passed = structuredSuccess && verdictMatches && constrained && reasonNone;
      results[index] = {
        id: entry.id,
        expected: entry.expected,
        actual,
        passed,
        verdictMatches,
        structuredSuccess,
        constrained,
        reasoningNone: reasonNone,
        elapsedMs: Math.round(performance.now() - callStarted),
        classification,
        structured: structured ?? null,
        providerResponse: providerResponse ?? null,
        wire: wire ?? null,
        usage: usage ?? null,
        input: entry.view,
      };
      console.log(
        `${passed ? "PASS" : "FAIL"} ${entry.id}: ${actual} (${results[index].elapsedMs} ms)`,
      );
    }
    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, selection.length) }, async () => {
        while (next < selection.length) {
          const index = next++;
          await evaluate(selection[index], index);
        }
      }),
    );
    const passed = results.filter((entry) => entry.passed).length;
    const report = {
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      model: options.model,
      api: model.api,
      concurrency: options.concurrency,
      timeoutSec: options.timeoutSec,
      summary: {
        total: results.length,
        passed,
        failed: results.length - passed,
        verdictMatches: results.filter((entry) => entry.verdictMatches).length,
        structuredSuccess: results.filter((entry) => entry.structuredSuccess).length,
        constrained: results.filter((entry) => entry.constrained).length,
        reasoningNone: results.filter((entry) => entry.reasoningNone).length,
        failedCases: results.filter((entry) => !entry.passed).map((entry) => entry.id),
      },
      results,
    };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(`${passed}/${results.length} cases passed; report: ${options.output}`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
}

main().catch(() => {
  // Avoid printing provider errors that may contain authentication or request details.
  console.error(
    "Classifier evaluation could not complete. No tool calls were executed; check model availability, transport support, and authentication.",
  );
  process.exitCode = 1;
});
