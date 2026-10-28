/** A one-tap category suggestion from /scan (always a leaf inside Supermarket). */
export interface CategoryHint {
  id: string;
  name: string;
  path: string[];
}

/**
 * Category state for an off-catalog scan. Without a confident pick nothing is
 * chosen (the old fallback was the non-leaf root "Supermarket" #258832, which
 * Allegro rejects — 10 failed offers in the logs); the suggestions are kept.
 */
export function categoryFromScan(data: {
  categoryId: string | null;
  categoryName: string | null;
  categorySuggestions?: CategoryHint[];
}): { categoryId: string | null; categoryName: string; hints: CategoryHint[] } {
  return {
    categoryId: data.categoryId ?? null,
    categoryName: data.categoryId ? data.categoryName ?? "" : "",
    hints: data.categorySuggestions ?? [],
  };
}
