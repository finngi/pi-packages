import { fuzzyFilter } from "@earendil-works/pi-tui";

export interface SearchableResource {
  id: string;
  name: string;
  description: string;
  keywords?: string;
}

/**
 * Typeahead over the catalogue's metadata using Pi's own fuzzy matcher. Every query token must
 * match the name, description or keywords in order; an empty query keeps the catalogue order.
 */
export class ResourceSearch<T extends SearchableResource> {
  private readonly items: T[];
  private readonly text = new Map<T, string>();

  constructor(items: T[]) {
    this.items = items;
    for (const item of items)
      this.text.set(item, `${item.name} ${item.description} ${item.keywords ?? ""}`);
  }

  search(query: string): T[] {
    return fuzzyFilter(this.items, query, (item) => this.text.get(item) ?? "");
  }
}
