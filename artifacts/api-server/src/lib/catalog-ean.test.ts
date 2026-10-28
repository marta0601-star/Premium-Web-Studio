import { describe, it, expect } from "vitest";
import { normalizeGtin, pickCatalogProductByEan } from "./catalog-ean";
import search from "./__fixtures__/catalog-search-3770028156375.json";

// Real GET /sale/products?phrase=3770028156375 (2026-10-28): one product whose
// "EAN (GTIN)" parameter (225693) carries the scanned code.
type Product = { id: string; name: string; parameters: Array<{ id: string; name: string; values?: string[] | null }> };
const rebelle = (search as { products: Product[] }).products[0];
const SCANNED = "3770028156375";

const withEans = (p: Product, eans: string[] | null, id = p.id): Product => ({
  ...p,
  id,
  parameters: eans === null
    ? p.parameters.filter((x) => x.id !== "225693")
    : p.parameters.map((x) => (x.id === "225693" ? { ...x, values: eans } : x)),
});

describe("normalizeGtin", () => {
  it("treats EAN-13 with a leading zero, UPC-A and GTIN-14 as the same code", () => {
    expect(normalizeGtin("0012345678905")).toBe("12345678905");
    expect(normalizeGtin("012345678905")).toBe("12345678905");
    expect(normalizeGtin("00012345678905")).toBe("12345678905");
    expect(normalizeGtin(" 3770028156375 ")).toBe("3770028156375");
    expect(normalizeGtin("")).toBeNull();
    expect(normalizeGtin("0000")).toBeNull();
  });
});

describe("pickCatalogProductByEan", () => {
  it("uses the catalog product that carries the scanned EAN (real search result)", () => {
    const r = pickCatalogProductByEan([rebelle], SCANNED);
    expect(r.decision).toBe("ean_match");
    expect(r.product?.id).toBe(rebelle.id);
  });

  it("matches across EAN-13 / UPC-A leading zeros", () => {
    const p = withEans(rebelle, ["0012345678905"]);
    expect(pickCatalogProductByEan([p], "012345678905").decision).toBe("ean_match");
  });

  it("skips earlier hits with another EAN and takes the first one carrying ours", () => {
    const other = withEans(rebelle, ["4000000000006"], "other");
    const noEan = withEans(rebelle, null, "no-ean");
    const r = pickCatalogProductByEan([other, noEan, rebelle], SCANNED);
    expect(r.decision).toBe("ean_match");
    expect(r.product?.id).toBe(rebelle.id);
  });

  it("refuses the catalog when every hit carries a DIFFERENT EAN (CHAOKOH case)", () => {
    const r = pickCatalogProductByEan([withEans(rebelle, ["4000000000006"])], SCANNED);
    expect(r.decision).toBe("ean_mismatch");
    expect(r.product).toBeNull();
    expect(r.catalogEans).toEqual(["4000000000006"]);
  });

  it("uses a hit without any EAN but flags it for checking", () => {
    const r = pickCatalogProductByEan([withEans(rebelle, ["4000000000006"], "other"), withEans(rebelle, null, "no-ean")], SCANNED);
    expect(r.decision).toBe("ean_missing");
    expect(r.product?.id).toBe("no-ean");
  });

  it("reports an empty search as no_products", () => {
    expect(pickCatalogProductByEan([], SCANNED)).toMatchObject({ product: null, decision: "no_products" });
  });
});
