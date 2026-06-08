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
 * Auto-filled (added 2026-06 — owner now wants these pre-filled to confirm):
 *   waga / masa / gramatura / weight   ← from OFF product_quantity / detectVolume
 *   kraj pochodzenia / kraj produkcji  ← from OFF origins_tags, else EAN GS1 prefix
 * Both are populated at MEDIUM/LOW confidence (data is noisy) so the user
 * still reviews them — they are suggestions, not silent commits.
 *
 * Still skipped (regulated — user must verify against the physical product):
 *   termin przydatności / expiry / data ważności
 *   alergeny / allergens
 *   certyfikaty / certyfikaty ekologiczne / organic certifications
 */

import type { LookupMeta, FieldSources } from "./lookup";

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
  /** e.g. "g", "kg", "ml", "l" — needed to fill numeric weight params correctly. */
  unit?: string | null;
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
  source:
    | "default"
    | "scan"
    | "lookup"
    | "name_keyword"
    | "off_tags"
    | "ean_country"
    | "allegro_catalog"
    | "vision"
    | "llm_match";
  /** Precise origin of the value when known, e.g. "openfoodfacts/de", "google_kaufland". */
  sourceDetail?: string;
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
  /** Per-field provenance from the web aggregator, used to tag fills precisely. */
  fieldSources?: FieldSources;
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
// NOTE: waga and kraj pochodzenia are intentionally NOT here anymore — they are
// now auto-filled (see weight/country branches below). Only genuinely regulated
// fields stay skipped.
const SKIP_PATTERNS: Array<{ re: RegExp; reason: SkippedParameter["reason"] }> = [
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

// Multilingual: PL + EN + DE + FR keywords (domain = imported DE/FR sweets).
const FLAVOR_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /\b(vanil\w*|wanili\w*|vanille)\b/i, label: "Waniliowy" },
  { re: /\b(czekolad\w*|chocolat\w*|cookie dough|m\s?&?\s?m'?s|kakao|schoko\w*|cacao)\b/i, label: "Czekoladowy" },
  { re: /\b(jagod\w*|borówk\w*|borowk\w*|blueberry|heidelbeer\w*|myrtille\w*)\b/i, label: "Jagodowy" },
  { re: /\b(truskaw\w*|strawberry|erdbeer\w*|fraise\w*)\b/i, label: "Truskawkowy" },
  { re: /\b(malin\w*|raspberry|himbeer\w*|framboise\w*)\b/i, label: "Malinowy" },
  { re: /\b(pomarańcz\w*|pomaranc\w*|orange|apfelsine\w*)\b/i, label: "Pomarańczowy" },
  { re: /\b(cytry\w*|lemon|zitrone\w*|citron\w*)\b/i, label: "Cytrynowy" },
  { re: /\b(mięt\w*|miet\w*|mint|minze\w*|menthe\w*)\b/i, label: "Miętowy" },
  { re: /\b(pistacj\w*|pistachio|pistazie|pistache)\b/i, label: "Pistacjowy" },
  { re: /\b(kawa|kawowy|coffee|kaffee|café|cafe)\b/i, label: "Kawowy" },
  { re: /\b(karmel\w*|caramel|karamell)\b/i, label: "Karmelowy" },
  { re: /\b(jabł\w*|jabl\w*|apple|apfel)\b/i, label: "Jabłkowy" },
  { re: /\b(banan\w*|banana)\b/i, label: "Bananowy" },
  { re: /\b(kokos\w*|coconut|noix de coco)\b/i, label: "Kokosowy" },
  { re: /\b(orzech\w*|nut|hazelnut|peanut|haselnuss|noisette|nuss)\b/i, label: "Orzechowy" },
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

// ── Country of origin ────────────────────────────────────────────────────────

// OFF country/origin tag (en:germany, de:deutschland, "France", …) → Polish label.
const OFF_COUNTRY_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /german|deutschland|niemcy|allemagne/i, label: "Niemcy" },
  { re: /poland|polska|pologne|polen/i, label: "Polska" },
  { re: /\bital|włochy|wlochy|italie|italien/i, label: "Włochy" },
  { re: /belg/i, label: "Belgia" },
  { re: /netherland|holand|holland|pays-bas|niederlande|nederland/i, label: "Holandia" },
  { re: /france|francj|frankreich|francia/i, label: "Francja" },
  { re: /austria|österreich|osterreich|autriche/i, label: "Austria" },
  { re: /switzerland|szwajcar|schweiz|suisse|svizzera/i, label: "Szwajcaria" },
  { re: /spain|hiszpan|espagne|spanien|españa/i, label: "Hiszpania" },
  { re: /united kingdom|wielka brytania|royaume-uni|\buk\b|great britain/i, label: "Wielka Brytania" },
  { re: /czech|czechy|tchéqu|tschechien/i, label: "Czechy" },
  { re: /slovak|słowacj|slowacj/i, label: "Słowacja" },
  { re: /turk|turcj|türkei/i, label: "Turcja" },
];

