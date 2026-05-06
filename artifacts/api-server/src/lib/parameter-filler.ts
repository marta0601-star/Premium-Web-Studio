/**
 * Parameter auto-fill for products created OUTSIDE the Allegro catalog.
 *
 * The scan endpoint hands us:
 *   - a list of Allegro parameters for the (resolved-leaf) category
 *   - product data we collected from external sources (OFF, UPCitemDB, …)
 *
 * For each Allegro parameter we decide one of:
 *   • SKIP    — explicitly user-fills (waga, kraj produkcji, termin, …)
 *   • FILL    — we know a value with enough confidence to populate it
 *   • LEAVE   — the parameter is something we just don't know about
 *
 * Confidence is reported per-fill so the frontend can flag low-confidence
 * picks (e.g. "Smak: Cookie dough" extracted from the product name) versus
 * deterministic ones ("Stan: Nowy", "EAN: …") where there is no ambiguity.
 *
 * Outside scope (per user policy — they prefer to fill these themselves):
 *   waga / masa / gramatura / weight
 *   kraj pochodzenia / kraj produkcji / country
 *   termin przydatności / expiry / data ważności
 *   alergeny / allergens
 *   certyfikaty / certyfikaty ekologiczne / organic certifications
 */

import type { LookupMeta } from "./lookup";

// ── Types ────────────────────────────────────────────────────────────────────

export interface AllegroParamOption {
  id: string;
  name: string;
}

export interface AllegroFillerParam {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options?: AllegroParamOption[];
}

export interface FilledParameter {
  id: string;
  name: string;
  /** Single string (free-text) or single dictionary option id. Arrays not used. */
  value: string;
  /** Set when the value is a dictionary option id; the human-readable label. */
  valueLabel?: string;
  /** "valuesIds" for dictionary fills, "values" for free-text fills. */
  kind: "values" | "valuesIds";
  confidence: "high" | "medium" | "low";
  source: "default" | "scan" | "lookup" | "name_keyword" | "off_tags";
}

export interface SkippedParameter {
  id: string;
  name: string;
  reason: "user_fills_manually" | "regulated" | "unknown_value";
}

export interface FillerInput {
  productName: string;
  brand: string | null;
  categoryKeyword: string | null;
  ean: string;
  weight: string | null; // already sanitised; null if rejected or absent
  offMeta?: LookupMeta;
}

export interface FillerOutput {
  filled: FilledParameter[];
  skipped: SkippedParameter[];
  stats: {
    totalAllegroParams: number;
    filled: number;
    skippedByPolicy: number;
    missingData: number;
  };
}

// ── Skip / always-fill rules ─────────────────────────────────────────────────

// Param-name regexes that the user said NOT to auto-fill. Tested case-
// insensitively against the trimmed parameter name.
const SKIP_PATTERNS: Array<{ re: RegExp; reason: SkippedParameter["reason"] }> = [
  { re: /^(waga|masa|gramatura|weight|masa netto|netto)\b/i, reason: "user_fills_manually" },
  { re: /\b(kraj pochodzenia|kraj produkcji|country of origin|kraj prod)\b/i, reason: "user_fills_manually" },
  { re: /\b(termin przydatności|termin przydatnosci|data ważności|data waznosci|expiry|expiration)\b/i, reason: "regulated" },
  { re: /\b(alergeny|allergens|alergen)\b/i, reason: "regulated" },
  { re: /\b(certyfikaty|certyfikat|ekologiczne|organic|bio certif)\b/i, reason: "regulated" },
];

function shouldSkip(paramName: string): SkippedParameter["reason"] | null {
  for (const { re, reason } of SKIP_PATTERNS) {
    if (re.test(paramName)) return reason;
  }
  return null;
}

// ── Helpers: dictionary fuzzy matching ───────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Try increasingly lax matches against an option list. Returns the option
 * id and a confidence band, or null if nothing was good enough.
 *
 *   exact            → high
 *   substring (≥4ch) → medium
 *   first-word match → low
 */
