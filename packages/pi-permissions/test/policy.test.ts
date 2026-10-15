import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  decide,
  plainCommand,
  readSettings,
  sessionRule,
} from "../lib/policy.ts";

const rules = {
  allow: ["read", "bash:git status", "bash:rg"],
  deny: ["bash:sudo", "bash:git push"],
};
const bash = (command: string) => decide("bash", { command }, rules).verdict;

test("settings default to ask mode with read-only tools allowed", () => {
  assert.deepEqual(readSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(readSettings({ mode: "auto", model: " fixture/m " }), {
    ...DEFAULT_SETTINGS,
    mode: "auto",
    model: "fixture/m",
  });
  assert.deepEqual(readSettings({ allow: [] }).allow, []);
});

test("invalid settings are rejected with the offending key", () => {
  assert.throws(() => readSettings({ mode: "manual" }), /permissions.mode/);
  assert.throws(() => readSettings({ extra: true }), /unknown key extra/);
  assert.throws(() => readSettings({ allow: ["bash:"] }), /permissions.allow/);
  assert.throws(() => readSettings({ timeoutSec: 0 }), /timeoutSec/);
});

test("tool rules allow or deny every call to that tool", () => {
  assert.equal(decide("read", { path: "x" }, rules).verdict, "allow");
  assert.equal(decide("write", { path: "x" }, rules).verdict, "ask");
  assert.equal(
    decide("write", { path: "x" }, { allow: ["write"], deny: ["write"] }).verdict,
    "deny",
  );
});

test("bash allow prefixes only cover a single plain command", () => {
  assert.equal(bash("git status"), "allow");
  assert.equal(bash("git status --short"), "allow");
  assert.equal(bash("rg -n foo src"), "allow");
  assert.equal(bash("git statusx"), "ask");
  assert.equal(bash("rg foo && rm -rf build"), "ask");
  assert.equal(bash("rg foo > out.txt"), "ask");
  assert.equal(bash("rg $(cat list)"), "ask");
});

test("bash deny prefixes are checked in each command of a chain", () => {
  assert.equal(bash("sudo true"), "deny");
  assert.equal(bash("git status && git push origin main"), "deny");
  assert.equal(bash("ls | sudo tee /etc/x"), "deny");
  assert.equal(bash("(sudo true)"), "deny");
  assert.equal(bash("git pushy"), "ask");
});

test("session rules name the tool, or the program for a plain command", () => {
  assert.equal(sessionRule("edit", {}), "edit");
  assert.equal(sessionRule("bash", { command: "npm test -- --watch" }), "bash:npm");
  assert.equal(sessionRule("bash", { command: "npm test; rm x" }), undefined);
  assert.equal(plainCommand("  ls -la  "), "ls -la");
});

test("prefixes match across tabs and repeated spaces", () => {
  const tabs = { allow: ["bash"], deny: ["bash:rm", "bash:git push"] };
  assert.equal(decide("bash", { command: "rm\t-rf build" }, tabs).verdict, "deny");
  assert.equal(decide("bash", { command: "git \t push origin" }, tabs).verdict, "deny");
  assert.equal(decide("bash", { command: "ls; \trm x" }, tabs).verdict, "deny");
  assert.equal(bash("git\tstatus"), "allow");
});
