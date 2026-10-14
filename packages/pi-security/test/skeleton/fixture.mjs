export function policy() {
  return {
    version: 2,
    mode: "auto",
    resources: { write: ["${project}", "${tmp}"], denyRead: [], denyWrite: [], network: [] },
    classifier: { model: "none", timeoutSec: 5 },
    approvalTimeoutSec: 30,
    env: {
      path: (process.env.PATH ?? "")
        .split(process.platform === "win32" ? ";" : ":")
        .filter((entry) => entry.startsWith("/")),
      assignAllow: [],
    },
    deny: [
      {
        id: "deny-cat-secret",
        tool: "bash",
        match: { program: "cat", "args-contain": "secret.txt" },
      },
    ],
    allow: [
      {
        id: "cat",
        tool: "bash",
        match: { program: "cat" },
        permissions: { write: false, network: [] },
      },
      {
        id: "touch",
        tool: "bash",
        match: { program: "touch" },
        permissions: { write: true, network: [] },
      },
      {
        id: "node",
        tool: "bash",
        match: { program: "node" },
        permissions: { write: true, network: [] },
      },
    ],
  };
}
