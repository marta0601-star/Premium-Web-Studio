import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";
import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";
import {
  ALLEGRO_APPLICATION_NAME,
  ALLEGRO_USER_AGENT,
  APP_VERSION,
  isAllegroRequest,
  stampAllegroUserAgent,
} from "./allegro-config";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

function makeConfig(url: string): InternalAxiosRequestConfig {
  return { url, headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
}

describe("ALLEGRO_USER_AGENT", () => {
  it("starts with the iPremium-scan/<version> prefix", () => {
    expect(ALLEGRO_USER_AGENT.startsWith("iPremium-scan/")).toBe(true);
  });

  it("includes the app version", () => {
    expect(ALLEGRO_USER_AGENT).toContain(APP_VERSION);
    expect(ALLEGRO_USER_AGENT).toContain(`iPremium-scan/${APP_VERSION}`);
  });

  it("includes the documentation URL", () => {
    expect(ALLEGRO_USER_AGENT).toContain(
      "(+https://premium.mojaapka.eu/o-aplikacji)",
    );
  });

  it("uses the exact registered ApplicationName (case-sensitive, no space)", () => {
    expect(ALLEGRO_APPLICATION_NAME).toBe("iPremium-scan");
    expect(ALLEGRO_APPLICATION_NAME).not.toBe("iPremium scan");
    expect(ALLEGRO_APPLICATION_NAME).not.toBe("ipremium-scan");
  });

  it("matches the full expected format", () => {
    expect(ALLEGRO_USER_AGENT).toBe(
      `iPremium-scan/${APP_VERSION} (+https://premium.mojaapka.eu/o-aplikacji)`,
    );
  });

  it("keeps APP_VERSION in sync with package.json", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(pkg.version).not.toBe("0.0.0");
  });
});

describe("isAllegroRequest", () => {
  it("matches the REST API host", () => {
    expect(isAllegroRequest("https://api.allegro.pl/sale/categories/1")).toBe(
      true,
    );
  });
  it("matches the OAuth/auth host", () => {
    expect(isAllegroRequest("https://allegro.pl/auth/oauth/token")).toBe(true);
    expect(isAllegroRequest("https://allegro.pl/auth/oauth/device")).toBe(true);
  });
  it("does not match unrelated hosts", () => {
    expect(isAllegroRequest("https://world.openfoodfacts.org/api/v2/x")).toBe(
      false,
    );
    expect(isAllegroRequest(undefined)).toBe(false);
  });
});

describe("stampAllegroUserAgent", () => {
  it("stamps the User-Agent on REST API requests", () => {
    const cfg = stampAllegroUserAgent(
      makeConfig("https://api.allegro.pl/sale/categories/1"),
    );
    expect((cfg.headers as AxiosHeaders).get("User-Agent")).toBe(
      ALLEGRO_USER_AGENT,
    );
  });

  it("stamps the User-Agent on OAuth token requests (code→token and refresh)", () => {
    const cfg = stampAllegroUserAgent(
      makeConfig("https://allegro.pl/auth/oauth/token"),
    );
    expect((cfg.headers as AxiosHeaders).get("User-Agent")).toBe(
      ALLEGRO_USER_AGENT,
    );
  });

  it("stamps the User-Agent on device-flow requests", () => {
    const cfg = stampAllegroUserAgent(
      makeConfig("https://allegro.pl/auth/oauth/device"),
    );
    expect((cfg.headers as AxiosHeaders).get("User-Agent")).toBe(
      ALLEGRO_USER_AGENT,
    );
  });

  it("resolves baseURL + url before matching", () => {
    const cfg = {
      baseURL: "https://api.allegro.pl",
      url: "/sale/products",
      headers: new AxiosHeaders(),
    } as InternalAxiosRequestConfig;
    stampAllegroUserAgent(cfg);
    expect((cfg.headers as AxiosHeaders).get("User-Agent")).toBe(
      ALLEGRO_USER_AGENT,
    );
  });

  it("leaves non-Allegro requests untouched", () => {
    const cfg = stampAllegroUserAgent(
      makeConfig("https://world.openfoodfacts.org/api/v2/product/x"),
    );
    expect((cfg.headers as AxiosHeaders).get("User-Agent")).toBeUndefined();
  });
});

// WIRE PROOF: the previous version of these tests used a mock adapter that just
// echoed `config` back, so it only proved the interceptor SET the header on the
// config object — NOT that the header survives axios's real HTTP adapter and
// leaves the process. That gap let a "green" suite coexist with a panel that saw
// no User-Agent. These tests exercise the real `http` adapter against a local
// capture server and assert the User-Agent the server ACTUALLY received on the
// wire. The `allegro.pl` marker in the query makes isAllegroRequest() match (the
// real code path) while the request physically hits 127.0.0.1.
describe("global axios interceptor — real wire (installed by setupAllegroAxiosInterceptor)", () => {
  let server: http.Server;
  let port: number;
  let prevAdapter: unknown;
  const received: Array<{ ua?: string; url?: string }> = [];

  beforeAll(async () => {
    const { setupAllegroAxiosInterceptor } = await import("./allegro-auth");
    setupAllegroAxiosInterceptor();
    // Force the genuine HTTP adapter (some suites swap in a mock adapter).
    prevAdapter = axios.defaults.adapter;
    axios.defaults.adapter = "http";

    server = http.createServer((req, res) => {
      received.push({ ua: req.headers["user-agent"], url: req.url });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    axios.defaults.adapter = prevAdapter as typeof axios.defaults.adapter;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("puts the Allegro User-Agent on the wire for an Allegro REST-shaped GET", async () => {
    await axios.get(`http://127.0.0.1:${port}/sale/categories/1?probe=api.allegro.pl`, {
      headers: { Authorization: "Bearer test" },
    });
    expect(received.at(-1)?.ua).toBe(ALLEGRO_USER_AGENT);
  });

  it("puts the Allegro User-Agent on the wire for an OAuth token POST", async () => {
    await axios.post(
      `http://127.0.0.1:${port}/auth/oauth/token?host=allegro.pl`,
      "grant_type=client_credentials",
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    expect(received.at(-1)?.ua).toBe(ALLEGRO_USER_AGENT);
  });

  it("leaves the default UA on the wire for non-Allegro requests", async () => {
    await axios.get(`http://127.0.0.1:${port}/openfoodfacts`);
    const ua = received.at(-1)?.ua;
    expect(ua).toMatch(/^axios\//); // axios's own default, not ours
    expect(ua).not.toBe(ALLEGRO_USER_AGENT);
  });
});
