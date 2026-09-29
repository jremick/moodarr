import type { LocalSemanticIdentity, LocalSemanticHit } from "../localSemanticIndex";
/** Existing exact and packed indexes implement this read-only contract. */
export interface LocalSemanticSearchIndex {
  readonly identity: LocalSemanticIdentity;
  readonly size: number;
  readonly generation: number;
  documentIds(): Iterable<string>;
  documentInputHash(itemId: string): string | undefined;
  search(query: number[] | undefined, positiveReferenceIds: string[], limit?: number, signal?: AbortSignal,
    options?: { eligibleIds?: ReadonlySet<string>; excludedIds?: ReadonlySet<string> }): Promise<{
      queryHits: LocalSemanticHit[]; exampleHits: LocalSemanticHit[]; identity: LocalSemanticIdentity
    }>;
}
