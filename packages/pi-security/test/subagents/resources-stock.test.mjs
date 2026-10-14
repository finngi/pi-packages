import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { createChildLauncher } from "../../src/child-launch.ts";
import { assertNarrows } from "../../src/child-policy.ts";
import { loadPolicy } from "../../src/policy.ts";
import { createTempScope } from "../../src/temp-scope.ts";
import { wrapShell } from "../../src/wrap-shell.ts";
import { policy } from "../skeleton/fixture.mjs";

const source = fileURLToPath(new URL("../..", import.meta.url));
test("real stock child sees trusted instructions, selected native skill and exact tool/model/thinking settings", async () => {
  const fixture = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-child-resources-"));
  let scope, launcher, child;
  try {
    const home = path.join(fixture, "home");
    await mkdir(home);
    scope = await createTempScope({ base: path.join(fixture, "base") });
    const siblingTemp = path.join(scope.base, "unrelated-session");
    await mkdir(siblingTemp);
    await writeFile(path.join(siblingTemp, "secret.txt"), "SIBLING_SECRET_SENTINEL");
    const policyPath = path.join(fixture, "policy.json");
    const fixturePolicy = policy();
    fixturePolicy.allow.push(
      { id: "allowed-write", tool: "write" },
      { id: "allowed-read", tool: "read", permissions: { write: false, network: [] } },
    );
    await writeFile(policyPath, JSON.stringify(fixturePolicy));
    const parent = await loadPolicy(policyPath, { project: scope.tmp, tmp: scope.tmp });
    parent.tempIsolation = { base: scope.base, own: scope.tmp, launchDir: scope.launchDir };
    const skillBase = path.join(fixture, "selected");
    await mkdir(skillBase);
    const skill = path.join(skillBase, "SKILL.md");
    await writeFile(
      skill,
      "---\nname: chosen\ndescription: SELECTED_CATALOGUE_SENTINEL\nnotes: HUMAN_METADATA_SENTINEL\n---\nSELECTED_SKILL_BODY_SENTINEL\nRead references.txt relative to this skill.",
    );
    await writeFile(path.join(skillBase, "references.txt"), "SUPPORT_SENTINEL");
    const bundle = path.join(fixture, "authored", "reviewer");
    await mkdir(path.join(bundle, "skills/private"), { recursive: true });
    await mkdir(path.join(bundle, "references"), { recursive: true });
    await mkdir(path.join(bundle, "scripts"), { recursive: true });
    await writeFile(path.join(bundle, "reviewer.md"), "BUNDLE_AGENT_BODY_SENTINEL");
    await writeFile(
      path.join(bundle, "skills/private/SKILL.md"),
      "---\nname: private\ndescription: PRIVATE_BUNDLE_SKILL_SENTINEL\n---\nPrivate skill body.\nRead ../../references/helper.txt and run ../../scripts/helper.mjs.\n",
    );
    await writeFile(path.join(bundle, "references/helper.txt"), "PRIVATE_HELPER_SENTINEL");
    await writeFile(
      path.join(bundle, "scripts/helper.mjs"),
      "import {writeFileSync} from 'node:fs'; writeFileSync('script-proof.txt','PRIVATE_SCRIPT_OUTPUT'); console.log('PRIVATE_SCRIPT_EXECUTED');",
    );
    const model = {
      id: "scripted",
      name: "Scripted",
      api: "resource-fixture",
      provider: "resource-local",
      baseUrl: "http://invalid.local",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 256,
    };
    launcher = createChildLauncher({
      parentLoaded: parent,
      tempScope: scope,
      extensionPath: path.join(source, "src/extension.ts"),
      piCliPath: path.join(
        source,
        "../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      parentResources: {
        tools: ["read", "bash"],
        skills: [{ name: "chosen", path: skill }],
        models: [model],
        model: { provider: model.provider, id: model.id },
        thinking: "off",
      },
    });
    const provider = path.join(fixture, "provider.mjs");
    await writeFile(
      provider,
      `import {writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createAssistantMessageEventStream,getSystemMessageText} from ${JSON.stringify(pathToFileURL(path.join(source, "../../node_modules/@earendil-works/pi-ai/dist/compat.js")).href)};
export default function(pi){let turns=0;pi.registerProvider(${JSON.stringify(model.provider)},{api:${JSON.stringify(model.api)},apiKey:'fixture-only',baseUrl:'http://invalid.local',models:[${JSON.stringify(model)}],streamSimple:(model,context)=>{
const observed={system:JSON.stringify(context.messages.filter(x=>x.role==='system')),messages:context.messages,tools:context.messages.filter(x=>x.role==='system').flatMap(x=>x.toolsAdded??[]),model:{provider:model.provider,id:model.id},thinking:pi.getThinkingLevel()};
writeFileSync(process.env.FIXTURE_CAPTURE,JSON.stringify(observed));
const first=turns===0,calls=[];
if(first) writeFileSync(process.env.FIXTURE_FIRST_CAPTURE,JSON.stringify(observed));
if(process.env.FIXTURE_LAZY){
 const system=context.messages.filter(x=>x.role==='system').map(getSystemMessageText).join('\\n'),skill=system.match(/<location>([^<]+)<\\/location>/)?.[1];
 const steps=[{name:'read',arguments:{path:skill}},{name:'read',arguments:{path:resolve(dirname(skill),'../../references/helper.txt')}},{name:'bash',arguments:{command:'node '+JSON.stringify(resolve(dirname(skill),'../../scripts/helper.mjs'))}}];
 if(steps[turns]) calls.push({type:'toolCall',id:'lazy-'+turns,...steps[turns]});
}else if(first&&process.env.FIXTURE_HELPER) calls.push({type:'toolCall',id:'read-helper',name:'read',arguments:{path:process.env.FIXTURE_HELPER}});
if(first) calls.push({type:'toolCall',id:'omitted-write',name:'write',arguments:{path:'omitted.txt',content:'must not write'}});
turns++;
const stream=createAssistantMessageEventStream(),message={role:'assistant',content:calls.length?calls:[{type:'text',text:'done'}],api:model.api,provider:model.provider,model:model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:calls.length?'toolUse':'stop',timestamp:Date.now()};
queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});stream.end();});return stream;}});}`,
    );
    for (const mode of ["public", "empty", "bundle", "bundle-empty", "bundle-lazy"]) {
      const empty = mode === "empty",
        lazy = mode === "bundle-lazy",
        bundleMode = mode.startsWith("bundle"),
        bundleWithPrivateSkill = mode === "bundle" || lazy;
      const launch = await launcher.prepareChildLaunch({
        task: "UNTRUSTED_TASK_SENTINEL",
        instructions: "TRUSTED_INSTRUCTIONS_SENTINEL",
        tools: empty ? [] : lazy ? ["read", "bash"] : ["read"],
        ...(empty
          ? { skills: [] }
          : lazy
            ? { skills: ["private"] }
            : bundleMode
              ? {}
              : { skills: ["chosen"] }),
        ...(bundleMode
          ? {
              agentBundle: {
                root: await realpath(bundle),
                privateSkills: bundleWithPrivateSkill
                  ? [
                      {
                        name: "private",
                        path: path.join(await realpath(bundle), "skills/private/SKILL.md"),
                      },
                    ]
                  : [],
              },
              staticContext: {
                originalCwd: scope.tmp,
                instructions:
                  '<instruction path="/fixture/selected/careful.md">SELECTED_BEHAVIOR_SENTINEL</instruction>',
                files:
                  mode === "bundle-empty"
                    ? []
                    : [
                        {
                          path: "/fixture/global/AGENTS.md",
                          content: "---\nlabel: meta\n---\nGLOBAL_CONTEXT_SENTINEL",
                        },
                        {
                          path: path.join(scope.tmp, "AGENTS.md"),
                          content: "PROJECT_CONTEXT_SENTINEL",
                        },
                        {
                          path: path.join(scope.tmp, "AGENTS.local.md"),
                          content: "LOCAL_CONTEXT_SENTINEL",
                        },
                      ],
              },
            }
          : {}),
        model: { provider: model.provider, id: model.id },
        thinking: "high",
      });
      await writeFile(path.join(launch.cwd, "AGENTS.md"), "UNSTAGED_CWD_CONTEXT_SENTINEL");
      await writeFile(
        path.join(launch.env.PI_CODING_AGENT_DIR, "AGENTS.md"),
        "UNSTAGED_AGENT_CONTEXT_SENTINEL",
      );
      await writeFile(
        path.join(path.dirname(launch.cwd), "AGENTS.md"),
        "UNSTAGED_ANCESTOR_CONTEXT_SENTINEL",
      );
      assert.deepEqual(
        launch.childLoaded.resources.tools,
        empty ? [] : lazy ? ["read", "bash"] : ["read"],
      );
      const isolatedTest = path.join(launch.tmp, "sandbox.test.mjs");
      const realpathTargets = [
        launch.tmp,
        ...launch.childLoaded.launchResources.skills.map((skill) => skill.path),
        ...(launch.childLoaded.launchResources.bundle
          ? [
              launch.childLoaded.launchResources.bundle.path,
              path.join(launch.childLoaded.launchResources.bundle.path, "references/helper.txt"),
            ]
          : []),
      ];
      await writeFile(
        isolatedTest,
        `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {realpathSync} from 'node:fs'; for (const target of ${JSON.stringify(realpathTargets)}) assert.equal(realpathSync(target), target); test('sandboxed node test runner',()=>assert.equal(1,1));\n`,
      );
      const sandboxed = wrapShell(
        { argv: [process.execPath, "--test", path.basename(isolatedTest)] },
        { write: true, network: [] },
        launch.childLoaded,
        { policyPath, extensionPath: path.join(source, "src/extension.ts") },
      );
      const sandboxProfile = path.join(fixture, `${launch.id}-node-test.sb`);
      await writeFile(sandboxProfile, sandboxed.profile);
      const runSandboxed = (argv) =>
        spawnSync("/usr/bin/sandbox-exec", ["-f", sandboxProfile, ...argv], {
          cwd: launch.tmp,
          env: sandboxed.env,
          encoding: "utf8",
        });
      const nodeBinaries = [process.execPath].filter(
        (binary, index, all) => existsSync(binary) && all.indexOf(binary) === index,
      );
      for (const binary of nodeBinaries) {
        const nodeTest = runSandboxed([binary, "--test", path.basename(isolatedTest)]);
        assert.equal(nodeTest.status, 0, `${binary}: ${nodeTest.stderr || nodeTest.stdout}`);
      }
      const workspaceListing = runSandboxed(["/bin/ls", "-la", launch.tmp]);
      assert.equal(workspaceListing.status, 0, workspaceListing.stderr || workspaceListing.stdout);
      const siblingRead = runSandboxed(["/bin/cat", path.join(siblingTemp, "secret.txt")]);
      assert.notEqual(siblingRead.status, 0);
      assert.match(siblingRead.stderr, /Operation not permitted|Permission denied/);
      const siblingMetadata = runSandboxed(["/usr/bin/stat", path.join(siblingTemp, "secret.txt")]);
      assert.notEqual(siblingMetadata.status, 0);
      assert.match(siblingMetadata.stderr, /Operation not permitted|Permission denied/);
      const siblingListing = runSandboxed(["/bin/ls", "-1A", scope.base]);
      assert.notEqual(siblingListing.status, 0);
      assert.doesNotMatch(siblingListing.stdout, /unrelated-session/);
      assert.match(siblingListing.stderr, /Operation not permitted|Permission denied/);
      const siblingWritePath = path.join(siblingTemp, "must-not-write.txt");
      const siblingWrite = runSandboxed(["/usr/bin/touch", siblingWritePath]);
      assert.notEqual(siblingWrite.status, 0);
      await assert.rejects(lstat(siblingWritePath));
      if (bundleMode) {
        const bundleRoot = launch.childLoaded.launchResources.bundle.path;
        for (const readableDirectory of [bundleRoot, path.join(bundleRoot, "skills/private")]) {
          const listing = runSandboxed(["/bin/ls", "-la", readableDirectory]);
          assert.equal(listing.status, 0, listing.stderr || listing.stdout);
        }
        const stagedParentListing = runSandboxed(["/bin/ls", "-la", path.dirname(bundleRoot)]);
        assert.notEqual(stagedParentListing.status, 0);
        assert.doesNotMatch(stagedParentListing.stdout, /agent/);
        assert.match(stagedParentListing.stderr, /Operation not permitted|Permission denied/);
      }
      if (!empty && !lazy) {
        const selectedPath = launch.argv[launch.argv.indexOf("--skill") + 1];
        const wrapped = wrapShell(
          "cat " + JSON.stringify(selectedPath) + "; printf bad > " + JSON.stringify(selectedPath),
          { write: true, network: [] },
          launch.childLoaded,
          { policyPath, extensionPath: path.join(source, "src/extension.ts") },
        );
        const profile = path.join(fixture, launch.id + ".sb");
        await writeFile(profile, wrapped.profile);
        const processRun = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, ...wrapped.argv], {
          cwd: launch.tmp,
          env: wrapped.env,
          encoding: "utf8",
        });
        assert.match(processRun.stdout, /SELECTED_SKILL_BODY_SENTINEL/);
        assert.match(processRun.stderr, /Operation not permitted|Permission denied/);
        assert.match(await readFile(selectedPath, "utf8"), /SELECTED_SKILL_BODY_SENTINEL/);
      }
      const capture = path.join(fixture, launch.id + "-capture.json");
      const firstCapture = path.join(fixture, `${launch.id}-first-capture.json`);
      const skillPaths = launch.argv.flatMap((value, index) =>
        value === "--skill" ? [launch.argv[index + 1]] : [],
      );
      const privateSkillPath = bundleWithPrivateSkill
        ? skillPaths.find((value) => value.includes("/bundles/agent/"))
        : undefined;
      const stagedBundlePath = bundleMode
        ? launch.childLoaded.launchResources.bundle?.path
        : undefined;
      const helperPath = stagedBundlePath
        ? path.join(stagedBundlePath, "references/helper.txt")
        : privateSkillPath
          ? path.resolve(path.dirname(privateSkillPath), "../../references/helper.txt")
          : undefined;
      if (bundleMode) {
        assert.deepEqual(
          launch.childLoaded.resources.skills.map((x) => x.name),
          lazy ? ["private"] : bundleWithPrivateSkill ? ["chosen", "private"] : ["chosen"],
        );
        assert.equal(await readFile(helperPath, "utf8"), "PRIVATE_HELPER_SENTINEL");
        if (privateSkillPath)
          assert.equal(
            (await readFile(privateSkillPath, "utf8")).includes("PRIVATE_BUNDLE_SKILL_SENTINEL"),
            true,
          );
        assert.equal(
          path.relative(launch.tmp, launch.childLoaded.launchResources.directory).startsWith(".."),
          true,
        );
        assert.equal(
          launch.childLoaded.tempIsolation.resourceReadAllow.some((x) =>
            x.endsWith("/bundles/agent"),
          ),
          true,
        );
        if (!bundleWithPrivateSkill) {
          const widened = structuredClone(launch.childLoaded);
          widened.tempIsolation.resourceReadAllow.push(
            path.join(widened.tempIsolation.launchDir, "unselected-resource-root"),
          );
          const parentAuthority = {
            ...launch.parentLoaded,
            resourceAuthority: {
              tools: ["read", "bash"],
              skills: [{ name: "chosen", path: skill }],
              privateSkills: [],
            },
          };
          assert.throws(
            () => assertNarrows(widened, parentAuthority),
            /selected resource read roots widened/,
          );
        }
        assert.equal((await lstat(launch.childLoaded.launchResources.directory)).mode & 0o077, 0);
        if (privateSkillPath) assert.equal((await lstat(privateSkillPath)).mode & 0o222, 0);
        await assert.rejects(lstat(path.join(launch.tmp, "bundles", "agent")));
      }
      let stderr = "",
        buffer = "";
      const frames = [];
      child = spawn(launch.argv[0], [...launch.argv.slice(1), "-e", provider, "--no-session"], {
        cwd: launch.cwd,
        env: {
          ...launch.env,
          HOME: home,
          FIXTURE_CAPTURE: capture,
          FIXTURE_FIRST_CAPTURE: firstCapture,
          ...(lazy ? { FIXTURE_LAZY: "1" } : {}),
          ...(helperPath ? { FIXTURE_HELPER: helperPath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const childProcess = child;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.stderr.on("data", (b) => (stderr += b));
      let timer;
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(Error("fixture timeout " + stderr)), 15000);
          child.once("error", reject);
          child.once("close", (code) => reject(Error("fixture exit " + code + " " + stderr)));
          child.stdout.on("data", (b) => {
            buffer += b;
            let newline;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              let frame;
              try {
                frame = JSON.parse(line);
              } catch {
                continue;
              }
              frames.push(frame);
              if (frame.type === "agent_end") resolve();
            }
          });
          child.stdin.write(
            JSON.stringify({
              type: "prompt",
              id: "capture",
              message: empty
                ? "UNTRUSTED_TASK_SENTINEL"
                : bundleMode
                  ? bundleWithPrivateSkill
                    ? lazy
                      ? "UNTRUSTED_TASK_SENTINEL"
                      : "/skill:private UNTRUSTED_TASK_SENTINEL"
                    : "UNTRUSTED_TASK_SENTINEL"
                  : "/skill:chosen UNTRUSTED_TASK_SENTINEL",
            }) + "\n",
          );
        });
      } finally {
        clearTimeout(timer);
        childProcess.kill();
        await closed;
        child = undefined;
      }
      let observed;
      try {
        observed = JSON.parse(await readFile(capture, "utf8"));
      } catch (error) {
        throw Error("missing capture; stderr=" + stderr + " stdout=" + JSON.stringify(frames), {
          cause: error,
        });
      }
      assert.match(observed.system, /TRUSTED_INSTRUCTIONS_SENTINEL/);
      assert.doesNotMatch(
        observed.system,
        /UNSTAGED_CWD_CONTEXT_SENTINEL|UNSTAGED_AGENT_CONTEXT_SENTINEL|UNSTAGED_ANCESTOR_CONTEXT_SENTINEL/,
      );
      assert.doesNotMatch(observed.system, /UNTRUSTED_TASK_SENTINEL|HUMAN_METADATA_SENTINEL/);
      assert.deepEqual(observed.model, { provider: model.provider, id: model.id });
      assert.equal(observed.thinking, "high");
      const rejected = frames.find(
        (x) => x.type === "tool_execution_end" && x.toolName === "write",
      );
      assert.equal(rejected?.isError, true, JSON.stringify(frames));
      assert.match(
        JSON.stringify(rejected),
        /outside child selected resources|not found|not available/,
      );
      if (empty || lazy) assert.doesNotMatch(observed.system, /SELECTED_CATALOGUE_SENTINEL/);
      else {
        assert.match(observed.system, /SELECTED_CATALOGUE_SENTINEL/);
        if (!bundleMode)
          assert.match(JSON.stringify(observed.messages), /SELECTED_SKILL_BODY_SENTINEL/);
        assert.doesNotMatch(JSON.stringify(observed.messages), /HUMAN_METADATA_SENTINEL/);
        const skillPath = launch.argv[launch.argv.indexOf("--skill") + 1];
        assert.equal(
          await readFile(path.join(path.dirname(skillPath), "references.txt"), "utf8"),
          "SUPPORT_SENTINEL",
        );
      }
      if (lazy) {
        const initial = JSON.parse(await readFile(firstCapture, "utf8"));
        assert.match(initial.system, /PRIVATE_BUNDLE_SKILL_SENTINEL/);
        assert.match(initial.system, /Use the read tool to load a skill/);
        assert.doesNotMatch(
          JSON.stringify(initial.messages),
          /Private skill body|PRIVATE_HELPER_SENTINEL/,
        );
        assert.match(
          JSON.stringify(observed.messages),
          /Private skill body|PRIVATE_SCRIPT_EXECUTED/,
        );
        const execution = frames.find(
          (frame) => frame.type === "tool_execution_end" && frame.toolName === "bash",
        );
        assert.equal(execution?.isError, false, JSON.stringify(execution));
        assert.match(JSON.stringify(execution), /PRIVATE_SCRIPT_EXECUTED/);
        assert.equal(
          await readFile(path.join(launch.cwd, "script-proof.txt"), "utf8"),
          "PRIVATE_SCRIPT_OUTPUT",
        );
      }
      if (bundleMode) {
        const system = observed.messages
          .filter((message) => message.role === "system")
          .map(getSystemMessageText)
          .join("\n");
        const behavior =
          '<instruction path="/fixture/selected/careful.md">SELECTED_BEHAVIOR_SENTINEL</instruction>';
        assert.ok(system.includes(`<instructions>\n${behavior}\n</instructions>`), system);
        assert.equal(system.match(/<instructions>/g)?.length, 1);
        const projectContext = system.match(
          /<inherited_static_context[^>]*>([\s\S]*?)<\/inherited_static_context>/,
        )?.[1];
        assert.ok(!projectContext?.includes("SELECTED_BEHAVIOR_SENTINEL"));
        if (mode === "bundle-empty") assert.equal(projectContext, undefined);
        if (!bundleWithPrivateSkill) {
          const bundleRead = frames.find(
            (frame) => frame.type === "tool_execution_end" && frame.toolName === "read",
          );
          assert.ok(bundleRead, JSON.stringify(frames));
          assert.equal(bundleRead.isError, false, JSON.stringify(bundleRead));
        }
        if (bundleWithPrivateSkill) {
          assert.match(observed.system, /PRIVATE_BUNDLE_SKILL_SENTINEL/);
          assert.match(
            JSON.stringify(observed.messages),
            /PRIVATE_SKILL_BODY_SENTINEL|Private skill body/,
          );
        } else {
          assert.doesNotMatch(observed.system, /PRIVATE_BUNDLE_SKILL_SENTINEL/);
          assert.doesNotMatch(JSON.stringify(observed.messages), /PRIVATE_SKILL_BODY_SENTINEL/);
        }
        assert.match(JSON.stringify(observed.messages), /PRIVATE_HELPER_SENTINEL/);
        if (mode !== "bundle-empty") {
          assert.match(observed.system, /original_project/);
          assert.match(observed.system, /GLOBAL_CONTEXT_SENTINEL/);
          assert.match(observed.system, /PROJECT_CONTEXT_SENTINEL/);
          assert.match(observed.system, /LOCAL_CONTEXT_SENTINEL/);
        } else
          assert.doesNotMatch(
            observed.system,
            /original_project|GLOBAL_CONTEXT_SENTINEL|PROJECT_CONTEXT_SENTINEL|LOCAL_CONTEXT_SENTINEL/,
          );
        assert.doesNotMatch(observed.system, /label: meta/);
        assert.doesNotMatch(observed.system, /active_agents|goal|counters/);
        assert.equal(
          path.relative(launch.tmp, launch.childLoaded.launchResources.directory).startsWith(".."),
          true,
        );
      }
      await launch.cleanup();
    }
  } finally {
    child?.kill();
    await launcher?.close();
    await scope?.close();
    await rm(fixture, { recursive: true, force: true });
  }
});
