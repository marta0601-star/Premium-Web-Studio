/**
 * Off-catalog category resolution on real data: per-signal votes measured on
 * products from the production logs (history leave-one-out, real catalog and
 * matching-categories answers), the real Supermarket tree snapshot, and — for
 * the live path — a local stand-in for api.allegro.pl serving the real answers.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import axios from "axios";
import cases from "./__fixtures__/category-signals-cases.json";
import live from "./__fixtures__/category-live-moutarde.json";
import tree from "./data/supermarket-tree.json";

type Case = { ean: string; name: string; truthCategoryId: string; oldRouteCategoryId: string | null; signals: Record<string, Record<string, number>> };
const allCases = cases.cases as unknown as Case[];
const byName = (prefix: string) => allCases.find((c) => c.name.startsWith(prefix))!;
const toMaps = (s: Case["signals"]) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, new Map(Object.entries(v))]));
const nodes = (tree as { nodes: Record<string, { name: string; leaf: boolean }> }).nodes;
const isFoodLeaf = (id: string | null) => !!id && nodes[id]?.leaf === true;

let tmp: string;
let mod: typeof import("./category-resolver");
let history: typeof import("./category-history");

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ipremium-category-test-"));
  vi.stubEnv("CATEGORY_HISTORY_PATH", path.join(tmp, "history.jsonl"));
  vi.stubEnv("LOG_LEVEL", "silent");
  mod = await import("./category-resolver");
  history = await import("./category-history");
});
afterAll(() => vi.unstubAllEnvs());

describe("decideCategory — real signals of off-catalog products", () => {
  it.each(allCases)("$name → only a food leaf, never e.g. 'Samochody' / 'Muzyka'", (c) => {
    const d = mod.decideCategory(toMaps(c.signals));
    if (d.categoryId) expect(isFoodLeaf(d.categoryId)).toBe(true);
    for (const id of d.ranked) expect(isFoodLeaf(id)).toBe(true);
  });

  it("Moutarde de Dijon: brand + product signals agree → preselected correctly (was 'Samochody')", () => {
    const c = byName("Moutarde de Dijon");
    const d = mod.decideCategory(toMaps(c.signals));
    expect(d).toMatchObject({ categoryId: c.truthCategoryId, confidence: "high", decision: "signals_agree" });
  });

  it("Capri-Sun Siroop: the drill landed in food and nothing contradicts it → kept", () => {
    const c = byName("Capri-Sun Siroop");
    expect(mod.decideCategory(toMaps(c.signals)).categoryId).toBe(c.truthCategoryId);
  });

  it.each(["Mads", "Black Travel", "Insta White"])("%s: no agreement → nothing preselected, the right one offered", (prefix) => {
    const c = byName(prefix);
    const d = mod.decideCategory(toMaps(c.signals));
    expect(d.categoryId).toBeNull();
    expect(d.ranked.slice(0, 3)).toContain(c.truthCategoryId);
  });

  it.each(["Mentos Gum", "Lay's Dipsaus Fantasia"])(
    "%s: two BRAND signals agreeing is not enough (most Mentos are candies, most Lay's are chips)",
    (prefix) => {
      const c = byName(prefix);
      const d = mod.decideCategory(toMaps(c.signals));
      expect(d.categoryId).toBeNull();
      expect(d.ranked.slice(0, 3)).toContain(c.truthCategoryId);
    },
  );
});

describe("resolveOffCatalogCategory — live path over real HTTP", () => {
  let server: http.Server;
  let staleLeaf: string | null = null;

  beforeAll(async () => {
    const now = Date.now();
    fs.writeFileSync(path.join(tmp, "tokens.json"), JSON.stringify({ accessToken: "t", refreshToken: "r", issuedAt: now, expiresAt: now + 12 * 3600_000, scopes: [] }));
    vi.stubEnv("TOKEN_STORE_PATH", path.join(tmp, "tokens.json"));
    server = http.createServer((req, res) => {
      const u = new URL(decodeURIComponent((req.url ?? "").replace(/^\/proxy\//, "")));
      const send = (b: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (u.pathname === "/sale/products") return send((live.products as Record<string, unknown>)[u.searchParams.get("phrase") ?? ""] ?? { products: [] });
      if (u.pathname === "/sale/matching-categories") return send((live.matching as Record<string, unknown>)[u.searchParams.get("name") ?? ""] ?? { matchingCategories: [] });
      const m = u.pathname.match(/^\/sale\/categories\/(\d+)$/);
      if (m) return send({ id: m[1], name: nodes[m[1]]?.name, leaf: m[1] === staleLeaf ? false : nodes[m[1]]?.leaf ?? false });
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy/`;
    axios.interceptors.request.use((c) => { c.url = base + encodeURIComponent(c.url ?? ""); return c; });
  });
  afterAll(() => server?.close());

  it("Moutarde de Dijon resolves to the category of the later successful offer", async () => {
    const r = await mod.resolveOffCatalogCategory(live.input);
    expect(r.categoryId).toBe(live.truthCategoryId);
    expect(r.categoryPath.slice(0, 2)).toEqual(["Supermarket", "Produkty spożywcze"]);
    expect(live.oldRouteCategoryId).not.toBe(r.categoryId); // the old logic said "Samochody"
  });

  it("a category Allegro no longer reports as a leaf is never returned", async () => {
    staleLeaf = live.truthCategoryId;
    vi.resetModules(); // fresh live-leaf memo
    const fresh = await import("./category-resolver");
    const r = await fresh.resolveOffCatalogCategory(live.input);
    expect(r.categoryId).toBeNull();
    expect(r.suggestions.map((s) => s.id)).not.toContain(staleLeaf);
    staleLeaf = null;
  });
});

describe("category history", () => {
  it("a listing is remembered (and survives a restart) and preselects that EAN next time", async () => {
    history.recordCategoryUse({ ean: "8720182745118", brand: "Hellmann's", categoryId: "112619", tags: ["en:sauces"] });
    expect(history.historyVotes("8720182745118", [], []).exact).toBe("112619");
    vi.resetModules();
    const fresh = await import("./category-history");
    expect(fresh.historyVotes("08720182745118", [], []).exact).toBe("112619");
    const d = mod.decideCategory({ hist_ean: new Map([["112619", 1]]) });
    expect(d).toMatchObject({ categoryId: "112619", decision: "listed_before" });
  });

  it("the seed holds our successful offers from the logs", () => {
    const v = history.historyVotes("0000000000000", ["Haribo"], []);
    expect([...v.brand.values()].reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
    for (const id of v.brand.keys()) expect(isFoodLeaf(id)).toBe(true);
  });
});