// EAN GS1 prefix → Polish country (mirrors the frontend EAN_COUNTRY_MAP). This
// is the *barcode-issuer* country, a reasonable origin default for our domain
// (premium DE/FR/IT imports) but only LOW confidence.
const EAN_PREFIX_COUNTRY: Array<[number, number, string]> = [
  [300, 379, "Francja"],
  [400, 440, "Niemcy"],
  [500, 509, "Wielka Brytania"],
  [590, 590, "Polska"],
  [800, 839, "Włochy"],
  [840, 849, "Hiszpania"],
  [858, 858, "Czechy"],
  [859, 859, "Słowacja"],
  [869, 869, "Turcja"],
];

function countryFromOffTags(tags: string[] | undefined): string | null {
  if (!tags) return null;
  for (const tag of tags) {
    const lbl = extractFirstFromMap(tag, OFF_COUNTRY_MAP);
    if (lbl) return lbl;
  }
  return null;
}

function countryFromEan(ean: string): string | null {
  const digits = ean.replace(/\D/g, "");
  if (digits.length < 3) return null;
  const prefix = parseInt(digits.slice(0, 3), 10);
  if (Number.isNaN(prefix)) return null;
  for (const [from, to, label] of EAN_PREFIX_COUNTRY) {
    if (prefix >= from && prefix <= to) return label;
  }
  return null;
}

// ── OFF category tag → Polish "rodzaj/typ" candidate ─────────────────────────
// OFF category tags arrive in EN/FR/DE and never match the Polish Allegro
// dictionary directly, so we translate the most common food types.
const OFF_TYPE_MAP: Array<{ re: RegExp; label: string }> = [
  { re: /coffee|kawa|kaffee|café|cafe/i, label: "Kawa" },
  // Match singular/plural/compound tea tags (en:tea, en:teas, en:green-teas,
  // en:tea-bags) but NOT "tea-tree(-oil)"; bare tee/thé kept word-bounded.
  { re: /\btea(?:s|-bags?)?\b(?!-tree)|herbat|\btee\b|thé/i, label: "Herbata" },
  { re: /milk-chocolate|chocolat.*lait|chocolate|czekolad|schokolade/i, label: "Czekolada" },
  { re: /chocolate-bar|candy-bar|biscuity-bar|\bbars?\b|baton|riegel/i, label: "Baton" },
  { re: /gummy|gélifi|gelifi|jelly|żelk|zelk|fruchtgummi|gum/i, label: "Żelki" },
  { re: /bonbon|candies|candy|cukierk|sweets|süßwaren|suesswaren|confiserie|confection/i, label: "Cukierki" },
  { re: /biscuit|cookie|ciastk|herbatnik|keks|gâteau|gateau|wafer|wafl/i, label: "Ciastka" },
  { re: /spread|tartiner|aufstrich|krem do smarowania/i, label: "Krem do smarowania" },
  { re: /praline|pralin/i, label: "Praliny" },
  { re: /chips|crisps|chrupk/i, label: "Chipsy" },
  { re: /\bnuts?\b|orzech|nüsse|nuesse/i, label: "Orzechy" },
];

/**
 * Walk category tags most-specific → most-generic and return the first label
 * from `map`. Crucial because OFF parent tags are often wrong (e.g. Haribo
 * Tagada is mis-tagged "chocolate-candies"); the specific leaf ("Fraises
 * gélifiées") is usually right, so we must hit it before the noisy parents.
 */
function matchTagsSpecificFirst(
  tags: string[] | undefined,
  map: Array<{ re: RegExp; label: string }>,
): string | null {
  if (!tags) return null;
  for (let i = tags.length - 1; i >= 0; i--) {
    const lbl = extractFirstFromMap(tags[i], map);
    if (lbl) return lbl;
  }
  return null;
}

function typeFromOffCategories(tags: string[] | undefined): string | null {
  return matchTagsSpecificFirst(tags, OFF_TYPE_MAP);
}

/**
 * A Polish product-type hint (e.g. "Czekolada", "Żelki", "Kawa") derived from
 * OFF category tags. Used by the category resolver as an extra drill keyword so
 * the Supermarket-subtree walk can match child category names even when the
 * product name carries no recognizable keyword.
 */
