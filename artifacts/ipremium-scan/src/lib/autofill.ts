/**
 * Pure form auto-fill logic for the offer form (no React, no DOM), extracted
 * from pages/Home.tsx so it can be unit-tested.
 */

import { matchDictionaryOption, quantityForParam } from "../../../api-server/src/lib/shared/autofill-rules";

// Same shape as ParameterValue in lib/api-client-react/src/generated/api.schemas.ts;
// declared here because the package index does not re-export it (see api-zod TODO).
export interface ParameterValue {
  id: string;
  values?: string[];
  valuesIds?: string[];
}

export interface AllegroParam {
  id: string;
  name: string;
  type: string;
  required: boolean;
  requiredForProduct: boolean;
  unit: string | null;
  options: Array<{ id: string; name: string }>;
  restrictions: Record<string, unknown> | null;
}

// Per-field auto-fill source (mirrors backend FilledParameter.source) + "client"
// for values the frontend derived on its own.
export type ParamSource =
  | "default"
  | "scan"
  | "lookup"
  | "name_keyword"
  | "off_tags"
  | "ean_country"
  | "allegro_catalog"
  | "vision"
  | "llm_match"
  | "client";

export type FillConfidence = "high" | "medium" | "low";

export interface ServerFilledParameter {
  id: string;
  name: string;
  value: string;
  valueLabel?: string;
  kind: "values" | "valuesIds";
  confidence: FillConfidence;
  source: ParamSource;
  sourceDetail?: string;
}

export interface ParamFillMeta {
  source: ParamSource;
  confidence: FillConfidence;
  sourceDetail?: string;
}

// ── Smart auto-fill logic ────────────────────────────────────────────────────

/** Dictionary option for a value — whole values / whole words only (shared rule:
 *  no substrings, so "Kakao" never becomes "Okakao"). */
export function fuzzyMatchOption(
  options: Array<{ id: string; name: string }>,
  query: string | null | undefined
): string | null {
  return matchDictionaryOption(options, query)?.id ?? null;
}

/** Brand parameters — whole words, so "Kod producenta" is NOT one. */
const BRAND_PARAM_RE = /\b(marka|brand|producent)\b/;

export interface ProductContext {
  ean: string;
  brand?: string | null;
  weight?: string | null;
  productName?: string | null;
  country?: string | null;
  /** The offer links an Allegro catalog product (scan returned a productId).
   *  Allegro then rejects any product parameter that differs from the catalog
   *  (PARAMETER_MISMATCH), so catalog-filled values must never be overridden. */
  catalogProduct?: boolean;
}

export function autoFillParam(
  param: AllegroParam,
  ctx: ProductContext
): { value?: ParameterValue; autoFilled: boolean } {
  const nameLower = param.name.toLowerCase();

  // "Kod producenta" is a product code, never the brand → filled with the EAN.
  const isEan = /ean|gtin|kod kreskowy|kod producenta|barcode/.test(nameLower);
  const isBrand = BRAND_PARAM_RE.test(nameLower);
  const isWeight = /waga|gramatu|masa netto|netto|weight/.test(nameLower);
  const isVolume = /pojemność|volume|litraż/.test(nameLower);
  const isName = nameLower === "nazwa handlowa" || nameLower === "nazwa produktu";
  const isCountry = /kraj pochodzenia|country of origin|kraj prod/.test(nameLower);
  const isCondition = /stan/.test(nameLower) && param.type === "dictionary";

  // EAN/GTIN string
  if (isEan && param.type === "string" && ctx.ean) {
    return { value: { id: param.id, values: [ctx.ean] }, autoFilled: true };
  }

  // Brand — dictionary fuzzy match
  if (isBrand && param.type === "dictionary") {
    const matched = fuzzyMatchOption(param.options, ctx.brand);
    if (matched) {
      return { value: { id: param.id, valuesIds: [matched] }, autoFilled: true };
    }
  }
  // Brand — string
  if (isBrand && param.type === "string" && ctx.brand) {
    return { value: { id: param.id, values: [ctx.brand] }, autoFilled: true };
  }

  // Weight / Volume — converted to the parameter's unit (137 g → 0.137 for kg);
  // a weight only from g/kg, a volume only from ml/l (shared rule with the server).
  if ((isWeight || isVolume) && (param.type === "float" || param.type === "integer") && ctx.weight) {
    const num = quantityForParam(ctx.weight, param);
    if (num) return { value: { id: param.id, values: [num] }, autoFilled: true };
  }

  // Product name
  if (isName && param.type === "string" && ctx.productName) {
    return { value: { id: param.id, values: [ctx.productName] }, autoFilled: true };
  }

  // Country of origin — dictionary fuzzy match
  if (isCountry && param.type === "dictionary" && ctx.country) {
    const matched = fuzzyMatchOption(param.options, ctx.country);
    if (matched) {
      return { value: { id: param.id, valuesIds: [matched] }, autoFilled: true };
    }
  }
  if (isCountry && param.type === "string" && ctx.country) {
    return { value: { id: param.id, values: [ctx.country] }, autoFilled: true };
  }

  // Condition — always "Nowy" if only one option
  if (isCondition && param.options.length === 1) {
    return { value: { id: param.id, valuesIds: [param.options[0].id] }, autoFilled: true };
  }
  if (isCondition) {
    const nowy = fuzzyMatchOption(param.options, "Nowy") || fuzzyMatchOption(param.options, "nowy") || param.options[0]?.id;
    if (nowy) return { value: { id: param.id, valuesIds: [nowy] }, autoFilled: true };
  }

  return { autoFilled: false };
}

