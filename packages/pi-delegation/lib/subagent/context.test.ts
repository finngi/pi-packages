import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContext, resolveContext, taskFileText, transcript } from "./context.ts";

test("context values parse from YAML numbers and tool strings", () => {
  assert.deepEqual(
    [
      parseContext("none"),
      parseContext("all"),
      parseContext(3),
      parseContext("12"),
      parseContext(undefined),
      parseContext(null),
    ],
    ["none", "all", 3, 12, undefined, undefined],
  );
  for (const bad of ["soon", "0", 0, -1, 1.5, "", true, [1]])
    assert.throws(() => parseContext(bad), /conversation must be/);
});

test("without an agent setting a call defaults to none and may ask for anything", () => {
  assert.equal(resolveContext(undefined, undefined), "none");
  assert.equal(resolveContext("all", undefined), "all");
  assert.equal(resolveContext("4", undefined), 4);
});

test("an agent with context none never takes the conversation", () => {
  assert.equal(resolveContext(undefined, "none"), "none");
  assert.equal(resolveContext("none", "none"), "none");
  assert.throws(() => resolveContext("all", "none"), /does not take the parent conversation/);
  assert.throws(() => resolveContext("2", "none"), /does not take the parent conversation/);
});

test("an agent with a number takes that many turns by default and at most that many", () => {
  assert.equal(resolveContext(undefined, 3), 3);
  assert.equal(resolveContext("2", 3), 2);
  assert.equal(resolveContext("3", 3), 3);
  assert.equal(resolveContext("none", 3), "none");
  assert.throws(() => resolveContext("4", 3), /at most the last 3 turns/);
  assert.throws(() => resolveContext("all", 3), /at most the last 3 turns/);
});

test("an agent with context all shares everything by default and may be asked for less", () => {
  assert.equal(resolveContext(undefined, "all"), "all");
  assert.equal(resolveContext("2", "all"), 2);
  assert.equal(resolveContext("none", "all"), "none");
});

const conversation = [
  { role: "system", content: "you are pi" },
  { role: "user", content: "first question" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret plan" },
      { type: "text", text: "first answer" },
    ],
  },
  {
    role: "user",
    content: [
      { type: "text", text: "second question" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I will look" },
      { type: "toolCall", id: "1", name: "bash", arguments: { command: "cat secrets" } },
    ],
  },
  { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "TOOL OUTPUT" }] },
  { role: "bashExecution", command: "ls", output: "SHELL OUTPUT" },
  { role: "custom", content: "extension note" },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "2", name: "subagent", arguments: { agent: "x" } }],
  },
];

test("none shares nothing", () => {
  assert.equal(transcript(conversation, "none"), "");
});

test("all keeps what the user and the assistant said, and nothing else", () => {
  const text = transcript(conversation, "all");
  assert.equal(
    text,
    "[User]: first question\n\n[Assistant]: first answer\n\n[User]: second question\n\n[Assistant]: I will look",
  );
  for (const leaked of [
    "secret plan",
    "cat secrets",
    "TOOL OUTPUT",
    "SHELL OUTPUT",
    "extension note",
    "you are pi",
    "AAAA",
    "subagent",
  ]) {
    assert.ok(!text.includes(leaked), leaked);
  }
});

test("a number keeps the last N user turns, counting the one that led to the call", () => {
  assert.equal(transcript(conversation, 1), "[User]: second question\n\n[Assistant]: I will look");
  assert.equal(transcript(conversation, 2), transcript(conversation, "all"));
  assert.equal(transcript(conversation, 9), transcript(conversation, "all"));
});

test("assistant text before any user message is kept with the first turn", () => {
  assert.equal(
    transcript(
      [
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
        { role: "user", content: "hi" },
      ],
      "all",
    ),
    "[Assistant]: hello\n\n[User]: hi",
  );
});

test("an empty or non-message history shares nothing", () => {
  assert.equal(transcript([], "all"), "");
  assert.equal(transcript([null, 3, { role: "user", content: [] }], "all"), "");
});

test("the task file is the task alone, or the conversation then the task", () => {
  assert.equal(taskFileText("do it", ""), "do it");
  assert.equal(
    taskFileText("do it", "[User]: hi"),
    "<parent_conversation>\n[User]: hi\n</parent_conversation>\n\n<task>\ndo it\n</task>",
  );
});

test("an image-only user message is a turn, so it counts towards the last N", () => {
  const messages = [
    { role: "user", content: "old question" },
    { role: "assistant", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "text", text: "that is a cat" }] },
  ];
  assert.equal(transcript(messages, 1), "[Assistant]: that is a cat");
  assert.equal(
    transcript(messages, 2),
    "[User]: old question\n\n[Assistant]: old answer\n\n[Assistant]: that is a cat",
  );
});