function matchOption(
  options: AllegroParamOption[],
  candidate: string,
): { id: string; label: string; confidence: "high" | "medium" | "low" } | null {
  if (!candidate || options.length === 0) return null;
  const c = normalize(candidate);
  if (!c) return null;

  for (const o of options) {
    if (normalize(o.name) === c) {
      return { id: o.id, label: o.name, confidence: "high" };
    }
  }
  for (const o of options) {
    const on = normalize(o.name);
    if (on.length >= 4 && on.includes(c)) {
      return { id: o.id, label: o.name, confidence: "medium" };
    }
    if (c.length >= 4 && c.includes(on) && on.length >= 4) {
      return { id: o.id, label: o.name, confidence: "medium" };
    }
  }
  // First-token equivalence — least confident
  const cFirst = c.split(" ")[0];
  for (const o of options) {
    const oFirst = normalize(o.name).split(" ")[0];
    if (cFirst.length >= 4 && oFirst === cFirst) {
      return { id: o.id, label: o.name, confidence: "low" };
    }
  }
  return null;
}

// ── Keyword extractors ───────────────────────────────────────────────────────

const COLOR_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /\b(czarn\w*|black)\b/i, label: "Czarny" },
  { re: /\b(biał\w*|bial\w*|white)\b/i, label: "Biały" },
  { re: /\b(czerwon\w*|red)\b/i, label: "Czerwony" },
  { re: /\b(niebiesk\w*|blue)\b/i, label: "Niebieski" },
  { re: /\b(zielon\w*|green)\b/i, label: "Zielony" },
  { re: /\b(żółt\w*|zolt\w*|yellow)\b/i, label: "Żółty" },
  { re: /\b(szar\w*|grey|gray)\b/i, label: "Szary" },
  { re: /\b(brąz\w*|braz\w*|brown)\b/i, label: "Brązowy" },
  { re: /\b(pomarańcz\w*|pomaranc\w*|orange)\b/i, label: "Pomarańczowy" },
  { re: /\b(fiolet\w*|purple|violet)\b/i, label: "Fioletowy" },
  { re: /\b(róż\w*|roz\w*|pink)\b/i, label: "Różowy" },
];

const FLAVOR_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /\b(vanil\w*|wanili\w*)\b/i, label: "Waniliowy" },
  { re: /\b(czekolad\w*|chocolat\w*|cookie dough|m\s?&?\s?m'?s|kakao)\b/i, label: "Czekoladowy" },
  { re: /\b(jagod\w*|borówk\w*|borowk\w*|blueberry)\b/i, label: "Jagodowy" },
  { re: /\b(truskaw\w*|strawberry)\b/i, label: "Truskawkowy" },
  { re: /\b(malin\w*|raspberry)\b/i, label: "Malinowy" },
  { re: /\b(pomarańcz\w*|pomaranc\w*|orange)\b/i, label: "Pomarańczowy" },
  { re: /\b(cytry\w*|lemon)\b/i, label: "Cytrynowy" },
  { re: /\b(mięt\w*|miet\w*|mint)\b/i, label: "Miętowy" },
  { re: /\b(pistacj\w*|pistachio)\b/i, label: "Pistacjowy" },
  { re: /\b(kawa|kawowy|coffee)\b/i, label: "Kawowy" },
  { re: /\b(karmel\w*|caramel)\b/i, label: "Karmelowy" },
  { re: /\b(jabł\w*|jabl\w*|apple)\b/i, label: "Jabłkowy" },
  { re: /\b(banan\w*|banana)\b/i, label: "Bananowy" },
  { re: /\b(kokos\w*|coconut)\b/i, label: "Kokosowy" },
  { re: /\b(orzech\w*|nut|hazelnut|peanut)\b/i, label: "Orzechowy" },
];

const MATERIAL_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /\b(bawełn\w*|bawelna|cotton)\b/i, label: "Bawełna" },
  { re: /\b(polyester|poliester)\b/i, label: "Poliester" },
  { re: /\b(skór\w*|skor\w*|leather)\b/i, label: "Skóra" },
  { re: /\b(metal\w*)\b/i, label: "Metal" },
  { re: /\b(plastik\w*|plastic)\b/i, label: "Plastik" },
  { re: /\b(szkł\w*|szklan\w*|glass)\b/i, label: "Szkło" },
  { re: /\b(drewn\w*|wooden|wood)\b/i, label: "Drewno" },
];

const SIZE_RE = /\b(XS|S|M|L|XL|XXL|XXXL)\b|\b\d{2,3}\b/;

