/**
 * Auto-fill matching rules shared by the server filler (lib/parameter-filler.ts)
 * and the offer form (artifacts/ipremium-scan/src/lib/autofill.ts), so both sides
 * decide the same way. Keep this file dependency-free: the frontend imports it
 * by relative path.
 *
 * Principle: an empty field the user has to check beats a wrong value.
 */

/** Lowercase, no diacritics, "&" = "and", no apostrophes, punctuation → spaces. */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/['’‘`´]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface DictOption {
  id: string;
  name: string;
}

/**
 * Match a value (e.g. a brand from a data source) to a dictionary option.
 * Only whole values / whole words count — never a substring ("Kakao" must not
 * become "Okakao", "Cukierki" must not become "Cuki"):
 *   1. exact normalized equality                        → exact
 *   2. the option is the LEADING whole words of the value
 *      ("Haribo GmbH" → "Haribo"), option ≥ 4 chars, longest
 *      such option, and it must be unique               → not exact
 */
export function matchDictionaryOption(
  options: DictOption[],
  value: string | null | undefined,
): { id: string; label: string; exact: boolean } | null {
  if (!value || options.length === 0) return null;
  const v = normalizeForMatch(value);
  if (!v) return null;

  for (const o of options) {
    if (normalizeForMatch(o.name) === v) return { id: o.id, label: o.name, exact: true };
  }

  let best: DictOption[] = [];
  let bestLen = 0;
  for (const o of options) {
    const n = normalizeForMatch(o.name);
    if (n.length < 4 || !v.startsWith(n + " ")) continue;
    if (n.length > bestLen) {
      best = [o];
      bestLen = n.length;
    } else if (n.length === bestLen) {
      best.push(o);
    }
  }
  if (best.length === 1) return { id: best[0].id, label: best[0].name, exact: false };
  return null;
}

// ── Weight / volume ──────────────────────────────────────────────────────────

export interface ParsedQuantity {
  /** grams for mass, millilitres for volume */
  value: number;
  unit: "g" | "ml";
}

/** First "<number> <kg|g|ml|cl|l>" in the text, normalised to g or ml. */
export function parseQuantity(text: string | null | undefined): ParsedQuantity | null {
  if (!text) return null;
  const m = text.replace(/\s+/g, " ").match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|l)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2].toLowerCase()) {
    case "kg": return { value: n * 1000, unit: "g" };
    case "g": return { value: n, unit: "g" };
    case "l": return { value: n * 1000, unit: "ml" };
    case "cl": return { value: n * 10, unit: "ml" };
    default: return { value: n, unit: "ml" };
  }
}

const MASS_NAME_RE = /\b(waga|masa|gramatura|weight|netto)\b/i;
const VOLUME_NAME_RE = /\b(pojemno\S*|obj[eę]to\S*|volume)\b/i;

/** What a numeric parameter measures, from its Allegro unit, else its name. */
export function quantityKind(param: { name: string; unit?: string | null }): "mass" | "volume" | null {
  const u = (param.unit ?? "").trim().toLowerCase();
  if (u === "g" || u === "kg" || u === "mg") return "mass";
  if (u === "ml" || u === "l" || u === "cl") return "volume";
  if (u) return null;
  if (MASS_NAME_RE.test(param.name)) return "mass";
  if (VOLUME_NAME_RE.test(param.name)) return "volume";
  return null;
}


/**
 * Value for a numeric weight/volume parameter, converted to ITS unit
 * ("137 g" → "0.137" for a kg field). Mass only from g/kg, volume only from
 * ml/cl/l — never across ("180 ml" does not become a weight).
 */
export function quantityForParam(
  text: string | null | undefined,
  param: { name: string; unit?: string | null; type?: string },
): string | null {
  const fmt = (n: number): string | null => {
    const v = param.type === "integer" ? Math.round(n) : +n.toFixed(3);
    return v > 0 ? String(v) : null;
  };
  const q = parseQuantity(text);
  const kind = quantityKind(param);
  if (!q || !kind) return null;
  const u = (param.unit ?? "").trim().toLowerCase();
  if (kind === "mass") {
    if (q.unit !== "g") return null;
    if (u === "kg") return fmt(q.value / 1000);
    if (u === "mg") return fmt(q.value * 1000);
    return fmt(q.value);
  }
  if (q.unit !== "ml") return null;
  if (u === "l") return fmt(q.value / 1000);
  if (u === "cl") return fmt(q.value / 10);
  return fmt(q.value);
}

// ── Brand (Marka) decision ───────────────────────────────────────────────────

/**
 * Dictionary options named as WHOLE words in the product name ("… Casali z
 * nadzieniem" → Casali), in order of appearance (longer first at the same spot).
 * Suggestions only — a name word is never auto-filled as the brand ("Sos" is
 * also the brand "SOS").
 */
export function optionsNamedIn(options: DictOption[], name: string): DictOption[] {
  const hay = ` ${normalizeForMatch(name)} `;
  return options
    .map((o) => ({ o, n: normalizeForMatch(o.name) }))
    .filter(({ n }) => n.length >= 4 && hay.includes(` ${n} `))
    .sort((a, b) => hay.indexOf(` ${a.n} `) - hay.indexOf(` ${b.n} `) || b.n.length - a.n.length)
    .map(({ o }) => o);
}

export interface BrandDecision {
  /** Set only when the candidates point at exactly ONE option. */
  fill: { id: string; label: string; exact: boolean } | null;
  reason: "ambiguous" | "unknown_value" | null;
  /** ≤ 3 one-tap options when not filled: candidates first, then names in the title. */
  suggestions: Array<{ id: string; label: string }>;
}

/** Brand value for a dictionary param from brand candidates (auto-detect.brandCandidates). */
export function decideBrandOption(
  options: DictOption[],
  candidates: string[],
  productName: string,
): BrandDecision {
  const picks: Array<{ id: string; label: string; exact: boolean }> = [];
  for (const c of candidates) {
    const m = matchDictionaryOption(options, c);
    if (m && !picks.some((x) => x.id === m.id)) picks.push(m);
  }
  if (picks.length === 1) return { fill: picks[0], reason: null, suggestions: [] };
  const suggestions = picks.map(({ id, label }) => ({ id, label }));
  for (const o of optionsNamedIn(options, productName)) {
    if (!suggestions.some((x) => x.id === o.id)) suggestions.push({ id: o.id, label: o.name });
  }
  return { fill: null, reason: picks.length > 1 ? "ambiguous" : "unknown_value", suggestions: suggestions.slice(0, 3) };
}
