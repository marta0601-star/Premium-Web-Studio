/**
 * createAllegroOffer against a local stand-in for api.allegro.pl over real HTTP.
 * Allegro's answers are the REAL bodies logged in production (PARAMETER_MISMATCH
 * for Cola Cao 2026-10-26 and Skittles 2026-08-14) and the real category
 * definitions; only the host is swapped, so the full request-building and retry
 * code runs unmodified. Nothing here talks to the real Allegro.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import axios from "axios";
import colaCao from "./__fixtures__/parameter-mismatch-colacao.json";
import skittles from "./__fixtures__/parameter-mismatch-skittles.json";
import cat74017 from "./__fixtures__/category-74017.json";
import cat74019 from "./__fixtures__/category-74019.json";

type Param = { id: string; values?: string[]; valuesIds?: string[] };
type Fixture = { request: unknown; response: unknown; httpStatus: number };
type OfferBody = {
  productSet: Array<{ product: { id: string; parameters: Param[] } }>;
  parameters?: Param[];
  [k: string]: unknown;
};

const categories: Record<string, { node: unknown; parameters: unknown[] }> = {
  "74017": cat74017,
  "74019": cat74019,
};

let server: http.Server;
let base = "";
let posts: OfferBody[] = [];
let offerReplies: Array<{ status: number; body: unknown }> = [];
let createAllegroOffer: (typeof import("./allegro"))["createAllegroOffer"];

function reply(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/vnd.allegro.public.v1+json" });
  res.end(JSON.stringify(body));
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipremium-offer-test-"));
  const tokenFile = path.join(dir, "tokens.json");
  const now = Date.now();
  fs.writeFileSync(
    tokenFile,
    JSON.stringify({ accessToken: "test-token", refreshToken: "r", issuedAt: now, expiresAt: now + 12 * 3600_000, scopes: [] }),
  );
  vi.stubEnv("TOKEN_STORE_PATH", tokenFile);
  vi.stubEnv("LOG_LEVEL", "silent");

  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/sale/product-offers") {
        posts.push(JSON.parse(raw) as OfferBody);
        const next = offerReplies.shift() ?? { status: 500, body: { errors: [{ code: "TEST_NO_REPLY" }] } };
        return reply(res, next.status, next.body);
      }
      if (url === "/sale/shipping-rates") return reply(res, 200, { shippingRates: [{ id: "rate-1", name: "DOSTAWA" }] });
      if (url === "/after-sales-service-conditions/return-policies")
        return reply(res, 200, { returnPolicies: [{ id: "rp-1", name: "ZWROT" }] });
      if (url === "/after-sales-service-conditions/implied-warranties")
        return reply(res, 200, { impliedWarranties: [{ id: "iw-1", name: "REKLAMACJA" }] });
      const params = url.match(/^\/sale\/categories\/(\d+)\/parameters$/);
      if (params && categories[params[1]]) return reply(res, 200, { parameters: categories[params[1]].parameters });
      const node = url.match(/^\/sale\/categories\/(\d+)$/);
      if (node && categories[node[1]]) return reply(res, 200, categories[node[1]].node);
      reply(res, 404, { errors: [{ code: "TEST_UNKNOWN_ROUTE", message: url }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  axios.interceptors.request.use((config) => {
    if (config.url?.startsWith("https://api.allegro.pl")) config.url = config.url.replace("https://api.allegro.pl", base);
    return config;
  });

  ({ createAllegroOffer } = await import("./allegro"));
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  posts = [];
  offerReplies = [];
});

/** Rebuild the createAllegroOffer payload from the request that was really sent. */
function payloadFrom(fx: Fixture) {
  const req = fx.request as unknown as OfferBody & { name: string; category: { id: string }; images: string[] };
  const productParams = req.productSet[0].product.parameters;
  return {
    productId: req.productSet[0].product.id,
    categoryId: req.category.id,
    productName: req.name,
    parameters: [...productParams, ...(req.parameters ?? [])],
    productParamIds: productParams.map((p) => p.id),
    imageUrl: req.images[0],
    ean: productParams.find((p) => p.id === "225693")?.values?.[0],
  };
}

