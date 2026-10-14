import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

console.log(
  JSON.stringify({ readme: getReadmePath(), docs: getDocsPath(), examples: getExamplesPath() }),
);
