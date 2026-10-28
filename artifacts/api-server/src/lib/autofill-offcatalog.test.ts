/**
 * Off-catalog auto-fill on real data: product names from production logs, the
 * real OpenFoodFacts answers for those EANs (2026-10-28) and the real Allegro
 * Marka dictionary (trimmed; same results as the full 9 829 entries).
 */
import { describe, it, expect } from "vitest";
import { brandCandidates, detectBrand } from "./auto-detect";
import { fillCategoryParameters, type AllegroFillerParam } from "./parameter-filler";
import { matchDictionaryOption, normalizeForMatch, quantityForParam } from "./shared/autofill-rules";
import marka from "./__fixtures__/marka-dictionary-subset.json";
import brandCases from "./__fixtures__/offcatalog-brand-cases.json";

type Case = { ean: string; name: string; offBrands: string | null; allegroBrand: string; oldSent: string };

const MARKA: AllegroFillerParam = { id: marka.id, name: marka.name, type: marka.type, required: true, options: marka.options };
const label = (id: string | undefined) => marka.options.find((o) => o.id === id)?.name ?? null;

function fillBrand(c: Case) {
  const out = fillCategoryParameters([MARKA], {
    productName: c.name,
    brand: detectBrand(c.name, c.offBrands),
    brandCandidates: brandCandidates(c.name, [c.offBrands]),
    categoryKeyword: null,
    ean: c.ean,
    weight: null,
  });
  const skipped = out.skipped.find((s) => s.id === MARKA.id);
  return {
    value: label(out.filled.find((f) => f.id === MARKA.id)?.value),
    suggestions: (skipped?.suggestions ?? []).map((s) => s.label),
  };
}

// What the old first-word + substring match produced for these names.
const SUBSTRING_GUESSES = ["Cuki", "Okakao", "Alen", "Lion", "Bell", "SOS", "BATON", "Zdrowy Lizak", "Mara"];

// Filled only where a structured source or a whole-word BRAND_MAP hit decides it.
const EXPECTED_FILL: Record<string, string> = {
  "7613038185071": "Nescafe", // OFF "Nescafe" + name
  "8445291532236": "Nescafe", // name (was "Nestlé")
  "8445291739659": "Nescafe", // OFF "entkoffeinuert" is not a brand → only the name hit counts
  "671339054547": "Nescafe",
  "8000500267103": "Kinder", // OFF "Kinder"
  "8000500468753": "Kinder", // "Kalendarz adwentowy Kinder …" (was "Alen")
  "8410422111048": "Chovi", // OFF "Chovi"
  "8445291238701": "Nesquik", // whole-word BRAND_MAP hit (was "Okakao")
};

describe("Marka off-catalog — real names + real OpenFoodFacts data", () => {
  const cases = brandCases as Case[];

  it.each(cases)("$name → never a substring guess", (c) => {
    const { value } = fillBrand(c);
    expect(SUBSTRING_GUESSES).not.toContain(value);
  });

  it.each(cases)("$name → filled only when unambiguous", (c) => {
    expect(fillBrand(c).value).toBe(EXPECTED_FILL[c.ean] ?? null);
  });

  it("two brands named (Mentos … Fanta) → empty, both offered", () => {
    const c = cases.find((x) => x.ean === "8723400796831")!;
    expect(fillBrand(c)).toEqual({ value: null, suggestions: ["Mentos", "Fanta"] });
  });

  it("when the brand Allegro expects is named in the title, it is offered for one tap", () => {
    const named = cases.filter(
      (c) => !EXPECTED_FILL[c.ean] && normalizeForMatch(c.name).includes(normalizeForMatch(c.allegroBrand)),
    );
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const c of named) expect({ name: c.name, s: fillBrand(c).suggestions }).toEqual({ name: c.name, s: expect.arrayContaining([expect.stringMatching(new RegExp(`^${c.allegroBrand.replace(/[-']/g, ".")}$`, "i"))]) });
  });
});