export function deriveOffTypeHint(meta: LookupMeta | undefined): string | null {
  return typeFromOffCategories(meta?.categoriesTags);
}

// ── Weight parsing for waga/masa params ──────────────────────────────────────

interface ParsedWeight {
  value: number;
  unit: "g" | "ml";
}

/** Parse "500 g", "1,5 kg", "250 ml", "0.33 l" → normalized {value, unit:g|ml}. */
function parseWeight(text: string | null | undefined): ParsedWeight | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  if (Number.isNaN(num)) return null;
  switch (m[2].toLowerCase()) {
    case "kg": return { value: Math.round(num * 1000), unit: "g" };
    case "g": return { value: Math.round(num), unit: "g" };
    case "l": return { value: Math.round(num * 1000), unit: "ml" };
    case "cl": return { value: Math.round(num * 10), unit: "ml" };
    case "ml": return { value: Math.round(num), unit: "ml" };
    default: return null;
  }
}

/** Convert a normalized weight to the value a numeric Allegro param expects,
 *  given that param's declared unit. Returns a string ready for `values`. */
function weightForParamUnit(w: ParsedWeight, unit: string | null | undefined): string | null {
  // A zero/negative weight is never valid data and Allegro rejects numeric params
  // ≤ 0 — never emit it.
  if (!(w.value > 0)) return null;
  const u = (unit ?? "").toLowerCase();
  const nonZero = (n: number): string | null => (n > 0 ? String(n) : null);
  if (w.unit === "g") {
    if (u.includes("kg")) return nonZero(+(w.value / 1000).toFixed(3));
    // default grams (most Allegro food weight params use g or have no unit)
    return nonZero(w.value);
  }
  // volume
  if (u.includes("l") && !u.includes("ml")) return nonZero(+(w.value / 1000).toFixed(3));
  return nonZero(w.value);
}

// ── Param-name classifiers ───────────────────────────────────────────────────

