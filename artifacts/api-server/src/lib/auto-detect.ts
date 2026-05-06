// ── Store name strip pattern (was duplicated in lookup.ts) ───────────────────
// Used to remove e-shop branding from scraped/lookup names so that what we
// hand to the user is the actual product name, not "Amazon — Snickers 50g".
export const STORE_NAMES_TO_REMOVE =
  /\b(amazon|ebay|allegro|kaufland|walmart|target|costco|tesco|carrefour|auchan|lidl|aldi|biedronka|rossmann|dm|drogerie|media markt|saturn)\b/gi;

// ── Category keyword detection ────────────────────────────────────────────────

const CATEGORY_KEYWORD_MAP: Array<{ patterns: string[]; keyword: string }> = [
  { patterns: ["energy drink", "napój energetyczny", "energetyk", "energy 2", "energy 4", "energy 6", "energy 8", "energy 10", "energy 12", "energy 24", "energy 48", "energy plus", "energy zero"], keyword: "Napoje energetyczne" },
  { patterns: ["red bull", "redbull", "monster energy", "hell energy", "burn energy", "tiger energy", "black energy", "flying power", "hell fire", "darkness energy"], keyword: "Napoje energetyczne" },
  { patterns: ["energy"], keyword: "Napoje energetyczne" },
  { patterns: ["energetyczny", "energetyk"], keyword: "Napoje energetyczne" },
  { patterns: ["cola", "fanta", "sprite", "pepsi", "7up", "mirinda", "napój gazowany"], keyword: "Napoje gazowane" },
  { patterns: ["sok owocowy", "sok jabłkowy", "sok pomarańczowy", "sok wieloowocowy", "sok porzeczkowy", "juice drink", "multifruit"], keyword: "Soki owocowe" },
  { patterns: ["sok ", "juice", "nektar"], keyword: "Soki" },
  { patterns: ["piwo", "beer", "bier", "lager", "pilsner", "pilsener", "porter", "stout", "weizen", " ale ", "chmiel", "browar"], keyword: "Piwo" },
  { patterns: ["woda mineralna", "woda gazowana", "woda niegazowana", "woda źródlana", "woda stołowa", "mineral water", "sparkling water"], keyword: "Woda mineralna" },
  { patterns: ["woda", "water", "wasser"], keyword: "Woda" },
  { patterns: ["mleko", "milk", "milch", "mleko UHT", "mleko pełnotłuste", "mleko półtłuste"], keyword: "Mleko" },
  { patterns: ["jogurt", "yogurt", "joghurt", "kefir", "maślanka"], keyword: "Jogurty i kefiry" },
  { patterns: ["czekolada", "czekolad", "chocolate", "schokolade", "pralin", "milka", "kitkat", "kit kat"], keyword: "Czekolady" },
  { patterns: ["cukierek", "żelki", "gummi", "gummy", "haribo", "mentos", "tic tac", "drops", "lizak", "karamele"], keyword: "Cukierki i żelki" },
  { patterns: ["chipsy", "chips", "pringles", "lay's", "lays", "chrupki", "nachos", "popcorn", "pretzels", "krakersy"], keyword: "Chipsy i chrupki" },
  { patterns: ["kawa", "coffee", "kaffee", "nescafe", "nescafé", "espresso", "cappuccino", "latte"], keyword: "Kawa" },
  { patterns: ["herbata", "tea", "tee", "lipton", "tetley", "earl grey", "green tea", "zielona herbata"], keyword: "Herbata" },
  { patterns: ["konserwa", "konserw", "puszka rybna", "tuńczyk", "łosoś", "makrela", "sardynka", "śledź"], keyword: "Konserwy rybne" },
  { patterns: ["makaron", "spaghetti", "tagliatelle", "farfalle", "penne", "rigatoni", "fusilli", "barilla pasta"], keyword: "Makaron" },
  { patterns: ["ketchup", "musztarda", "majonez", "sos sojowy", "sos teriyaki", "dressing", "vinaigrette"], keyword: "Sosy i przyprawy" },
  { patterns: ["płatki śniadaniowe", "musli", "granola", "corn flakes", "owsianka", "cereals"], keyword: "Płatki śniadaniowe" },
  { patterns: ["batony", "baton", "snickers", "twix", "mars", "bounty", "kitkat", "bat proteinowy"], keyword: "Batoniki" },
];