function success(fx: Fixture) {
  const productId = (fx.request as unknown as OfferBody).productSet[0].product.id;
  return {
    status: 202,
    body: { id: "18999999999", publication: { status: "INACTIVE" }, productSet: [{ product: { id: productId, publication: { status: "LISTED" } } }] },
  };
}

const productParam = (body: OfferBody, id: string) => body.productSet[0].product.parameters.find((p) => p.id === id);

describe("createAllegroOffer — PARAMETER_MISMATCH rescue", () => {
  it("Cola Cao: replaces Marka with the catalog value and retries exactly once", async () => {
    offerReplies.push({ status: colaCao.httpStatus, body: colaCao.response }, success(colaCao));

    const result = await createAllegroOffer(payloadFrom(colaCao));

    expect(posts).toHaveLength(2);
    // The first request is what production really sent (same product split).
    expect(posts[0].productSet[0].product.parameters).toEqual(colaCao.request.productSet[0].product.parameters);
    expect(productParam(posts[0], "248811")).toEqual({ id: "248811", valuesIds: ["248811_1958440"] }); // Ciasteczka z Krakowa
    expect(productParam(posts[1], "248811")).toEqual({ id: "248811", valuesIds: ["248811_1958518"] }); // Cola Cao
    // Nothing but Marka changed between the two attempts.
    const strip = (b: OfferBody) => ({ ...b, productSet: [{ product: { ...b.productSet[0].product, parameters: b.productSet[0].product.parameters.filter((p) => p.id !== "248811") } }] });
    expect(strip(posts[1])).toEqual(strip(posts[0]));

    expect(result.offer).toMatchObject({ id: "18999999999" });
    expect(result.catalogCorrections).toEqual([
      expect.objectContaining({ parameterId: "248811", parameterName: "Marka", from: "Ciasteczka z Krakowa", to: "Cola Cao" }),
    ]);
    expect(result.catalogCorrections[0].message).toBe(
      "Marka: zmieniono „Ciasteczka z Krakowa” na „Cola Cao” zgodnie z katalogiem Allegro",
    );
  });

  it("Skittles: fixes Marka (dictionary → valuesIds) AND Waga (numeric → values) in one retry", async () => {
    offerReplies.push({ status: skittles.httpStatus, body: skittles.response }, success(skittles));

    const result = await createAllegroOffer(payloadFrom(skittles));

    expect(posts).toHaveLength(2);
    expect(productParam(posts[0], "248811")).toEqual({ id: "248811", valuesIds: ["248811_1960342"] }); // Hellena
    expect(productParam(posts[1], "248811")).toEqual({ id: "248811", valuesIds: ["248811_1964134"] }); // Skittles
    expect(productParam(posts[1], "221929")).toEqual({ id: "221929", values: ["0.137"] });
    expect(result.catalogCorrections.map((c) => c.parameterName)).toEqual(["Marka", "Waga"]);
  });

  it("never loops: a second PARAMETER_MISMATCH is returned to the user after 2 POSTs", async () => {
    offerReplies.push(
      { status: colaCao.httpStatus, body: colaCao.response },
      { status: colaCao.httpStatus, body: colaCao.response },
      { status: colaCao.httpStatus, body: colaCao.response },
    );

    const err = await createAllegroOffer(payloadFrom(colaCao)).then(
      () => null,
      (e: { response?: { status?: number; data?: { errors?: Array<{ code?: string }> } } }) => e,
    );

    expect(posts).toHaveLength(2);
    expect(err?.response?.status).toBe(422);
    expect(err?.response?.data?.errors?.[0]?.code).toBe("PARAMETER_MISMATCH");
  });
});
