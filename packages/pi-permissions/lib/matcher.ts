import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import type { Match, Rule } from "./types.ts";

interface Stage {
  program: string;
  argv: string[];
  wrappers: string[];
}
interface ParsedBash {
  opaque: boolean;
  stages: Stage[];
  writes: boolean;
  reason: string;
}

const require = createRequire(import.meta.url);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));
const wrappers = new Set([
  "env",
  "nice",
  "timeout",
  "time",
  "nohup",
  "stdbuf",
  "command",
  "builtin",
]);
const literals = (value: string | string[]) => (typeof value === "string" ? [value] : value);
export function validateMatch(value: unknown): Match {
  const match = value as Match;
  if (!match || typeof match !== "object" || Array.isArray(match))
    throw Error("match: expected object");
  for (const [key, value] of Object.entries(match)) {
    if (!["program", "subcommand", "args-contain", "wrappers"].includes(key))
      throw Error(`match: unknown key ${key}`);
    const values = literals(value);
    if (
      (key === "wrappers" && !Array.isArray(value)) ||
      !Array.isArray(values) ||
      (key !== "wrappers" && !values.length) ||
      values.some((x) => typeof x !== "string" || !x || /[\x00-\x1f\x7f]/.test(x))
    )
      throw Error(`match.${key}: invalid literal`);
  }
  return match;
}
function word(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const t = node.text;
  if (node.type === "command_name") return word(node.namedChildren[0]);
  if (node.type === "raw_string") return t.slice(1, -1);
  if (node.type === "string") {
    if (node.namedChildren.some((n) => n!.type !== "string_content")) return null;
    return t.slice(1, -1).replace(/\\([$`"\\])/g, "$1");
  }
  if (node.type === "concatenation") {
    const parts = node.namedChildren.map(word);
    return parts.some((x) => x === null) || /[{}]/.test(t) ? null : parts.join("");
  }
  if (["word", "number"].includes(node.type)) {
    if (/[^\x21-\x7e]|[{}$`*?[\]~]/.test(t)) return null;
    return t.replace(/\\(.)/g, "$1");
  }
  return null;
}
export function parseBash(
  command: unknown,
  {
    assignAllow = [],
    maxBytes = 8192,
    maxDepth = 3,
  }: { assignAllow?: string[]; maxBytes?: number; maxDepth?: number } = {},
): ParsedBash {
  const out: ParsedBash = { opaque: false, stages: [], writes: false, reason: "closed grammar" };
  const opaque = (reason: string) => {
    out.opaque = true;
    out.reason = reason;
  };
  if (typeof command !== "string" || Buffer.byteLength(command) > maxBytes) {
    opaque("oversize or invalid command");
    return out;
  }
  const processCommand = (node: SyntaxNode, depth: number) => {
    const name = node.childForFieldName("name");
    let prog = word(name);
    const args = node.childrenForFieldName("argument").map(word);
    for (const a of node.namedChildren.filter((n) => n!.type === "variable_assignment")) {
      if (
        !assignAllow.includes(a!.childForFieldName("name")?.text ?? "") ||
        word(a!.childForFieldName("value")) === null
      )
        opaque("unapproved assignment");
    }
    if (prog === null) {
      opaque("dynamic program");
      return;
    }
    if (args.includes(null)) opaque("expansion or unsupported word");
    let argv = [prog, ...args.map((x) => x ?? "")],
      seen: string[] = [];
    out.stages.push({ program: prog, argv: [...argv], wrappers: [] });
    while (wrappers.has(path.basename(prog))) {
      const w = path.basename(prog);
      seen.push(w);
      let i = 1;
      if (w === "env") {
        while (i < argv.length) {
          const a = argv[i];
          if (a === "--") {
            i++;
            break;
          }
          if (a === "-i" || a === "--ignore-environment") {
            i++;
            continue;
          }
          if (["-u", "--unset", "-P"].includes(a)) {
            opaque("unsupported env option");
            if (!argv[i + 1]) return;
            i += 2;
            continue;
          }
          if (a === "-S") {
            opaque("unsupported env option");
            if (argv[i + 1] && depth < maxDepth) visitScript(argv[i + 1], depth + 1);
            return;
          }
          if (a.includes("=")) {
            const key = a.slice(0, a.indexOf("="));
            if (!assignAllow.includes(key)) opaque("unapproved env assignment");
            i++;
            continue;
          }
          if (a.startsWith("-")) {
            opaque("unsupported env option");
            return;
          }
          break;
        }
      } else if (w === "nice") {
        if (argv[i] === "-n" || argv[i] === "--adjustment") {
          if (!/^-?\d+$/.test(argv[i + 1] || "")) {
            opaque("invalid nice adjustment");
            return;
          }
          i += 2;
        } else if (/^--adjustment=-?\d+$/.test(argv[i] || "")) i++;
      } else if (w === "timeout") {
        if (argv[i] === "--") i++;
        if (!/^\d+(\.\d+)?[smhd]?$/.test(argv[i] || "")) {
          opaque("unsupported timeout option");
          return;
        }
        i++;
      } else if (w === "stdbuf") {
        while (/^-[ioe](?:[0-9]+[KMG]?|L)$/.test(argv[i] || "")) i++;
      } else if (w === "command" || w === "builtin") {
        if (argv[i] === "--") i++;
        else if (argv[i]?.startsWith("-")) {
          opaque("unsupported command option");
          return;
        }
      } else if (w === "time") {
        if (argv[i] === "-p") i++;
      }
      if (!argv[i] || argv[i].startsWith("-")) {
        opaque("wrapper without literal program");
        return;
      }
      argv = argv.slice(i);
      prog = argv[0];
      out.stages.push({ program: prog, argv: [...argv], wrappers: [...seen] });
    }
    const base = path.basename(prog);
    if (base === "bash" || base === "sh") {
      if (argv[1] !== "-c" || argv.length !== 3 || args.includes(null)) {
        opaque("unsupported shell invocation");
        const scriptFlag = argv.findIndex(
          (arg, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(arg),
        );
        if (scriptFlag > 0 && argv[scriptFlag + 1] && depth < maxDepth && !args.includes(null))
          visitScript(argv[scriptFlag + 1], depth + 1);
        return;
      }
      if (depth >= maxDepth) {
        opaque("shell depth exceeded");
        return;
      }
      visitScript(argv[2], depth + 1);
    }
  };
  const visitScript = (text: string, depth: number) => {
    const tree = parser.parse(text);
    if (!tree) {
      opaque("parser unavailable");
      return;
    }
    try {
      if (tree.rootNode.hasError) opaque("parse error");
      const walk = (node: SyntaxNode): void => {
        if (node.isMissing || node.type === "ERROR") opaque("parse error");
        if (node.type === "command") processCommand(node, depth);
        else if (node.type === "file_redirect") {
          const destination = word(node.childForFieldName("destination"));
          const op = node.children.find((n) => !n!.isNamed && /[<>]/.test(n!.text))?.text;
          if (![">", ">>", "<", ">&", "<&"].includes(op ?? "") || destination === null)
            opaque("unsupported redirect");
          else if (op === ">&" || op === "<&") {
            if (!/^\d+$/.test(destination)) opaque("unsupported fd redirect");
          } else if (op !== "<" && destination !== "/dev/null") out.writes = true;
        } else if (
          !["program", "list", "pipeline", "redirected_statement"].includes(node.type) &&
          node.isNamed
        )
          opaque(`unsupported ${node.type}`);
        if (node.type === "command") {
          // The deny view sees commands inside every expansion, even when allow is opaque.
          const nested = (n: SyntaxNode): void => {
            for (const c of n.namedChildren) {
              if (c!.type === "command") walk(c!);
              else nested(c!);
            }
          };
          nested(node);
          return;
        }
        if (node.type === "file_redirect") {
          const nested = (n: SyntaxNode): void => {
            for (const c of n.namedChildren) {
              if (c!.type === "command") walk(c!);
              else nested(c!);
            }
          };
          nested(node);
          return;
        }
        for (const child of node.children) {
          if (!child!.isNamed) {
            if (![";", "\n", "&&", "||", "|"].includes(child!.type))
              opaque(`unsupported operator ${child!.type}`);
          } else walk(child!);
        }
      };
      walk(tree.rootNode);
    } finally {
      tree.delete();
    }
  };
  visitScript(command, 0);
  if (!out.stages.length) opaque("no commands");
  return out;
}
export function matches(rule: Rule, stage: Stage, deny: boolean) {
  const m = rule.match;
  if (!m) return true;
  if (
    m.program &&
    !literals(m.program).some(
      (p) =>
        p === (deny ? path.basename(stage.program) : stage.program) ||
        (deny && path.basename(p) === path.basename(stage.program)),
    )
  )
    return false;
  if (
    m.subcommand &&
    !(deny
      ? stage.argv.slice(1).some((arg) => literals(m.subcommand!).includes(arg))
      : literals(m.subcommand).includes(stage.argv[1]))
  )
    return false;
  if (
    m["args-contain"] &&
    !literals(m["args-contain"]).every((a) => stage.argv.slice(1).includes(a))
  )
    return false;
  if (m.wrappers && !m.wrappers.every((w) => stage.wrappers.includes(w))) return false;
  return true;
}
