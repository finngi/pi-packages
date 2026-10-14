import { stripFrontmatter as stripStockFrontmatter } from "@earendil-works/pi-coding-agent";

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Closed metadata remains metadata even if its YAML is malformed; an unclosed header is preserved. */
export function stripFrontmatter(content: string): string {
  const header = FRONTMATTER.exec(content)?.[0];
  if (!header) return content;
  const body = content.slice(header.length);
  try {
    const stripped = stripStockFrontmatter(content);
    // Stock accepts delimiter prefixes such as ---bad; only our exact body boundary is metadata.
    return stripped === body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim() ? stripped : body;
  } catch {
    return body;
  }
}
