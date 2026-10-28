import { describe, it, expect } from "vitest";
import { buildAutoFilledState, numericInputStep, type AllegroParam, type ProductContext } from "./autofill";
import colaCaoScan from "./__fixtures__/scan-8410014439857-colacao-kakao.json";

// Real GET /api/allegro/scan response (2026-10-28) for an EAN whose offer
// failed with PARAMETER_MISMATCH: the catalog says Marka = "Cola Cao", the
// name-derived brand is "Kakao", which the old fuzzy match turned into "Okakao".
const scan = colaCaoScan as unknown as {
  productId: string;
  brand: string;
  weight: string | null;
  productName: string;
  ean: string;
  parameters: AllegroParam[];
  prefillValues: Record<string, string[]>;
  filledParameters: Parameters<typeof buildAutoFilledState>[3];
};

const MARKA = "248811";
const KOD_PRODUCENTA = "224017";
const COLA_CAO = "248811_1958518";

function catalogCtx(): ProductContext {
  return {
    ean: scan.ean,
    brand: scan.brand,
    weight: scan.weight,
    productName: scan.productName,
    country: "Hiszpania",
    catalogProduct: true,
  };
}

function catalogValueOf(id: string): string[] {
  return scan.prefillValues[id];
}

function formValueOf(state: ReturnType<typeof buildAutoFilledState>, id: string): string[] | undefined {
  return state.formState[id]?.valuesIds ?? state.formState[id]?.values;
}

describe("buildAutoFilledState — product from the Allegro catalog", () => {
  it("keeps the catalog Marka instead of the brand guessed from the name", () => {
    expect(scan.brand).toBe("Kakao"); // what detectBrand made of "Kakao Cola Cao 300 g"
    const state = buildAutoFilledState(scan.parameters, scan.prefillValues, catalogCtx(), scan.filledParameters);
    expect(state.formState[MARKA]).toEqual({ id: MARKA, valuesIds: [COLA_CAO] });
    expect(state.paramMeta[MARKA]?.source).toBe("allegro_catalog");
  });

  it("keeps every catalog-filled value (Marka, Waga, Kod producenta, …)", () => {
    const state = buildAutoFilledState(scan.parameters, scan.prefillValues, catalogCtx(), scan.filledParameters);
    const catalogIds = Object.keys(scan.prefillValues);
    expect(catalogIds).toEqual(expect.arrayContaining([MARKA, KOD_PRODUCENTA, "230801", "17448"]));
    for (const id of catalogIds) {
      expect({ id, value: formValueOf(state, id) }).toEqual({ id, value: catalogValueOf(id) });
    }
  });

  it("keeps catalog values after a manual category change (no server fills passed)", () => {
    const state = buildAutoFilledState(scan.parameters, scan.prefillValues, catalogCtx());
    expect(formValueOf(state, MARKA)).toEqual([COLA_CAO]);
    expect(formValueOf(state, KOD_PRODUCENTA)).toEqual(catalogValueOf(KOD_PRODUCENTA));
  });
});

describe("buildAutoFilledState — product outside the catalog", () => {
  it("a detected brand still wins over prefill; Kod producenta gets the EAN, never the brand", () => {
    const OKAKAO = "248811_1962677";
    const ctx: ProductContext = { ...catalogCtx(), brand: "Cola Cao", catalogProduct: false };
    const prefill = { ...scan.prefillValues, [MARKA]: [OKAKAO] };
    const state = buildAutoFilledState(scan.parameters, prefill, ctx);
    expect(state.formState[MARKA]).toEqual({ id: MARKA, valuesIds: [COLA_CAO] });
    expect(state.paramMeta[MARKA]?.source).toBe("lookup");
    expect(state.formState[KOD_PRODUCENTA]?.values).not.toEqual(["Cola Cao"]);
  });
});

describe("numericInputStep", () => {
  const param = (type: string, restrictions: Record<string, unknown> | null): AllegroParam => ({
    id: "x",
    name: "x",
    type,
    required: false,
    requiredForProduct: false,
    unit: null,
    options: [],
    restrictions,
  });

  it("derives the step from Allegro's precision (Waga in kg has precision 3)", () => {
    // Real definition of 17448 "Waga produktu z opakowaniem jednostkowym" (kg).
    const waga = scan.parameters.find((p) => p.id === "17448")!;
    expect(waga.restrictions).toMatchObject({ precision: 3 });
    expect(numericInputStep(waga)).toBe("0.001");
    expect(numericInputStep(param("float", { precision: 2 }))).toBe("0.01");
    expect(numericInputStep(param("float", { precision: 0 }))).toBe("1");
  });

  it("falls back to step=any for floats without precision", () => {
    expect(numericInputStep(param("float", null))).toBe("any");
    expect(numericInputStep(param("float", { min: 0 }))).toBe("any");
  });

  it("uses step=1 for integers and nothing for non-numeric params", () => {
    expect(numericInputStep(param("integer", { min: 0, max: 40000 }))).toBe("1");
    expect(numericInputStep(param("string", null))).toBeUndefined();
    expect(numericInputStep(param("dictionary", null))).toBeUndefined();
  });
});