describe("Kod producenta off-catalog — never the brand", () => {
  const KOD: AllegroFillerParam = { id: "224017", name: "Kod producenta", type: "string", required: false };
  it("gets the scanned EAN", () => {
    const out = fillCategoryParameters([MARKA, KOD], {
      productName: "Haribo Goldbären 200 g",
      brand: "Haribo",
      categoryKeyword: null,
      ean: "4001686301265",
      weight: "200 g",
    });
    expect(out.filled.find((f) => f.id === KOD.id)?.value).toBe("4001686301265");
  });
});

describe("Waga — from a mass only, in the parameter's unit", () => {
  // Real definitions: 221929 "Waga" (g), 17448 "Waga produktu z opakowaniem jednostkowym" (kg),
  // 226901 "Pojemność" (ml) — all from category 112619 (Chovi's).
  const WAGA_G: AllegroFillerParam = { id: "221929", name: "Waga", type: "float", required: true, unit: "g" };
  const WAGA_KG: AllegroFillerParam = { id: "17448", name: "Waga produktu z opakowaniem jednostkowym", type: "float", required: false, unit: "kg" };
  const fill = (weight: string) =>
    fillCategoryParameters([WAGA_G, WAGA_KG], { productName: "x", brand: null, categoryKeyword: null, ean: "1", weight }).filled;

  it("Chovi '180 ml' is a volume → Waga stays empty (was 180)", () => {
    expect(fill("180 ml")).toEqual([]);
  });

  it("grams are converted for a kg field", () => {
    expect(fill("137 g").map((f) => [f.id, f.value])).toEqual([["221929", "137"], ["17448", "0.137"]]);
    expect(fill("1500 g").map((f) => f.value)).toEqual(["1500", "1.5"]);
  });
});

describe("shared rules", () => {
  it("normalizeForMatch folds case, diacritics, &, apostrophes and punctuation", () => {
    expect(normalizeForMatch("M&M's")).toBe(normalizeForMatch("m and ms"));
    expect(normalizeForMatch("Nestlé")).toBe("nestle");
    expect(normalizeForMatch("Dr. Oetker")).toBe("dr oetker");
    expect(normalizeForMatch("Coca-Cola")).toBe("coca cola");
    expect(normalizeForMatch("Łowicz")).toBe("lowicz");
  });

  it("matchDictionaryOption: whole values or a leading brand, never substrings", () => {
    const opts = [{ id: "a", name: "Cuki" }, { id: "b", name: "Haribo" }, { id: "c", name: "Okakao" }, { id: "d", name: "Kinder" }, { id: "e", name: "Kinder Bueno" }];
    expect(matchDictionaryOption(opts, "Cukierki")).toBeNull();
    expect(matchDictionaryOption(opts, "Kakao")).toBeNull();
    expect(matchDictionaryOption(opts, "HARIBO")).toEqual({ id: "b", label: "Haribo", exact: true });
    expect(matchDictionaryOption(opts, "Haribo GmbH")).toEqual({ id: "b", label: "Haribo", exact: false });
    expect(matchDictionaryOption(opts, "Kinder Bueno White")?.label).toBe("Kinder Bueno");
  });

  it("quantityForParam converts mass to the param unit and never crosses mass/volume", () => {
    expect(quantityForParam("137 g", { name: "Waga", unit: "kg" })).toBe("0.137");
    expect(quantityForParam("0,5 kg", { name: "Waga", unit: "g" })).toBe("500");
    expect(quantityForParam("137,6 g", { name: "Waga", unit: "g", type: "integer" })).toBe("138");
    expect(quantityForParam("180 ml", { name: "Waga", unit: "g" })).toBeNull();
    expect(quantityForParam("0,33 l", { name: "Pojemność", unit: "ml" })).toBe("330");
    expect(quantityForParam("300 g", { name: "Pojemność", unit: "ml" })).toBeNull();
    expect(quantityForParam("200 g", { name: "Waga" })).toBe("200"); // no unit → grams by name
    expect(quantityForParam("200 g", { name: "Tłuszcz", unit: null })).toBeNull();
  });
});
