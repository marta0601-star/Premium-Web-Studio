/**
 * Which Allegro catalog hit (if any) may be used for a scanned EAN.
 *
 * GET /sale/products?phrase=<ean> is a text search: it can return a product
 * for a different code (the "CHAOKOH for a German water" case). Linking an
 * offer to such a product lists it on the wrong catalog card, and Allegro then
 * rejects our own values (PARAMETER_MISMATCH). So a hit is trusted only when
 * its "EAN (GTIN)" parameter carries the scanned code.
 */

/** Allegro's "EAN (GTIN)" parameter. */
const EAN_PARAM_ID = "225693";
const EAN_PARAM_NAME_RE = /\b(ean|gtin)\b/i;

export type CatalogEanDecision =
  /** a hit carries the scanned EAN → use it */
  | "ean_match"
  /** no hit carries it, but one has no EAN at all → use it, user must check */
  | "ean_missing"
  /** every hit carries a different EAN → don't use the catalog */
  | "ean_mismatch"
  | "no_products";

/** Digits only, leading zeros dropped: EAN-13 "0012…", UPC-A "012…", GTIN-14 compare equal. */
export function normalizeGtin(raw: string | null | undefined): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return digits || null;
}

type CatalogParam = { id?: string; name?: string; values?: Array<string | null> | null };

function productEans(product: { parameters?: unknown }): string[] {
  const params = Array.isArray(product.parameters) ? (product.parameters as CatalogParam[]) : [];
  return params
    .filter((p) => p.id === EAN_PARAM_ID || EAN_PARAM_NAME_RE.test(p.name ?? ""))
    .flatMap((p) => p.values ?? [])
    .filter((v): v is string => typeof v === "string" && normalizeGtin(v) !== null);
}

export function pickCatalogProductByEan<T extends { parameters?: unknown }>(
  products: T[],
  scannedEan: string,
): { product: T | null; decision: CatalogEanDecision; catalogEans: string[] } {
  if (products.length === 0) return { product: null, decision: "no_products", catalogEans: [] };

  const wanted = normalizeGtin(scannedEan);
  const withEans = products.map((product) => ({ product, eans: productEans(product) }));
  const catalogEans = withEans.flatMap((x) => x.eans);

  const match = withEans.find((x) => x.eans.some((e) => normalizeGtin(e) === wanted));
  if (match) return { product: match.product, decision: "ean_match", catalogEans };

  const missing = withEans.find((x) => x.eans.length === 0);
  if (missing) return { product: missing.product, decision: "ean_missing", catalogEans };

  return { product: null, decision: "ean_mismatch", catalogEans };
}