// OFF packaging tag → Allegro "Opakowanie" candidate label
const PACKAGING_MAP: Record<string, string> = {
  "en:plastic-bag": "Worek",
  "en:bag": "Worek",
  "en:box": "Pudełko",
  "en:cardboard-box": "Pudełko",
  "en:bottle": "Butelka",
  "en:plastic-bottle": "Butelka plastikowa",
  "en:glass-bottle": "Butelka szklana",
  "en:can": "Puszka",
  "en:metal-can": "Puszka",
  "en:jar": "Słoik",
  "en:tube": "Tubka",
  "en:pouch": "Saszetka",
  "en:wrapper": "Folia",
};

// OFF labels tag → "Cechy" / "Właściwości" candidate label
const LABEL_MAP: Record<string, string> = {
  "en:vegetarian": "Wegetariańskie",
  "en:vegan": "Wegańskie",
  "en:gluten-free": "Bezglutenowe",
  "en:no-gluten": "Bezglutenowe",
  "en:lactose-free": "Bezlaktozowe",
  "en:no-lactose": "Bezlaktozowe",
  "en:organic": "Bio",
  "en:bio": "Bio",
  "en:no-sugar": "Bez cukru",
  "en:sugar-free": "Bez cukru",
  "en:no-preservatives": "Bez konserwantów",
};

function extractFirstFromMap(
  source: string,
  map: Array<{ re: RegExp; label: string }>,
): string | null {
  for (const { re, label } of map) {
    if (re.test(source)) return label;
  }
  return null;
}

// ── Param-name classifiers ───────────────────────────────────────────────────

const NAME_RE = {
  ean: /\b(ean|gtin|kod kreskowy|kod producenta|barcode)\b/i,
  brand: /\b(marka|brand|producent|manufacturer)\b/i,
  condition: /\bstan\b/i,
  color: /\b(kolor|color|barwa)\b/i,
  flavor: /\b(smak|flavor|flavour)\b/i,
  type: /\b(rodzaj|typ |typ$)\b/i,
  material: /\bmateria[lł]\b/i,
  size: /\b(rozmiar|size)\b/i,
  packaging: /\b(opakowanie|rodzaj opakowania|packaging)\b/i,
  features: /\b(cech\w+|właściwo|wlasciwo|properties)\b/i,
};

// ── Main ─────────────────────────────────────────────────────────────────────

