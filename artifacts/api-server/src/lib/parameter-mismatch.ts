/**
 * PARAMETER_MISMATCH rescue. Allegro answers it when the offer is linked to an
 * existing catalog product (our productId, or a product it recognised itself)
 * but one of our product parameters differs from the catalog. Allegro never
 * accepts a different value, and its metadata names the exact expected one:
 *
 *   { parameterId, parameterName, currentParameterValue(Id),
 *     expectedParameterValue, expectedParameterValueId }   // *Id only for dictionaries
 *
 * so the fix is mechanical: put the expected value in, retry once, and tell the
 * user what was overridden.
 */

export type OfferParam = { id: string; values?: string[]; valuesIds?: string[] };

export interface CatalogCorrection {
  parameterId: string;
  parameterName: string;
  from: string | null;
  to: string;
  /** Polish, shown to the user next to the offer result. */
  message: string;
}

interface AllegroErrorLike {
  code?: string;
  metadata?: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Apply every usable PARAMETER_MISMATCH from one Allegro response at once.
 * Returns null when the response carries none (caller handles other errors).
 */
export function applyParameterMismatches(
  errors: AllegroErrorLike[],
  productParams: OfferParam[],
  offerParams: OfferParam[],
): { productParams: OfferParam[]; offerParams: OfferParam[]; corrections: CatalogCorrection[] } | null {
  const fixes = new Map<string, { param: OfferParam; correction: CatalogCorrection }>();

  for (const e of errors) {
    if (e.code !== "PARAMETER_MISMATCH" || !e.metadata) continue;
    const m = e.metadata;
    const parameterId = str(m.parameterId);
    const expectedId = str(m.expectedParameterValueId);
    const expectedValue = m.expectedParameterValue == null ? null : String(m.expectedParameterValue);
    if (!parameterId || (!expectedId && !expectedValue)) continue;

    const parameterName = str(m.parameterName) ?? parameterId;
    const from = str(m.currentParameterValue);
    const to = expectedValue ?? expectedId!;
    fixes.set(parameterId, {
      param: expectedId ? { id: parameterId, valuesIds: [expectedId] } : { id: parameterId, values: [to] },
      correction: {
        parameterId,
        parameterName,
        from,
        to,
        message: from
          ? `${parameterName}: zmieniono „${from}” na „${to}” zgodnie z katalogiem Allegro`
          : `${parameterName}: ustawiono „${to}” zgodnie z katalogiem Allegro`,
      },
    });
  }
  if (fixes.size === 0) return null;

  const replace = (list: OfferParam[]) => list.map((p) => fixes.get(p.id)?.param ?? p);
  const nextProduct = replace(productParams);
  const nextOffer = replace(offerParams);
  // A parameter Allegro checked but we never sent belongs to the product section
  // (the mismatch path is always productSet[0].product.parameters).
  for (const [id, { param }] of fixes) {
    if (!nextProduct.some((p) => p.id === id) && !nextOffer.some((p) => p.id === id)) nextProduct.push(param);
  }

  return {
    productParams: nextProduct,
    offerParams: nextOffer,
    corrections: Array.from(fixes.values(), (f) => f.correction),
  };
}