export function buildAutoFilledState(
  params: AllegroParam[],
  prefillValues: Record<string, string[]>,
  ctx: ProductContext,
  serverFilled?: ServerFilledParameter[]
): {
  formState: Record<string, ParameterValue>;
  autoFilledIds: Set<string>;
  paramMeta: Record<string, ParamFillMeta>;
} {
  const formState: Record<string, ParameterValue> = {};
  const autoFilledIds = new Set<string>();
  const paramMeta: Record<string, ParamFillMeta> = {};
  const serverById = new Map((serverFilled ?? []).map((f) => [f.id, f]));

  for (const param of params) {
    const nameLower = param.name.toLowerCase();
    const isBrandParam = BRAND_PARAM_RE.test(nameLower);

    // Brand parameters OFF-catalog: prefer ctx.brand from product lookup over prefill.
    // For a catalog product the catalog value wins (fall through to the fills below):
    // overriding it only produces PARAMETER_MISMATCH. The old reason for overriding —
    // a catalog hit for a different product (CHAOKOH for a German water) — is now
    // handled server-side by only accepting catalog products that carry the scanned EAN.
    if (isBrandParam && ctx.brand && !ctx.catalogProduct) {
      if (param.type === "dictionary") {
        const matched = fuzzyMatchOption(param.options, ctx.brand);
        if (matched) {
          formState[param.id] = { id: param.id, valuesIds: [matched] };
          autoFilledIds.add(param.id);
          paramMeta[param.id] = { source: "lookup", confidence: "high" };
        } else {
          // Brand not in options list — leave empty so user selects manually
          formState[param.id] = { id: param.id };
        }
      } else if (param.type === "string") {
        formState[param.id] = { id: param.id, values: [ctx.brand] };
        autoFilledIds.add(param.id);
        paramMeta[param.id] = { source: "lookup", confidence: "high" };
      }
      continue; // Skip Allegro catalog prefill for brand
    }

    // 1. Server-computed fill — carries confidence + source attribution.
    const sf = serverById.get(param.id);
    if (sf && sf.value) {
      formState[param.id] =
        sf.kind === "valuesIds"
          ? { id: param.id, valuesIds: [sf.value] }
          : { id: param.id, values: [sf.value] };
      autoFilledIds.add(param.id);
      paramMeta[param.id] = { source: sf.source, confidence: sf.confidence, sourceDetail: sf.sourceDetail };
      continue;
    }

    // 2. Allegro catalog prefill (non-brand params the server didn't attribute).
    const catalogValues = prefillValues[param.id];
    if (catalogValues && catalogValues.length > 0) {
      if (param.type === "dictionary") {
        formState[param.id] = { id: param.id, valuesIds: catalogValues };
      } else {
        formState[param.id] = { id: param.id, values: catalogValues };
      }
      autoFilledIds.add(param.id);
      paramMeta[param.id] = { source: "allegro_catalog", confidence: "high" };
      continue;
    }

    // 3. Client-side smart auto-fill fallback (e.g. after manual category change).
    const { value, autoFilled } = autoFillParam(param, ctx);
    if (value) {
      formState[param.id] = value;
      if (autoFilled) {
        autoFilledIds.add(param.id);
        paramMeta[param.id] = { source: "client", confidence: "medium" };
      }
    } else {
      formState[param.id] = { id: param.id };
    }
  }

  return { formState, autoFilledIds, paramMeta };
}

/**
 * `step` for a numeric <input>. A step coarser than the value's decimals makes
 * the browser reject it (iOS Safari: "Zadajte platnú hodnotu"), e.g. the old
 * fixed step 0.01 vs a catalog weight of 0.777 kg. Allegro sends the allowed
 * decimals as restrictions.precision; without it any decimal is allowed.
 */
export function numericInputStep(param: AllegroParam): string | undefined {
  if (param.type === "integer") return "1";
  if (param.type !== "float") return undefined;
  const precision = Number(param.restrictions?.precision);
  if (!Number.isInteger(precision) || precision < 0) return "any";
  return precision === 0 ? "1" : (1 / 10 ** precision).toFixed(precision);
}
