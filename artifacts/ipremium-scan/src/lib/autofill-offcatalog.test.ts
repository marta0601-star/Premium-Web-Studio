import { describe, it, expect } from "vitest";
import { autoFillParam, buildAutoFilledState, fuzzyMatchOption, type AllegroParam, type ProductContext } from "./autofill";
import marka from "./__fixtures__/marka-dictionary-subset.json";

// Real Allegro definitions (GET /sale/categories/{id}/parameters, 2026-10-28).
const MARKA: AllegroParam = {
  id: "248811", name: "Marka", type: "dictionary", required: true, requiredForProduct: true,
  unit: null, options: (marka as { options: Array<{ id: string; name: string }> }).options, restrictions: null,
};
const KOD_PRODUCENTA: AllegroParam = {
  id: "224017", name: "Kod producenta", type: "string", required: false, requiredForProduct: false,
  unit: null, options: [], restrictions: { minLength: 1, maxLength: 45 },
};
const EAN: AllegroParam = {
  id: "225693", name: "EAN (GTIN)", type: "string", required: true, requiredForProduct: true,
  unit: null, options: [], restrictions: { minLength: 8, maxLength: 14 },
};
const numeric = (id: string, name: string, type: string, unit: string): AllegroParam => ({
  id, name, type, required: false, requiredForProduct: false, unit, options: [], restrictions: { min: 0, precision: 3 },
});
const WAGA_KG = numeric("17448", "Waga produktu z opakowaniem jednostkowym", "float", "kg");
const WAGA_G = numeric("221929", "Waga", "float", "g");
const WAGA_G_INT = numeric("230801", "Waga", "integer", "g");
const POJEMNOSC_ML = numeric("226901", "Pojemność", "float", "ml");

const label = (id: string | null) => MARKA.options.find((o) => o.id === id)?.name ?? null;
const offCatalog = (over: Partial<ProductContext>): ProductContext => ({ ean: "4001686301265", catalogProduct: false, ...over });

describe("Marka off-catalog — no substring guesses", () => {
  // First words of real product names from the logs; the old match turned them
  // into Cuki / Okakao / Alen / Lion / SOS / Bell / BATON / Zdrowy Lizak / Mara.
  it.each(["Cukierki", "Kakao", "Kalendarz", "Bulion", "Rebelle", "Lizak", "Pomarańcza", "Ciasteczka"])(
    "%s does not match any brand",
    (word) => {
      expect(label(fuzzyMatchOption(MARKA.options, word))).toBeNull();
    },
  );

  it("matches whole values regardless of case, diacritics, &/and, apostrophes, dots and hyphens", () => {
    expect(label(fuzzyMatchOption(MARKA.options, "HARIBO"))).toBe("Haribo");
    expect(label(fuzzyMatchOption(MARKA.options, "M & M's"))).toBe("M&M's");
    expect(label(fuzzyMatchOption(MARKA.options, "M and Ms"))).toBe("M&M's");
    expect(label(fuzzyMatchOption(MARKA.options, "Lays"))).toBe("Lay's");
    expect(label(fuzzyMatchOption(MARKA.options, "Dr Oetker"))).toBe("Dr. Oetker");
    expect(label(fuzzyMatchOption(MARKA.options, "Coca Cola"))).toBe("Coca-Cola");
    expect(label(fuzzyMatchOption(MARKA.options, "Nestle"))).toBe("Nestlé");
  });

  it("accepts a brand followed by more words (a company suffix), never the reverse", () => {
    expect(label(fuzzyMatchOption(MARKA.options, "Haribo GmbH & Co. KG"))).toBe("Haribo");
    expect(label(fuzzyMatchOption(MARKA.options, "Sos Allioli Chovi"))).toBeNull(); // "SOS" is 3 chars
    expect(label(fuzzyMatchOption(MARKA.options, "Herbata owocowa"))).toBeNull();
  });

  it("an off-catalog form keeps Marka empty instead of a wrong brand", () => {
    const state = buildAutoFilledState([MARKA], {}, offCatalog({ brand: "Kakao" }));
    expect(state.formState[MARKA.id]).toEqual({ id: MARKA.id });
  });
});

describe("Kod producenta off-catalog — never the brand", () => {
  it("gets the EAN, not the brand, in the form", () => {
    const state = buildAutoFilledState([MARKA, KOD_PRODUCENTA, EAN], {}, offCatalog({ brand: "Haribo" }));
    expect(label(state.formState[MARKA.id]?.valuesIds?.[0] ?? null)).toBe("Haribo");
    expect(state.formState[KOD_PRODUCENTA.id]).toEqual({ id: KOD_PRODUCENTA.id, values: ["4001686301265"] });
  });

  it("the client fallback fills Kod producenta with the EAN", () => {
    expect(autoFillParam(KOD_PRODUCENTA, offCatalog({ brand: "Haribo" })).value).toEqual({
      id: KOD_PRODUCENTA.id,
      values: ["4001686301265"],
    });
  });
});

describe("Waga — converted to the parameter's unit, never from a volume", () => {
  const fill = (p: AllegroParam, weight: string) => autoFillParam(p, offCatalog({ weight })).value?.values?.[0] ?? null;

  it("grams into a kg field are converted (137 g → 0.137 kg)", () => {
    expect(fill(WAGA_KG, "137 g")).toBe("0.137");
    expect(fill(WAGA_KG, "1,5 kg")).toBe("1.5");
    expect(fill(WAGA_G, "137 g")).toBe("137");
    expect(fill(WAGA_G, "0,25 kg")).toBe("250");
    expect(fill(WAGA_G_INT, "137,6 g")).toBe("138");
  });

  it("a volume never becomes a weight (180 ml → empty)", () => {
    expect(fill(WAGA_G, "180 ml")).toBeNull();
    expect(fill(WAGA_KG, "0,5 l")).toBeNull();
  });

  it("volume fields take volumes only, in their unit", () => {
    expect(fill(POJEMNOSC_ML, "0,5 l")).toBe("500");
    expect(fill(POJEMNOSC_ML, "180 ml")).toBe("180");
    expect(fill(POJEMNOSC_ML, "300 g")).toBeNull();
  });
});