export function fillCategoryParameters(
  allegroParams: AllegroFillerParam[],
  data: FillerInput,
): FillerOutput {
  const filled: FilledParameter[] = [];
  const skipped: SkippedParameter[] = [];
  let missingData = 0;

  const nameLower = data.productName.toLowerCase();
  const colorFromName = extractFirstFromMap(nameLower, COLOR_MAP);
  const flavorFromName = extractFirstFromMap(nameLower, FLAVOR_MAP);
  const materialFromName = extractFirstFromMap(nameLower, MATERIAL_MAP);
  const sizeMatch = data.productName.match(SIZE_RE);
  const sizeFromName = sizeMatch ? sizeMatch[0] : null;

  // OFF tag-derived candidate labels — pick the FIRST tag that we recognise.
  const packagingFromOff = (() => {
    for (const tag of data.offMeta?.packagingTags ?? []) {
      const lbl = PACKAGING_MAP[tag.toLowerCase()];
      if (lbl) return lbl;
    }
    return null;
  })();
  const labelFromOff = (() => {
    for (const tag of data.offMeta?.labelsTags ?? []) {
      const lbl = LABEL_MAP[tag.toLowerCase()];
      if (lbl) return lbl;
    }
    return null;
  })();
  // categoriesTags can carry extra rodzaj/typ hints — last segment after ":"
  const typeFromOff = (() => {
    const tags = data.offMeta?.categoriesTags ?? [];
    if (tags.length === 0) return null;
    // Walk from most-specific to most-generic
    const last = tags[tags.length - 1];
    const seg = last.split(":").pop();
    if (!seg) return null;
    return seg.replace(/-/g, " ").trim();
  })();

  for (const p of allegroParams) {
    const reason = shouldSkip(p.name);
    if (reason) {
      skipped.push({ id: p.id, name: p.name, reason });
      continue;
    }

    // ── Always-fill defaults ──────────────────────────────────────────────
    if (NAME_RE.ean.test(p.name) && p.type === "string" && data.ean) {
      filled.push({
        id: p.id,
        name: p.name,
        value: data.ean,
        kind: "values",
        confidence: "high",
        source: "scan",
      });
      continue;
    }

    if (NAME_RE.condition.test(p.name)) {
      if (p.type === "dictionary" && p.options && p.options.length > 0) {
        const m =
          matchOption(p.options, "Nowy") ??
          matchOption(p.options, "nowe") ??
          matchOption(p.options, "new");
        if (m) {
          filled.push({
            id: p.id,
            name: p.name,
            value: m.id,
            valueLabel: m.label,
            kind: "valuesIds",
            confidence: "high",
            source: "default",
          });
          continue;
        }
      } else if (p.type === "string") {
        filled.push({
          id: p.id,
          name: p.name,
          value: "Nowy",
          kind: "values",
          confidence: "high",
          source: "default",
        });
        continue;
      }
    }

    if (NAME_RE.brand.test(p.name) && data.brand) {
      if (p.type === "dictionary" && p.options && p.options.length > 0) {
        const m = matchOption(p.options, data.brand);
        if (m) {
          filled.push({
            id: p.id,
            name: p.name,
            value: m.id,
            valueLabel: m.label,
            kind: "valuesIds",
            confidence: m.confidence,
            source: "lookup",
          });
          continue;
        }
        // Brand not in dictionary — leave empty so user picks
        skipped.push({ id: p.id, name: p.name, reason: "unknown_value" });
        missingData++;
        continue;
      }
      if (p.type === "string") {
        filled.push({
          id: p.id,
          name: p.name,
          value: data.brand,
          kind: "values",
          confidence: "high",
          source: "lookup",
        });
        continue;
      }
    }

    // ── Keyword-based from product name ───────────────────────────────────
    if (NAME_RE.color.test(p.name) && colorFromName) {
      const filledItem = pickValue(p, colorFromName, "name_keyword");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.flavor.test(p.name) && flavorFromName) {
      const filledItem = pickValue(p, flavorFromName, "name_keyword");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.material.test(p.name) && materialFromName) {
      const filledItem = pickValue(p, materialFromName, "name_keyword");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.size.test(p.name) && sizeFromName) {
      const filledItem = pickValue(p, sizeFromName, "name_keyword");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    // ── OFF tag-based ─────────────────────────────────────────────────────
    if (NAME_RE.packaging.test(p.name) && packagingFromOff) {
      const filledItem = pickValue(p, packagingFromOff, "off_tags");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.features.test(p.name) && labelFromOff) {
      const filledItem = pickValue(p, labelFromOff, "off_tags");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.type.test(p.name)) {
      // Try OFF tag first (more specific), fall back to flavor / category keyword
      const candidate =
        typeFromOff ??
        flavorFromName ??
        data.categoryKeyword ??
        null;
      if (candidate) {
        const filledItem = pickValue(p, candidate, typeFromOff ? "off_tags" : "name_keyword");
        if (filledItem) {
          filled.push(filledItem);
          continue;
        }
      }
    }

    // No match — count as missing if required, otherwise just leave it
    if (p.required) missingData++;
  }

  return {
    filled,
    skipped,
    stats: {
      totalAllegroParams: allegroParams.length,
      filled: filled.length,
      skippedByPolicy: skipped.filter((s) => s.reason !== "unknown_value").length,
      missingData,
    },
  };
}

/**
 * Build a FilledParameter for either a dictionary or a string parameter,
 * respecting Allegro's value/valuesIds split. Returns null if a dictionary
 * had no plausible match.
 */
function pickValue(
  p: AllegroFillerParam,
  candidate: string,
  source: FilledParameter["source"],
): FilledParameter | null {
  if (p.type === "dictionary" && p.options && p.options.length > 0) {
    const m = matchOption(p.options, candidate);
    if (!m) return null;
    return {
      id: p.id,
      name: p.name,
      value: m.id,
      valueLabel: m.label,
      kind: "valuesIds",
      confidence: m.confidence,
      source,
    };
  }
  if (p.type === "string") {
    return {
      id: p.id,
      name: p.name,
      value: candidate,
      kind: "values",
      confidence: "medium",
      source,
    };
  }
  return null;
}

/**
 * Convert filled parameters into the legacy `prefillValues` shape so
 * existing frontend code that reads `prefillValues[paramId]` keeps working.
 * Catalog (Allegro) flow already produces this shape; for non-catalog we
 * synthesise it from the filler output.
 */
export function filledToPrefillValues(
  filled: FilledParameter[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of filled) {
    out[f.id] = [f.value];
  }
  return out;
}
