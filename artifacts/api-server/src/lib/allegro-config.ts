/**
 * Central Allegro request configuration.
 *
 * From 2026-06-30 Allegro rejects API and OAuth requests that do not carry a
 * descriptive `User-Agent` header. This module owns the canonical value and the
 * helper used by the global axios request interceptor so that EVERY Allegro
 * call (REST API, client_credentials token, code→token exchange, refresh and
 * device flow) is stamped in one place.
 */
import { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

/**
 * ApplicationName registered with Allegro. Case-sensitive, no spaces — must
 * match the name on the Allegro Developer registration. If the registered name
 * ever differs, change it HERE (single source of truth).
 */
export const ALLEGRO_APPLICATION_NAME = "iPremium-scan";

/**
 * App version. Kept in sync with api-server `package.json` "version"
 * (guarded by a unit test in allegro-config.test.ts).
 */
export const APP_VERSION = "1.0.0";

/** Public, unauthenticated documentation page Allegro can crawl. */
export const ALLEGRO_DOCUMENTATION_URL =
  "https://premium.mojaapka.eu/o-aplikacji";

/**
 * Mandatory User-Agent for every Allegro request, e.g.
 *   iPremium-scan/1.0.0 (+https://premium.mojaapka.eu/o-aplikacji)
 */
export const ALLEGRO_USER_AGENT = `${ALLEGRO_APPLICATION_NAME}/${APP_VERSION} (+${ALLEGRO_DOCUMENTATION_URL})`;

/**
 * True when the request targets an Allegro host — the REST API
 * (`api.allegro.pl`) OR the auth/OAuth endpoints (`allegro.pl/auth/...`).
 * Allegro enforces the header on both.
 */
export function isAllegroRequest(fullUrl: string | undefined): boolean {
  if (!fullUrl) return false;
  return fullUrl.includes("allegro.pl");
}

/**
 * Axios request-interceptor callback: overwrite axios's default
 * `axios/x.y.z` User-Agent with {@link ALLEGRO_USER_AGENT} for Allegro-bound
 * requests. Non-Allegro requests (OpenFoodFacts, image downloads, web scrapes)
 * are left untouched so their own explicit User-Agent still applies.
 */
export function stampAllegroUserAgent(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  const fullUrl = `${config.baseURL ?? ""}${config.url ?? ""}`;
  if (isAllegroRequest(fullUrl)) {
    // axios ≥1 normalises config.headers to an AxiosHeaders instance before the
    // request interceptor runs, but guard for plain objects just in case.
    if (config.headers instanceof AxiosHeaders) {
      config.headers.set("User-Agent", ALLEGRO_USER_AGENT);
    } else {
      config.headers = AxiosHeaders.from({
        ...(config.headers as Record<string, unknown>),
        "User-Agent": ALLEGRO_USER_AGENT,
      });
    }
  }
  return config;
}