const NAME_RE = {
  ean: /\b(ean|gtin|kod kreskowy|kod producenta|barcode)\b/i,
  brand: /\b(marka|brand|producent|manufacturer)\b/i,
  condition: /\bstan\b/i,
  weight: /\b(waga|masa|gramatura|gramatúra|weight|masa netto|netto)\b/i,
  country: /\b(kraj pochodzenia|kraj produkcji|country of origin|kraj prod)\b/i,
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
  // Flavour from OFF category tags — walked most-specific first so the correct
  // leaf wins over noisy parent tags. Lower confidence than name-derived.
  // Ingredients are deliberately excluded — they list every component and would
  // mislabel almost everything "Czekoladowy".
  const flavorFromCategories = matchTagsSpecificFirst(data.offMeta?.categoriesTags, FLAVOR_MAP);
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
  // categoriesTags → Polish rodzaj/typ candidate (translated from EN/FR/DE).
  const typeFromOff = typeFromOffCategories(data.offMeta?.categoriesTags);

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

    // ── Weight / mass (waga, masa, gramatura) ─────────────────────────────
    if (NAME_RE.weight.test(p.name)) {
      const parsed = parseWeight(data.weight);
      if (parsed) {
        if (p.type === "dictionary" && p.options && p.options.length > 0) {
          // Some categories model weight as ranges — try the raw string.
          const m =
            (data.weight ? matchOption(p.options, data.weight) : null) ??
            matchOption(p.options, `${parsed.value} ${parsed.unit}`);
          if (m) {
            filled.push({
              id: p.id, name: p.name, value: m.id, valueLabel: m.label,
              // Cap to medium: OFF weight is a suggestion to verify, even on an
              // exact dictionary-option match (mirrors the country branch + header policy).
              kind: "valuesIds", confidence: capConfidence(m.confidence, "medium"), source: "lookup",
            });
            continue;
          }
        } else if (p.type === "float" || p.type === "integer") {
          const v = weightForParamUnit(parsed, p.unit);
          if (v) {
            filled.push({
              id: p.id, name: p.name, value: v, kind: "values",
              confidence: "medium", source: "lookup",
            });
            continue;
          }
        } else if (p.type === "string" && data.weight) {
          filled.push({
            id: p.id, name: p.name, value: data.weight, kind: "values",
            confidence: "medium", source: "lookup",
          });
          continue;
        }
      }
      if (p.required) missingData++;
      continue; // weight param handled (or genuinely unknown)
    }

    // ── Country of origin (kraj pochodzenia) ──────────────────────────────
    if (NAME_RE.country.test(p.name)) {
      // Country of ORIGIN only — never OFF countries_tags (those are sales
      // markets, not manufacture). Use OFF origins_tags / manufacturing places
      // (or a value the caller put there from a back-of-pack photo), else the
      // EAN GS1 prefix as a low-confidence default.
      const fromOff = countryFromOffTags(data.offMeta?.originsTags);
      const fromEan = countryFromEan(data.ean);
      const candidate = fromOff ?? fromEan;
      const baseConf: FilledParameter["confidence"] = fromOff ? "medium" : "low";
      const src: FilledParameter["source"] = fromOff ? "off_tags" : "ean_country";
      if (candidate) {
        if (p.type === "dictionary" && p.options && p.options.length > 0) {
          const m = matchOption(p.options, candidate);
          if (m) {
            filled.push({
              id: p.id, name: p.name, value: m.id, valueLabel: m.label,
              kind: "valuesIds",
              confidence: m.confidence === "low" ? "low" : baseConf,
              source: src,
            });
            continue;
          }
        } else if (p.type === "string") {
          filled.push({
            id: p.id, name: p.name, value: candidate, kind: "values",
            confidence: baseConf, source: src,
          });
          continue;
        }
      }
      if (p.required) missingData++;
      continue; // country param handled (or unknown)
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

    if (NAME_RE.flavor.test(p.name)) {
      const flavorCandidate = flavorFromName ?? flavorFromCategories;
      if (flavorCandidate) {
        // Name-derived flavour is fairly trustworthy (medium); a flavour
        // guessed from OFF categories is a hint only (low — show "sprawdź").
        const filledItem = pickValue(
          p,
          flavorCandidate,
          flavorFromName ? "name_keyword" : "off_tags",
          flavorFromName ? "medium" : "low",
        );
        if (filledItem) {
          filled.push(filledItem);
          continue;
        }
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

    // ── OFF tag-based (curated maps → medium confidence, "sprawdź") ────────
    if (NAME_RE.packaging.test(p.name) && packagingFromOff) {
      const filledItem = pickValue(p, packagingFromOff, "off_tags", "medium");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.features.test(p.name) && labelFromOff) {
      const filledItem = pickValue(p, labelFromOff, "off_tags", "medium");
      if (filledItem) {
        filled.push(filledItem);
        continue;
      }
    }

    if (NAME_RE.type.test(p.name)) {
      // Try OFF tag first (translated + most-specific), fall back to flavour /
      // category keyword. Either way it's an inference → cap at medium.
      const candidate =
        typeFromOff ??
        flavorFromName ??
        data.categoryKeyword ??
        null;
      if (candidate) {
        const filledItem = pickValue(
          p,
          candidate,
          typeFromOff ? "off_tags" : "name_keyword",
          "medium",
        );
        if (filledItem) {
          filled.push(filledItem);
          continue;
        }
      }
    }

    // No match — count as missing if required, otherwise just leave it
    if (p.required) missingData++;
  }

  // Attach precise web provenance (e.g. "openfoodfacts/de", "google_kaufland")
  // to the fields that come from the aggregator, so the UI can show the source.
  if (data.fieldSources) {
    for (const f of filled) {
      if (NAME_RE.brand.test(f.name)) f.sourceDetail ??= data.fieldSources.brand?.source;
      else if (NAME_RE.weight.test(f.name)) f.sourceDetail ??= data.fieldSources.weight?.source;
      else if (NAME_RE.country.test(f.name)) f.sourceDetail ??= data.fieldSources.country?.source;
    }
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
const CONF_RANK: Record<FilledParameter["confidence"], number> = { low: 0, medium: 1, high: 2 };

/** Lower of two confidence bands — used to cap noisy-source fills. */
function capConfidence(
  c: FilledParameter["confidence"],
  cap: FilledParameter["confidence"],
): FilledParameter["confidence"] {
  return CONF_RANK[c] <= CONF_RANK[cap] ? c : cap;
}

function pickValue(
  p: AllegroFillerParam,
  candidate: string,
  source: FilledParameter["source"],
  cap: FilledParameter["confidence"] = "high",
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
      // An exact dictionary match doesn't make a noisy SOURCE reliable, so the
      // caller can cap the band (e.g. flavour guessed from OFF category tags).
      confidence: capConfidence(m.confidence, cap),
      source,
    };
  }
  if (p.type === "string") {
    return {
      id: p.id,
      name: p.name,
      value: candidate,
      kind: "values",
      confidence: capConfidence("medium", cap),
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
