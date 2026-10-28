/**
 * lookupEan's allegro_search source over real HTTP. Every outgoing request
 * (OpenFoodFacts, UPCitemDB, Ceneo, Google, …) is redirected to a local server:
 * api.allegro.pl/sale/products answers with a REAL catalog search response
 * (GET /sale/products?phrase=3770028156375, 2026-10-28), everything else 404s.
 * Nothing here reaches the internet.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import axios from "axios";
import search from "./__fixtures__/catalog-search-3770028156375.json";

const CARRIED_EAN = "3770028156375"; // the EAN the real catalog product carries
let server: http.Server;
let lookupEan: (typeof import("./lookup"))["lookupEan"];
const seen: string[] = [];

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipremium-lookup-test-"));
  const tokenFile = path.join(dir, "tokens.json");
  const now = Date.now();
  fs.writeFileSync(tokenFile, JSON.stringify({ accessToken: "t", refreshToken: "r", issuedAt: now, expiresAt: now + 12 * 3600_000, scopes: [] }));
  vi.stubEnv("TOKEN_STORE_PATH", tokenFile);
  vi.stubEnv("LOG_LEVEL", "silent");

  server = http.createServer((req, res) => {
    const original = new URL(decodeURIComponent((req.url ?? "").replace(/^\/proxy\//, "")));
    seen.push(original.host);
    if (original.host === "api.allegro.pl" && original.pathname === "/sale/products") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(search));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy/`;
  axios.interceptors.request.use((config) => {
    config.url = base + encodeURIComponent(config.url ?? "");
    return config;
  });
  ({ lookupEan } = await import("./lookup"));
}, 30_000);

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
});

describe("lookupEan — allegro_search source", () => {
  it("ignores a catalog hit that carries a DIFFERENT EAN (CHAOKOH case)", async () => {
    const r = await lookupEan("4000000000006");
    expect(seen).toContain("api.allegro.pl");
    expect(r.found).toBe(false);
    expect(r.name ?? null).toBeNull();
  }, 30_000);

  it("uses a hit carrying the scanned EAN and reads the brand from valuesLabels", async () => {
    const r = await lookupEan(CARRIED_EAN);
    expect(r.found).toBe(true);
    expect(r.source).toBe("allegro_search");
    expect(r.name).toBe(search.products[0].name);
    // Marka comes as { values: null, valuesLabels: ["bez marki"] } in the real response.
    expect(r.brand).toBe("bez marki");
    expect(r.brandSources).toEqual([{ value: "bez marki", source: "allegro_search" }]);
  }, 30_000);
});
