export const protectedWriteNames = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude",
  ".agents",
  ".npmrc",
  ".husky",
  ".github/workflows",
  ".gitattributes",
  ".pi",
  ".envrc",
  ".vscode",
  ".idea",
  ".mcp.json",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".gitconfig",
  ".gitmodules",
];
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One protected-name vocabulary is used by admission and kernel-profile compilation. */
export const protectedWritePattern = new RegExp(
  `(?:^|/)(?:${protectedWriteNames.map(escapeRegex).join("|")})(?:/|$)`,
  "i",
);
