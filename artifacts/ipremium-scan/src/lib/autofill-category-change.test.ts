import { describe, it, expect } from "vitest";
import { buildAutoFilledState, type AllegroParam, type ProductContext } from "./autofill";
import { categoryFromScan } from "./category";
import marka from "./__fixtures__/marka-dictionary-subset.json";

// Real Allegro Marka dictionary (trimmed) — after a manual category change the
// form only has the new category's parameters, the server's suggestions are gone.
const MARKA: AllegroParam = {
  id: "248811", name: "Marka", type: "dictionary", required: true, requiredForProduct: true,
  unit: null, options: (marka as { options: Array<{ id: string; name: string }> }).options, restrictions: null,
};
const label = (id?: string) => MARKA.options.find((o) => o.id === id)?.name ?? null;
const afterCategoryChange = (productName: string, brandCandidates: string[]): ProductContext => ({
  ean: "8723400796831", productName, brandCandidates, catalogProduct: false,
});

describe("Marka after a manual category change (scan candidates kept)", () => {
  it("two brands named → empty + both offered (Mentos … Fanta)", () => {
    const st = buildAutoFilledState([MARKA], {}, afterCategoryChange("Mentos cukierki do żucia Fanta 160g", ["Mentos", "Fanta"]));
    expect(st.formState[MARKA.id]).toEqual({ id: MARKA.id });
    expect(st.brandSuggestions?.[MARKA.id]?.suggestions.map((s) => s.label)).toEqual(["Mentos", "Fanta"]);
  });

  it("one candidate → filled as on the scan", () => {
    const st = buildAutoFilledState([MARKA], {}, afterCategoryChange("Crazy Crunchies Stixx", ["Haribo"]));
    expect(label(st.formState[MARKA.id]?.valuesIds?.[0])).toBe("Haribo");
  });

  it("no candidate → the brand named in the title is offered (never filled)", () => {
    const st = buildAutoFilledState([MARKA], {}, afterCategoryChange("Cukierki w czekoladzie Casali z nadzieniem", []));
    expect(st.formState[MARKA.id]).toEqual({ id: MARKA.id });
    expect(st.brandSuggestions?.[MARKA.id]?.suggestions.map((s) => s.label)).toEqual(["Casali"]);
  });
});

describe("categoryFromScan — never the non-leaf Supermarket root", () => {
  // What the new resolver suggests for "Mads" (EAN 8723400872825, off-catalog; the old
  // logic put it in "Muzyka"): no preselection, 3 food leaves.
  const SWEETS = ["Supermarket", "Produkty spożywcze", "Słodycze, przekąski, desery"];
  const hints = [
    { id: "261479", name: "Lizaki", path: [...SWEETS, "Lizaki"] },
    { id: "74023", name: "Żelki, galaretki, pianki", path: [...SWEETS, "Żelki, galaretki, pianki"] },
    { id: "74018", name: "Cukierki i draże", path: [...SWEETS, "Cukierki i draże"] },
  ];
  it("no category → nothing chosen, suggestions kept for one tap", () => {
    expect(categoryFromScan({ categoryId: null, categoryName: null, categorySuggestions: hints })).toEqual({ categoryId: null, categoryName: "", hints });
  });
  it("a detected leaf is kept", () => {
    expect(categoryFromScan({ categoryId: "74023", categoryName: "Żelki, galaretki, pianki", categorySuggestions: [] })).toEqual({
      categoryId: "74023", categoryName: "Żelki, galaretki, pianki", hints: [],
    });
  });
});
