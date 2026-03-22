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

// ── Volume / weight parser ────────────────────────────────────────────────────

export function parseVolume(text: string): ParsedVolume | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();

  // "0,5 l" or "0.5l" or "1,5L" (fractional litres → ml)
  const fracL = t.match(/\b(0[.,]\d+)\s*[Ll]\b/i);
  if (fracL) {
    const ml = Math.round(parseFloat(fracL[1].replace(",", ".")) * 1000);
    return { value: ml, unit: "ml" };
  }

  // "500 ml", "330ML"
  const mlMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Mm][Ll]\b/i);
  if (mlMatch) {
    return { value: Math.round(parseFloat(mlMatch[1].replace(",", "."))) , unit: "ml" };
  }

  // "25 cl", "33cl"
  const clMatch = t.match(/\b(\d+)\s*[Cc][Ll]\b/i);
  if (clMatch) {
    return { value: parseInt(clMatch[1]) * 10, unit: "ml" };
  }

  // "1 L", "2L" (whole litres)
  const lMatch = t.match(/\b(\d+)\s*[Ll]\b/i);
  if (lMatch) {
    return { value: parseInt(lMatch[1]) * 1000, unit: "ml" };
  }

  // "1,5 kg", "1.5kg"
  const kgMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Kk][Gg]\b/i);
  if (kgMatch) {
    return { value: Math.round(parseFloat(kgMatch[1].replace(",", ".")) * 1000), unit: "g" };
  }

  // "500 g", "200g"
  const gMatch = t.match(/\b(\d+(?:[.,]\d+)?)\s*[Gg]\b/i);
  if (gMatch) {
    return { value: Math.round(parseFloat(gMatch[1].replace(",", "."))) , unit: "g" };
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

export function detectVolume(name: string, offWeight: string | null): ParsedVolume | null {
  return parseVolume(name) || (offWeight ? parseVolume(offWeight) : null);
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

  // Title-case if entirely upper-case
  if (name === name.toUpperCase() && name.length > 3) {
    name = toTitleCase(name);
  }

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

  // Append volume if not already in name
  if (vol) {
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
  }

  return name.trim();
}
