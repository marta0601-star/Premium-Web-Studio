import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
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

// End-to-end: prove the installed global request interceptor actually sends the
// header on a real axios call (no network — captured by a mock adapter).
describe("global axios interceptor (installed by setupAllegroAxiosInterceptor)", () => {
  beforeAll(async () => {
    const { setupAllegroAxiosInterceptor } = await import("./allegro-auth");
    setupAllegroAxiosInterceptor();
    axios.defaults.adapter = async (config) => ({
      data: {},
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });
  });

  it("sends User-Agent on an Allegro REST API GET", async () => {
    const res = await axios.get("https://api.allegro.pl/sale/categories/1");
    expect(
      (res.config.headers as AxiosHeaders).get("User-Agent"),
    ).toBe(ALLEGRO_USER_AGENT);
  });

  it("sends User-Agent on an Allegro OAuth token POST", async () => {
    const res = await axios.post(
      "https://allegro.pl/auth/oauth/token",
      "grant_type=client_credentials",
    );
    expect(
      (res.config.headers as AxiosHeaders).get("User-Agent"),
    ).toBe(ALLEGRO_USER_AGENT);
  });

  it("does not stamp non-Allegro requests", async () => {
    const res = await axios.get("https://world.openfoodfacts.org/api/v2/x");
    expect(
      (res.config.headers as AxiosHeaders).get("User-Agent"),
    ).toBeUndefined();
  });
});