// ── Brand mapping ─────────────────────────────────────────────────────────────

const BRAND_MAP: Array<{ patterns: string[]; canonical: string }> = [
  { patterns: ["red bull", "redbull"], canonical: "Red Bull" },
  { patterns: ["monster energy", "monster"], canonical: "Monster" },
  { patterns: ["hell energy", "hell fire", "hell ", "flying power"], canonical: "Hell" },
  { patterns: ["burn energy", "burn"], canonical: "Burn" },
  { patterns: ["tiger energy", "tiger"], canonical: "Tiger" },
  { patterns: ["black energy"], canonical: "Black" },
  { patterns: ["coca-cola", "coca cola", "cocacola", "coke zero", "coke"], canonical: "Coca-Cola" },
  { patterns: ["pepsi"], canonical: "Pepsi" },
  { patterns: ["fanta"], canonical: "Fanta" },
  { patterns: ["sprite"], canonical: "Sprite" },
  { patterns: ["tymbark"], canonical: "Tymbark" },
  { patterns: ["cisowianka"], canonical: "Cisowianka" },
  { patterns: ["żywiec zdrój", "zywiec zdroj"], canonical: "Żywiec Zdrój" },
  { patterns: ["żywiec", "zywiec"], canonical: "Żywiec" },
  { patterns: ["łomża", "lomza"], canonical: "Łomża" },
  { patterns: ["okocim"], canonical: "Okocim" },
  { patterns: ["lech"], canonical: "Lech" },
  { patterns: ["milka"], canonical: "Milka" },
  { patterns: ["kitkat", "kit kat"], canonical: "Kit Kat" },
  { patterns: ["snickers"], canonical: "Snickers" },
  { patterns: ["twix"], canonical: "Twix" },
  { patterns: ["mars "], canonical: "Mars" },
  { patterns: ["bounty"], canonical: "Bounty" },
  { patterns: ["haribo"], canonical: "Haribo" },
  { patterns: ["mentos"], canonical: "Mentos" },
  { patterns: ["tic tac", "tictac"], canonical: "Tic Tac" },
  { patterns: ["lay's", "lays", "lay s"], canonical: "Lay's" },
  { patterns: ["pringles"], canonical: "Pringles" },
  { patterns: ["barilla"], canonical: "Barilla" },
  { patterns: ["nestlé", "nestle", "nescafé", "nescafe"], canonical: "Nestlé" },
  { patterns: ["knorr"], canonical: "Knorr" },
  { patterns: ["dr. oetker", "dr oetker", "oetker"], canonical: "Dr. Oetker" },
  { patterns: ["lipton"], canonical: "Lipton" },
  { patterns: ["tetley"], canonical: "Tetley" },
];

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ParsedVolume {
  value: number;
  unit: "ml" | "g";
}

export interface AllegroParamOption {
  id: string;
  name: string;
}

export interface AllegroParam {
  id: string;
  name: string;
  type: string;
  required: boolean;
  requiredForProduct: boolean;
  unit: string | null;
  options: AllegroParamOption[];
  restrictions: Record<string, unknown> | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toTitleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(?:^|\s|-)\S/g, (c) => c.toUpperCase());
}

/**
 * Heuristic: title-case the string when it is "shouty" — i.e. more than
 * 60 % of its letters are upper-case. Fully ALL-CAPS strings always pass
 * (>60 % is met trivially), but mixed-shouty cases like "MILKA Mleczna
 * Czekolada" (~70 % upper) also get normalised, which the previous
 * "all-upper-only" check missed.
 */
