export interface SearchableResource {
  id: string;
  name: string;
  description: string;
  keywords?: string;
}
const terms = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** BM25 over the catalogue's metadata. Names carry more weight; bodies are never indexed. */
export class ResourceSearch<T extends SearchableResource> {
  private documents: Array<{ item: T; length: number; frequencies: Map<string, number> }>;
  private frequency = new Map<string, number>();
  private averageLength: number;

  constructor(items: T[]) {
    this.documents = items.map((item) => {
      const tokens = terms(
        `${item.name} ${item.name} ${item.name} ${item.description} ${item.keywords ?? ""}`,
      );
      const frequencies = new Map<string, number>();
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      for (const token of frequencies.keys())
        this.frequency.set(token, (this.frequency.get(token) ?? 0) + 1);
      return { item, length: tokens.length, frequencies };
    });
    this.averageLength =
      this.documents.reduce((sum, document) => sum + document.length, 0) /
      Math.max(1, items.length);
  }

  search(query: string): T[] {
    const queryTerms = [...new Set(terms(query))];
    if (!queryTerms.length) return this.documents.map((document) => document.item);
    // Prefix expansion makes incomplete words useful while the user is typing.
    const vocabulary = [...this.frequency.keys()];
    const groups = queryTerms.map((term) => vocabulary.filter((word) => word.startsWith(term)));
    const scored = this.documents.map((document, index) => {
      let score = 0;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        let best = 0;
        for (const word of groups[groupIndex]) {
          const tf = document.frequencies.get(word) ?? 0;
          if (!tf) continue;
          const df = this.frequency.get(word)!;
          const idf = Math.log(1 + (this.documents.length - df + 0.5) / (df + 0.5));
          const denominator =
            tf + 1.2 * (1 - 0.75 + (0.75 * document.length) / Math.max(1, this.averageLength));
          const weight = word === queryTerms[groupIndex] ? 1 : 0.8;
          best = Math.max(best, (weight * idf * tf * 2.2) / denominator);
        }
        score += best;
      }
      return { item: document.item, score, index };
    });
    return scored
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((result) => result.item);
  }
}