function smartTitleCaseIfShouty(s: string): string {
  const letters = s.match(/[a-zA-ZĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g) ?? [];
  const upper = s.match(/[A-ZĄĆĘŁŃÓŚŹŻ]/g) ?? [];
  if (letters.length < 4) return s;
  const ratio = upper.length / letters.length;
  return ratio > 0.6 ? toTitleCase(s) : s;
}

// ── Volume / weight parser ────────────────────────────────────────────────────

export type CategoryWeightContext =
  | "CANDY"
  | "BEVERAGE"
  | "COSMETIC"
  | "GROCERY"
  | "GENERIC";

/**
 * Map a free-form category hint (output of detectCategoryKeyword, OFF
 * categories tag, or Allegro categoryName) to the bucket whose minimum
 * thresholds parseVolume should apply. The point is to keep "3 g" out of
 * candy product names — typical candies start at ~15 g per piece, so a
 * smaller value almost always means a vitamin label, marketing copy, or a
 * stray number like "3 godziny".
 */
export function classifyCategoryWeightContext(
  hint?: string | null,
): CategoryWeightContext {
  if (!hint) return "GENERIC";
  const h = hint.toLowerCase();
  if (
    /cukier|słodyc|slodycz|candy|chocolat|czekolad|snack|przekąs|przekas|gum |guma|drażetk|drazetk|wafer|wafl|ciast|cookie|baton|cukierk|żelk|zelk/i.test(
      h,
    )
  )
    return "CANDY";
  if (
    /napój|napoj|drink|sok |juice|wod |water|piwo|beer|wino|wine|kawa|coffee|herbat|tea|mleko|milk|nektar/i.test(
      h,
    )
  )
    return "BEVERAGE";
  if (
    /kosmety|cosmetic|krem|cream|szampon|shampoo|mydło|mydlo|soap|perfum|dezodorant|balsam/i.test(
      h,
    )
  )
    return "COSMETIC";
  if (/spożyw|spozyw|grocery|food|produk|jedzeni|cooking|sos |sól |sol |przyprawa|makaron|płatk|platk/i.test(h))
    return "GROCERY";
  return "GENERIC";
}

/**
 * Minimum reasonable weight/volume per category context. A value below the
 * threshold is treated as a misread (e.g. "3g" inside a chocolate bar name,
 * which usually means "3 grams of sugar per serving" or an unrelated
 * marketing number, not the package size).
 */
const MIN_REASONABLE: Record<
  CategoryWeightContext,
  { g?: number; ml?: number }
> = {
  CANDY: { g: 15 },
  BEVERAGE: { ml: 100 },
  COSMETIC: { g: 5, ml: 5 },
  GROCERY: { g: 10, ml: 50 },
  GENERIC: { g: 1, ml: 1 },
};

function passesSanity(
  v: ParsedVolume,
  ctx: CategoryWeightContext,
): boolean {
  const min = MIN_REASONABLE[ctx];
  if (v.unit === "g" && min.g !== undefined && v.value < min.g) return false;
  if (v.unit === "ml" && min.ml !== undefined && v.value < min.ml) return false;
  return true;
}

/**
 * Parse a weight/volume out of free text. With `categoryHint` supplied we
 * additionally reject values below `MIN_REASONABLE[context]` — e.g. "3 g"
 * for candy is dropped because that's smaller than any real candy package.
 *
 * Without the hint the legacy GENERIC threshold (≥1) applies, which keeps
 * existing callers backward-compatible.
 *
 * The optional out-param `outRejected` lets the caller log *why* a value
 * was thrown out, for debug surfaces.
 */
export function parseVolume(
  text: string,
  categoryHint?: string | null,
  outRejected?: { reason?: string },
): ParsedVolume | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  const ctx = classifyCategoryWeightContext(categoryHint);

  // "0,5 l" or "0.5l" or "1,5L" (fractional litres → ml)
  const fracL = t.match(/\b(0[.,]\d+)\s*[Ll]\b/i);
  if (fracL) {
    const ml = Math.round(parseFloat(fracL[1].replace(",", ".")) * 1000);
    const r: ParsedVolume = { value: ml, unit: "ml" };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${fracL[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].ml}ml)`;
    return null;
  }

  // "500 ml", "330ML"
  const mlMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Mm][Ll]\b/i);
  if (mlMatch) {
    const r: ParsedVolume = {
      value: Math.round(parseFloat(mlMatch[1].replace(",", "."))),
      unit: "ml",
    };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${mlMatch[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].ml}ml)`;
    return null;
  }

  // "25 cl", "33cl"
  const clMatch = t.match(/\b(\d+)\s*[Cc][Ll]\b/i);
  if (clMatch) {
    const r: ParsedVolume = { value: parseInt(clMatch[1]) * 10, unit: "ml" };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${clMatch[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].ml}ml)`;
    return null;
  }

  // "1 L", "2L" (whole litres)
  const lMatch = t.match(/\b(\d+)\s*[Ll]\b/i);
  if (lMatch) {
    const r: ParsedVolume = { value: parseInt(lMatch[1]) * 1000, unit: "ml" };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${lMatch[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].ml}ml)`;
    return null;
  }

  // "1,5 kg", "1.5kg"
  const kgMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Kk][Gg]\b/i);
  if (kgMatch) {
    const r: ParsedVolume = {
      value: Math.round(parseFloat(kgMatch[1].replace(",", ".")) * 1000),
      unit: "g",
    };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${kgMatch[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].g}g)`;
    return null;
  }

  // "500 g", "200g"
  const gMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Gg]\b/i);
  if (gMatch) {
    const r: ParsedVolume = {
      value: Math.round(parseFloat(gMatch[1].replace(",", "."))),
      unit: "g",
    };
    if (passesSanity(r, ctx)) return r;
    if (outRejected) outRejected.reason = `rejected '${gMatch[0]}' for ${ctx} (below min ${MIN_REASONABLE[ctx].g}g)`;
    return null;
  }

  return null;
}

// ── Main detection functions ──────────────────────────────────────────────────

export function detectCategoryKeyword(name: string): string | null {
  const lower = name.toLowerCase();
  for (const { patterns, keyword } of CATEGORY_KEYWORD_MAP) {
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
      return keyword;
    }
  }
  return null;
}

export function detectBrand(name: string, offBrand: string | null): string | null {
  const lower = name.toLowerCase();

  for (const { patterns, canonical } of BRAND_MAP) {
    if (patterns.some((p) => lower.includes(p.toLowerCase()))) {
      return canonical;
    }
  }

  if (offBrand) {
    const offLower = offBrand.toLowerCase().split(",")[0].trim();
    for (const { patterns, canonical } of BRAND_MAP) {
      if (patterns.some((p) => offLower.includes(p.toLowerCase()))) {
        return canonical;
      }
    }
    const firstBrand = offBrand.split(",")[0].trim();
    if (firstBrand) return toTitleCase(firstBrand);
  }

  // Fallback: first word of the name, capitalised
  const words = name.trim().split(/\s+/);
  if (words[0]) return toTitleCase(words[0]);

  return null;
}

export function detectVolume(
  name: string,
  offWeight: string | null,
  categoryHint?: string | null,
  outRejected?: { reason?: string },
): ParsedVolume | null {
  // Try the product name first — it is the most authoritative source for
  // package size. If the name had a value but it failed sanity for the
  // category context, do NOT silently fall back to OFF: the OFF "quantity"
  // field for the same product is usually identical, so we'd just re-reject
  // and lose the rejection reason that the caller wants to surface.
  const fromName = parseVolume(name, categoryHint, outRejected);
  if (fromName) return fromName;
  if (outRejected?.reason) return null;
  return offWeight ? parseVolume(offWeight, categoryHint, outRejected) : null;
}

// Returns "250 ml", "1500 ml", "500 g", etc. for the ctx.weight field on the frontend
export function formatVolumeForContext(vol: ParsedVolume): string {
  return `${vol.value} ${vol.unit}`;
}

export function cleanProductName(
  rawName: string,
  brand: string | null,
  vol: ParsedVolume | null
): string {
  let name = rawName.trim();

  // Strip e-shop branding so we don't end up with "Amazon — Snickers".
  // Was previously only applied to Google scrapes inside lookup.ts; now
  // every cleanup path benefits.
  STORE_NAMES_TO_REMOVE.lastIndex = 0;
  name = name.replace(STORE_NAMES_TO_REMOVE, " ").replace(/\s{2,}/g, " ").trim();

  // Title-case shouty strings (handles both ALL-CAPS and mixed-shouty
  // cases like "MILKA Mleczna Czekolada"). The previous all-upper-only
  // check left those untouched.
  name = smartTitleCaseIfShouty(name);

  // Remove duplicate brand mentions (keep first occurrence)
  if (brand) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    const matches = [...name.matchAll(regex)];
    if (matches.length > 1) {
      let replaced = 0;
      name = name.replace(regex, (m) => {
        replaced++;
        return replaced === 1 ? m : "";
      });
      name = name.replace(/\s{2,}/g, " ").trim();
    }
  }

  if (vol) {
    // Real volume detected — append it if not already present
    const hasVolInName = /\d+\s*(?:ml|l|g|kg|cl)/i.test(name);
    if (!hasVolInName) {
      const suffix =
        vol.unit === "ml"
          ? vol.value >= 1000
            ? `${(vol.value / 1000).toString().replace(".", ",")}l`
            : `${vol.value}ml`
          : vol.value >= 1000
          ? `${(vol.value / 1000).toString().replace(".", ",")}kg`
          : `${vol.value}g`;
      name = `${name} ${suffix}`;
    }
  } else {
    // No usable volume — strip any *trailing* weight-like token so a
    // sanity-rejected "3g" doesn't survive in the name. Only the trailing
    // position is touched so we don't damage names with mid-string numbers
    // like "Coca-Cola 0,5l Vanilla".
    name = name
      .replace(/\s+\d+(?:[.,]\d+)?\s*(?:g|ml|kg|l|cl|oz|sztuk?|szt)\.?\s*$/i, "")
      .trim();
  }

  return name.trim();
}

// ── Short Polish category descriptors for name padding ────────────────────────

const CATEGORY_DESCRIPTORS: Record<string, string> = {
  "Napoje energetyczne": "Napój Energetyczny",
  "Napoje gazowane": "Napój Gazowany",
  "Soki owocowe": "Sok Owocowy",
  "Soki": "Sok Owocowy",
  "Piwo": "Piwo",
  "Woda mineralna": "Woda Mineralna",
  "Woda": "Woda Mineralna",
  "Mleko": "Mleko",
  "Jogurty i kefiry": "Jogurt",
  "Czekolady": "Czekolada",
  "Cukierki i żelki": "Cukierki",
  "Chipsy i chrupki": "Chipsy",
  "Kawa": "Kawa",
  "Herbata": "Herbata",
  "Konserwy rybne": "Konserwa",
  "Makaron": "Makaron",
  "Sosy i przyprawy": "Sos",
  "Płatki śniadaniowe": "Płatki Śniadaniowe",
  "Batoniki": "Baton",
};

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function volumeSuffix(vol: ParsedVolume): string {
  if (vol.unit === "ml") {
    return vol.value >= 1000
      ? `${(vol.value / 1000).toString().replace(".", ",")}l`
      : `${vol.value}ml`;
  }
  return vol.value >= 1000
    ? `${(vol.value / 1000).toString().replace(".", ",")}kg`
    : `${vol.value}g`;
}

/**
 * Ensures the product name has at least 3 words before sending to Allegro.
 * Appends brand, category descriptor, or volume until the threshold is met.
 */
export function ensureMinWords(
  name: string,
  brand: string | null,
  categoryKeyword: string | null,
  vol: ParsedVolume | null,
  minWords = 3
): string {
  let result = name.trim();

  // 1. Append brand if not already present and helps word count
  if (countWords(result) < minWords && brand && !containsIgnoreCase(result, brand)) {
    result = `${result} ${brand}`.trim();
  }

  // 2. Append category descriptor if not already present
  if (countWords(result) < minWords && categoryKeyword) {
    const descriptor = CATEGORY_DESCRIPTORS[categoryKeyword];
    if (descriptor && !containsIgnoreCase(result, descriptor.split(" ")[0])) {
      result = `${result} ${descriptor}`.trim();
    }
  }

  // 3. Append volume/weight if not already present
  if (countWords(result) < minWords && vol) {
    const hasVol = /\d+\s*(?:ml|l|g|kg|cl)/i.test(result);
    if (!hasVol) {
      result = `${result} ${volumeSuffix(vol)}`.trim();
    }
  }

  return result;
}
