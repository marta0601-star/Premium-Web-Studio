/**
 * EAN → product lookup pipeline.
 *
 * Audit (2026-05) — what's actually working in the wild:
 *
 *   STRUCTURED APIS (reliable, JSON, low false-positive rate)
 *     ✓ Allegro Search API (OAuth)        — official, requires user token,
 *       same /sale/products?phrase= endpoint as the Catalog step but called
 *       again here so an Allegro hit can still surface when the upstream
 *       Step 1 in routes/allegro.ts had a transient 5xx/network error
 *     ✓ OpenFoodFacts (world.* + regional pl/de/fr/es/cz/sk/it/nl/hu)
 *     ✓ OpenBeautyFacts, OpenPetFoodFacts (cosmetics, pet food)
 *     ✓ UPCitemDB trial endpoint — rate-limited (~100/day per IP) but free
 *
 *   DIRECT E-COMMERCE SCRAPING (fragile but high-value for PL market)
 *     ✗ Allegro listing scraping          — REMOVED, replaced by the
 *       Search API above (no Akamai captchas, structured JSON, ToS-safe)
 *     ~ Ceneo (https://www.ceneo.pl/;szukaj-<ean>) — works, parseable HTML
 *     ~ Skapiec (https://www.skapiec.pl/szukaj?szukaj=<ean>) — works
 *
 *   GOOGLE-SCRAPED SEARCHES (unreliable: captchas, empty results, IP bans)
 *     ! google.com/search — works ~50% of the time on a fresh IP, then degrades
 *       Was Phase-3 sequential for-loop — slow and brittle. Now Phase B
 *       runs all variants in parallel so one captcha doesn't block the rest.
 *     ✗ Google Shopping (?tbm=shop) — almost always blocked from servers
 *     ! Google Images — same caveats, but useful as a *last-resort* image
 *       fallback when a structured source returned a name without a photo.
 *
 *   IMAGE-ONLY FALLBACKS (kick in when name found but image missing)
 *     ~ Bing Images — easier to scrape than Google, looser bot detection
 *     ✓ Allegro Search by name — same official API, just queried by the
 *       product name we already extracted; first images[0].url wins
 *     ! Google Images (kept as final fallback)
 *
 * What changed from the previous implementation:
 *   • Each source runs under a per-source AbortController + timeout (3 s,
 *     OFF gets 5 s because it fans out across regions).
 *   • Phase B (Google site: queries) is now Promise.allSettled in parallel
 *     instead of a sequential for-await loop.
 *   • Transient HTTP errors (5xx, ECONNABORTED) get one retry with
 *     exponential backoff (200 ms, 600 ms). 4xx is treated as legitimate
 *     and not retried.
 *   • Fuzzy EAN variants (UPC-A ↔ EAN-13, leading zero) are tried for the
 *     structured APIs that index by exact code (OFF, UPCitemDB).
 *   • All hits are gathered and ranked by a heuristic score
 *     (name+image, Polish source, brand, category) — winner returned,
 *     full trace exposed via the new `debug` field for production triage.
 */
import axios, { type AxiosResponse } from "axios";
import { getUserToken } from "./allegro-auth";
import { STORE_NAMES_TO_REMOVE } from "./auto-detect";

// ── Constants ────────────────────────────────────────────────────────────────

const OPEN_FOOD_FACTS_REGIONS = [
  "world",
  "de",
  "pl",
  "fr",
  "es",
  "cz",
  "sk",
  "it",
  "nl",
  "hu",
];

const WEIGHT_REGEX = /\b(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|cl|oz|lb|pieces?|szt|sztuk)\b/gi;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const PER_SOURCE_TIMEOUT_MS = 3000;
const PER_SOURCE_TIMEOUT_LONG_MS = 5000;
const RETRY_BACKOFF_MS = [200, 600];

// Source names that originate from / strongly cover the Polish market.
// Used by the scorer to nudge PL-specific results above international ones.
const POLISH_SOURCES: ReadonlySet<string> = new Set([
  "allegro_search",
  "ceneo_listing",
  "skapiec_listing",
  "google_allegro",
  "google_ceneo",
  "google_lidl_pl",
  "google_rossmann",
  "google_biedronka",
  "google_carrefour_pl",
  "google_auchan_pl",
  "google_amazon_pl",
  "google_empik",
]);

// Sources backed by an official, vendor-supported API (vs. HTML scraping).
// They get a small ranking bonus on the assumption that their data is more
// stable and consistent than what we can pull out of search-result HTML.
const TRUSTED_SOURCES: ReadonlySet<string> = new Set([
  "allegro_search",
]);

const ALLEGRO_API_BASE = "https://api.allegro.pl";

// ── Public types ─────────────────────────────────────────────────────────────

export interface SourceTrace {
  name: string;
  ms: number;
  result: "hit" | "miss" | "error" | "timeout" | "hit_lower_score";
  error?: string;
  scoreReason?: string;
}

export interface LookupDebug {
  sources: SourceTrace[];
  totalMs: number;
  winnerScore?: number;
  alternativeCount?: number;
}

/**
 * Bag of structured tags / strings that downstream parameter-fill logic can
 * use to populate Allegro category parameters more aggressively than the
 * basic name/brand/weight triple. Currently populated only by OFF — other
 * sources leave it undefined and the filler falls back to name keywords.
 */
export interface LookupMeta {
  categoriesTags?: string[];
  brandsTags?: string[];
  packagingTags?: string[];
  labelsTags?: string[];
  ingredients?: string;
  quantityRaw?: string;
}

export interface LookupResult {
  found: boolean;
  name?: string | null;
  brand?: string | null;
  weight?: string | null;
  category?: string | null;
  image?: string | null;
  description?: string | null;
  source?: string | null;
  logs: string[];
  debug?: LookupDebug;
  meta?: LookupMeta;
}

// ── EAN variants for fuzzy matching ──────────────────────────────────────────

/**
 * Generate plausible alternative encodings of the input code.
 *
 * UPCitemDB and OpenFoodFacts mostly index by exact 12 / 13-digit code,
 * but real-world data is messy: a UPC-A 12-digit code is the same product
 * as the EAN-13 with a leading zero, and some catalogues drop or add the
 * leading zero inconsistently.
 *
 * Returned values are deduplicated, original code first.
 */
function eanVariants(ean: string): string[] {
  const s = ean.replace(/\D/g, "");
  const set = new Set<string>([s]);
  if (s.length === 12) set.add("0" + s); // UPC-A → EAN-13
  if (s.length === 13 && s.startsWith("0")) set.add(s.slice(1)); // EAN-13 → UPC-A
  if (s.length === 13 && !s.startsWith("0")) set.add("0" + s.slice(0, 12)); // strip-then-pad variant
  return [...set];
}

// ── HTTP helper with bounded retry on transient errors ───────────────────────

interface HttpGetOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  retries?: number;
}

/**
 * axios.get with one optional retry for ECONNABORTED / 502 / 503 / 504 /
 * connection-reset. 4xx is considered legitimate (404 means "not in this
 * DB", 429 means we should back off rather than hammer) and is NOT retried.
 */
async function httpGet(url: string, opts: HttpGetOpts = {}): Promise<AxiosResponse> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, {
        timeout: opts.timeoutMs ?? PER_SOURCE_TIMEOUT_MS,
        signal: opts.signal,
        headers: opts.headers,
        // Don't follow excessively many redirects — most legit search pages
        // return ≤2.
        maxRedirects: 3,
      });
    } catch (err: unknown) {
      lastErr = err;
      const e = err as { code?: string; name?: string; response?: { status?: number } };
      if (e.name === "AbortError" || e.name === "CanceledError" || e.code === "ERR_CANCELED") {
        throw err;
      }
      const status = e.response?.status;
      const transient =
        e.code === "ECONNABORTED" ||
        e.code === "ECONNRESET" ||
        e.code === "ETIMEDOUT" ||
        status === 502 ||
        status === 503 ||
        status === 504;
      if (!transient || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 600));
    }
  }
  throw lastErr;
}

// ── Image URL extraction (used by Google / Bing / Ceneo / Allegro HTML) ──────

function extractImageUrl(html: string, label: string, logs: string[]): string | null {
  // 1. "ou" (original URL) JSON field — most reliable when present
  const ouMatch = html.match(/"ou":"(https?:\/\/[^"\\]+)"/);
  if (ouMatch?.[1]) {
    const url = ouMatch[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
    if (!url.includes("google.com/images") && !url.includes("gstatic.com/images/branding")) {
      logs.push(`[${label}] via ou: ${url.slice(0, 80)}`);
      return url;
    }
  }

  // 2. imgurl= parameter (in redirect URLs)
  const imgurlMatch = html.match(/imgurl=(https?:\/\/[^&"'\s]+)/);
  if (imgurlMatch?.[1]) {
    const url = decodeURIComponent(imgurlMatch[1]);
    logs.push(`[${label}] via imgurl: ${url.slice(0, 80)}`);
    return url;
  }

  // 3. JSON array pattern ["url",width,height] from Google Images JS
  const jsonArrMatch = html.match(/\["(https?:\/\/(?!encrypted-tbn)[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*\d+,\s*\d+\]/);
  if (jsonArrMatch?.[1]) {
    logs.push(`[${label}] via JSON arr: ${jsonArrMatch[1].slice(0, 80)}`);
    return jsonArrMatch[1];
  }

  // 4. Direct image URL with extension on a non-tracking domain. Filter out
  // sprite icons / spacers (very small dims often referenced in the URL).
  const extRegex = /https?:\/\/(?!(?:www\.google|ssl\.gstatic|fonts\.gstatic|lh[0-9]\.googleusercontent))[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]{0,120})?/gi;
  let extMatch: RegExpExecArray | null;
  while ((extMatch = extRegex.exec(html)) !== null) {
    const url = extMatch[0];
    if (
      url.length < 400 &&
      !url.includes("google.com") &&
      !/\b(sprite|logo|icon|favicon|placeholder|blank)\b/i.test(url)
    ) {
      logs.push(`[${label}] via ext: ${url.slice(0, 80)}`);
      return url;
    }
  }

  // 5. encrypted-tbn thumbnail (low quality but proves the product exists)
  const tbnMatch = html.match(/https?:\/\/encrypted-tbn\d*\.gstatic\.com\/images[^"'\s<>]+/);
  if (tbnMatch?.[0]) {
    logs.push(`[${label}] via tbn (thumbnail): ${tbnMatch[0].slice(0, 80)}`);
    return tbnMatch[0];
  }

  logs.push(`[${label}] No image URL found (html len=${html.length})`);
  return null;
}

// ── Source-runner: timing + abort + result classification ────────────────────

/**
 * Wrap a source function with: AbortController, per-source timeout, and a
 * SourceTrace record. The fn receives an AbortSignal that fires when our
 * timeout elapses; cooperating fetch/axios calls should pass it through so
 * a slow source can't block the whole pipeline.
 */
async function trackSource<T extends LookupResult | { image: string } | null>(
  name: string,
  sources: SourceTrace[],
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = PER_SOURCE_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fn(ctrl.signal);
    const ms = Date.now() - start;
    if (r && (("name" in r && r.name) || ("image" in r && r.image))) {
      sources.push({ name, ms, result: "hit" });
    } else {
      sources.push({ name, ms, result: "miss" });
    }
    return r;
  } catch (err: unknown) {
    const ms = Date.now() - start;
    const e = err as { name?: string; message?: string; code?: string };
    if (
      e.name === "AbortError" ||
      e.name === "CanceledError" ||
      e.code === "ERR_CANCELED" ||
      e.code === "ECONNABORTED"
    ) {
      sources.push({ name, ms, result: "timeout" });
    } else {
      sources.push({ name, ms, result: "error", error: e.message?.slice(0, 200) });
    }
    return null as T;
  } finally {
    clearTimeout(timer);
  }
}

// ── OpenFoodFacts family ─────────────────────────────────────────────────────

function extractOffImage(p: Record<string, unknown>, ean: string): string | null {
  const direct =
    (p.image_front_url as string | null) ||
    (p.image_front_small_url as string | null) ||
    (p.image_url as string | null) ||
    (p.image_small_url as string | null);
  if (direct) return direct;

  const sel = p.selected_images as Record<string, unknown> | undefined;
  if (sel) {
    for (const imgType of ["front", "ingredients", "nutrition", "packaging"]) {
      const typeObj = sel[imgType] as Record<string, unknown> | undefined;
      if (!typeObj) continue;
      for (const sizeKey of ["display", "small", "thumb"]) {
        const display = typeObj[sizeKey] as Record<string, unknown> | undefined;
        if (!display) continue;
        for (const lang of ["pl", "de", "en", "fr", "es", "it", "nl"]) {
          if (typeof display[lang] === "string" && display[lang]) return display[lang] as string;
        }
        const vals = Object.values(display).filter((v) => typeof v === "string" && v);
        if (vals.length > 0) return vals[0] as string;
      }
    }
  }

  const anyPhoto =
    (p.image_ingredients_url as string | null) ||
    (p.image_ingredients_small_url as string | null) ||
    (p.image_nutrition_url as string | null) ||
    (p.image_nutrition_small_url as string | null) ||
    (p.image_packaging_url as string | null);
  if (anyPhoto) return anyPhoto;

  const eanPath = buildOffEanPath(ean);
  const imgs = p.images as Record<string, unknown> | undefined;
  if (imgs && eanPath) {
    const BASE = "https://images.openfoodfacts.org/images/products";
    for (const prefix of ["front_en", "front_de", "front_fr", "front", "ingredients_en", "ingredients"]) {
      if (imgs[prefix]) return `${BASE}/${eanPath}/${prefix}.400.jpg`;
    }
    const numKeys = Object.keys(imgs).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
    if (numKeys.length > 0) return `${BASE}/${eanPath}/${numKeys[0]}.full.jpg`;
  }

  return null;
}

function buildOffEanPath(ean: string): string | null {
  const s = ean.replace(/\D/g, "");
  if (s.length === 13) return `${s.slice(0, 3)}/${s.slice(3, 6)}/${s.slice(6, 9)}/${s.slice(9)}`;
  if (s.length === 8) return `${s.slice(0, 4)}/${s.slice(4)}`;
  return s.length >= 1 ? s : null;
}

async function fetchOffOnce(
  domain: string,
  ean: string,
  source: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://${domain}/api/v2/product/${ean}.json`;
  logs.push(`[${source}] ${url}`);
  const resp = await httpGet(url, {
    timeoutMs: PER_SOURCE_TIMEOUT_MS,
    signal,
    headers: { "User-Agent": "iPremiumScan/1.0" },
  });
  const data = resp.data;
  if (data?.status !== 1 || !data.product) {
    logs.push(`[${source}] status=${data?.status}`);
    return null;
  }
  const p = data.product as Record<string, unknown>;
  const name =
    (p.product_name as string) ||
    (p.product_name_pl as string) ||
    (p.product_name_de as string) ||
    (p.product_name_en as string) ||
    (p.product_name_fr as string) ||
    (p.product_name_sk as string) ||
    null;
  if (!name) {
    logs.push(`[${source}] Found but no name — skipping`);
    return null;
  }
  const image = extractOffImage(p, ean);
  logs.push(`[${source}] Found: ${name}${image ? ` (image)` : " (no image)"}`);

  const stringArr = (key: string): string[] | undefined => {
    const v = p[key];
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  };

  const meta: LookupMeta = {
    categoriesTags: stringArr("categories_tags"),
    brandsTags: stringArr("brands_tags"),
    packagingTags: stringArr("packaging_tags") ?? stringArr("packagings_tags"),
    labelsTags: stringArr("labels_tags"),
    ingredients: typeof p.ingredients_text === "string" ? (p.ingredients_text as string) : undefined,
    quantityRaw: typeof p.quantity === "string" ? (p.quantity as string) : undefined,
  };

  return {
    found: true,
    name,
    brand: (p.brands as string) || null,
    weight:
      (p.quantity as string) ||
      (p.product_quantity
        ? `${p.product_quantity} ${(p.product_quantity_unit as string) || ""}`.trim()
        : null) ||
      (p.serving_size as string) ||
      null,
    category: p.categories ? (p.categories as string).split(",")[0].trim() : null,
    image,
    description: null,
    source,
    logs,
    meta,
  };
}

/**
 * OFF in parallel across regions for the original EAN, then if all miss,
 * across regions for each fuzzy variant. Total fan-out is bounded by the
 * outer trackSource timeout so we won't exceed it even on slow regions.
 */
async function searchOpenFoodFacts(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const variants = eanVariants(ean);
  for (const variant of variants) {
    const settled = await Promise.allSettled(
      OPEN_FOOD_FACTS_REGIONS.map((region) =>
        fetchOffOnce(`${region}.openfoodfacts.org`, variant, `OpenFoodFacts/${region}`, logs, signal),
      ),
    );
    let withImage: LookupResult | null = null;
    let withoutImage: LookupResult | null = null;
    for (const r of settled) {
      if (r.status !== "fulfilled" || !r.value) continue;
      if (r.value.image && !withImage) withImage = r.value;
      if (!withoutImage) withoutImage = r.value;
    }
    const winner = withImage || withoutImage;
    if (winner) {
      if (variant !== ean) logs.push(`[OFF] hit on variant ${variant}`);
      return winner;
    }
  }
  return null;
}

async function searchOpenFactsApi(
  domain: string,
  label: string,
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const variants = eanVariants(ean);
  for (const variant of variants) {
    try {
      const r = await fetchOffOnce(domain, variant, label, logs, signal);
      if (r) {
        if (variant !== ean) logs.push(`[${label}] hit on variant ${variant}`);
        return r;
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number }; message?: string };
      if (e.response?.status === 404) continue; // try next variant
      throw err;
    }
  }
  return null;
}

// ── UPCitemDB ────────────────────────────────────────────────────────────────

async function searchUpcItemdbOnce(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`;
  logs.push(`[UPCitemdb] ${url}`);
  const resp = await httpGet(url, {
    timeoutMs: PER_SOURCE_TIMEOUT_MS,
    signal,
    headers: { "User-Agent": "iPremiumScan/1.0" },
  });
  const data = resp.data;
  if (data?.code !== "OK" || !data.items?.length) {
    logs.push(`[UPCitemdb] code=${data?.code}`);
    return null;
  }
  const item = data.items[0];
  if (!item.title) {
    logs.push("[UPCitemdb] No title — skipping");
    return null;
  }
  const image = item.images?.[0] || null;
  logs.push(`[UPCitemdb] Found: ${item.title}${image ? " (with image)" : " (no image)"}`);
  return {
    found: true,
    name: item.title,
    brand: item.brand || null,
    weight: item.weight || null,
    category: item.category || null,
    image,
    description: item.description || null,
    source: "upcitemdb",
    logs,
  };
}

async function searchUpcItemdb(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  for (const variant of eanVariants(ean)) {
    try {
      const r = await searchUpcItemdbOnce(variant, logs, signal);
      if (r) {
        if (variant !== ean) logs.push(`[UPCitemdb] hit on variant ${variant}`);
        return r;
      }
    } catch (err: unknown) {
      const e = err as { response?: { status?: number } };
      if (e.response?.status === 429) {
        logs.push("[UPCitemdb] 429 — bailing on remaining variants");
        return null;
      }
    }
  }
  return null;
}

// ── Direct PL e-commerce scrapers ────────────────────────────────────────────

// Generic page-header strings that PL e-shops show on empty search results;
// matching one of these means the EAN was NOT found, regardless of what the
// HTML scraper extracted from <h1>/<h2>. Comparison is lowercase-substring.
const BAD_SCRAPED_NAMES = [
  "wyniki wyszukiwania",
  "search results",
  "strona główna",
  "nie znaleziono",
  "no results",
  "404",
  "page not found",
  "captcha",
  "cloudflare",
  "allegro - najwiek",
  "ceneo",
  "skapiec",
];

function isLikelyProductName(name: string | null, ean: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 10) return false;
  const lower = trimmed.toLowerCase();
  if (BAD_SCRAPED_NAMES.some((bad) => lower.includes(bad))) return false;
  if (trimmed === ean) return false;
  return true;
}


async function fetchHtml(
  url: string,
  label: string,
  logs: string[],
  signal: AbortSignal,
  timeoutMs: number = PER_SOURCE_TIMEOUT_MS,
): Promise<string | null> {
  logs.push(`[${label}] GET ${url}`);
  try {
    const resp = await httpGet(url, {
      timeoutMs,
      signal,
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.5",
      },
    });
    return typeof resp.data === "string" ? resp.data : "";
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; response?: { status?: number } };
    logs.push(`[${label}] Error: ${e.response?.status ?? e.code ?? e.message}`);
    return null;
  }
}

/**
 * Allegro Search API call against /sale/products?phrase=<phrase>.
 *
 * Used for both the EAN lookup in Phase A (`source: "allegro_search"`) and
 * the by-name image fallback later in the pipeline. Replaces the old HTML
 * scraping of allegro.pl/listing — same data, but ToS-safe, structured
 * JSON, no Akamai captchas.
 *
 * Auth: the same OAuth user token used by the Catalog step in
 * routes/allegro.ts. If no token is available (user hasn't authorised
 * Allegro yet, or the refresh token expired) we silently return null —
 * letting the rest of the pipeline (Ceneo, Skapiec, OFF, …) carry on.
 *
 * Failure modes that should NOT fall back to scraping:
 *   401 / 403 — propagate as silent miss; user needs to re-authorise.
 *   5xx / network error — silent miss; the per-source timeout already
 *   bounds how long we wait.
 */
async function searchAllegroByPhrase(
  phrase: string,
  sourceTag: string,
  label: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  let token: string;
  try {
    token = await getUserToken();
  } catch {
    logs.push(`[${label}] No Allegro user token available — skipping`);
    return null;
  }

  const url = `${ALLEGRO_API_BASE}/sale/products?phrase=${encodeURIComponent(phrase)}&language=pl-PL`;
  logs.push(`[${label}] GET ${url}`);

  let resp: AxiosResponse;
  try {
    resp = await httpGet(url, {
      timeoutMs: PER_SOURCE_TIMEOUT_MS,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.allegro.public.v1+json",
      },
    });
  } catch (err: unknown) {
    const e = err as { response?: { status?: number }; code?: string; message?: string };
    const status = e.response?.status;
    if (status === 401 || status === 403) {
      logs.push(`[${label}] ${status} — token rejected, skipping`);
      return null;
    }
    logs.push(`[${label}] Error: ${status ?? e.code ?? e.message}`);
    return null;
  }

  const data = resp.data as {
    products?: Array<{
      id?: string;
      name?: string;
      category?: { id?: string; name?: string };
      images?: Array<{ url?: string }>;
      parameters?: Array<{ name?: string; values?: string[] }>;
    }>;
  };
  const products = data.products ?? [];
  if (products.length === 0) {
    logs.push(`[${label}] No products`);
    return null;
  }

  const p = products[0];
  const name = typeof p.name === "string" ? p.name.trim() : null;
  const image = p.images?.[0]?.url ?? null;
  const category = p.category?.name ?? null;
  // Brand is exposed as a parameter named "Marka" (PL) in Allegro's catalog.
  // Some categories use other field names; pick the first that smells right.
  const brandParam = (p.parameters ?? []).find((par) => {
    const n = (par.name ?? "").toLowerCase();
    return n === "marka" || n === "brand" || n === "producent" || n === "manufacturer";
  });
  const brand = brandParam?.values?.[0] ?? null;

  if (!name && !image) {
    logs.push(`[${label}] First product had neither name nor image`);
    return null;
  }
  logs.push(`[${label}] Found: ${name ?? "<no name>"}${image ? " (image)" : ""}`);

  return {
    found: true,
    name,
    brand,
    weight: null,
    category,
    image,
    description: null,
    source: sourceTag,
    logs,
  };
}

async function searchCeneoListing(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://www.ceneo.pl/;szukaj-${encodeURIComponent(ean)}`;
  const html = await fetchHtml(url, "CeneoListing", logs, signal);
  if (!html) return null;
  // Ceneo product cards: .cat-prod-row__name or .go-to-product. The previous
  // <h1> fallback was wrong — on empty searches Ceneo's <h1> is just
  // "Wyniki wyszukiwania", which would slip through scoring.
  const titleMatch =
    html.match(/<strong[^>]+class=["'][^"']*cat-prod-row__name[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)/i) ||
    html.match(/<a[^>]+class=["'][^"']*go-to-product[^"']*["'][^>]*>([^<]{15,200})<\/a>/i);
  const imgMatch =
    html.match(/<img[^>]+src=["'](https:\/\/image\.ceneostatic\.pl\/[^"']+)["']/) ||
    html.match(/(https:\/\/[^"'\s]*ceneostatic\.pl\/[^"'\s]+\.(?:jpg|jpeg|png|webp))/);
  const rawName = titleMatch?.[1]?.trim().replace(/\s+/g, " ") || null;
  const name = isLikelyProductName(rawName, ean) ? rawName : null;
  const image = imgMatch?.[1] || null;
  if (!name && !image) {
    logs.push("[CeneoListing] No products in HTML");
    return null;
  }
  logs.push(`[CeneoListing] Found: ${name ?? "<no name>"}${image ? " (image)" : ""}`);
  return {
    found: true,
    name,
    brand: null,
    weight: null,
    category: null,
    image,
    description: null,
    source: "ceneo_listing",
    logs,
  };
}

async function searchSkapiecListing(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://www.skapiec.pl/szukaj/${encodeURIComponent(ean)}`;
  const html = await fetchHtml(url, "SkapiecListing", logs, signal);
  if (!html) return null;
  // Skapiec result cards. <h1>…</h1> on a no-results page is "Wyniki
  // wyszukiwania" — the BAD_SCRAPED_NAMES filter catches that even if we
  // accidentally regress to the H1 fallback.
  const titleMatch =
    html.match(/<h2[^>]+class=["'][^"']*product-name[^"']*["'][^>]*>\s*<a[^>]*>([^<]+)/i) ||
    html.match(/<a[^>]+class=["'][^"']*item-card-link[^"']*["'][^>]*>([^<]{10,200})/i);
  const imgMatch =
    html.match(/<img[^>]+src=["'](https:\/\/image\.skapiec\.pl\/[^"']+)["']/) ||
    html.match(/(https:\/\/[^"'\s]*skapiec\.pl\/[^"'\s]+\.(?:jpg|jpeg|png|webp))/);
  const rawName = titleMatch?.[1]?.trim().replace(/\s+/g, " ") || null;
  const name = isLikelyProductName(rawName, ean) ? rawName : null;
  const image = imgMatch?.[1] || null;
  if (!name && !image) {
    logs.push("[SkapiecListing] No products in HTML");
    return null;
  }
  logs.push(`[SkapiecListing] Found: ${name ?? "<no name>"}${image ? " (image)" : ""}`);
  return {
    found: true,
    name,
    brand: null,
    weight: null,
    category: null,
    image,
    description: null,
    source: "skapiec_listing",
    logs,
  };
}

// ── Google scraping (text + images + shopping) ───────────────────────────────

function extractNameFromGoogleHtml(html: string, label: string, logs: string[], source: string): LookupResult | null {
  const h3Matches = html.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
  const titles = h3Matches
    .map((m) => m.replace(/<[^>]+>/g, "").trim())
    .filter((t) => t.length > 3 && !t.toLowerCase().includes("google"))
    .map((t) => t.replace(STORE_NAMES_TO_REMOVE, "").trim())
    .filter((t) => t.length > 3);
  const name = titles[0] || null;

  WEIGHT_REGEX.lastIndex = 0;
  const weightMatch = WEIGHT_REGEX.exec(html);
  const weight = weightMatch ? weightMatch[0] : null;

  const imgUrl = extractImageUrl(html, label + "/text", logs);
  if (!name) {
    logs.push(`[${label}] No product name found`);
    return null;
  }
  logs.push(`[${label}] Name found: ${name}`);
  return {
    found: true,
    name,
    brand: null,
    weight,
    category: null,
    image: imgUrl,
    description: null,
    source,
    logs,
  };
}

async function googleTextSearch(
  query: string,
  label: string,
  source: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const html = await fetchHtml(url, label, logs, signal);
  if (!html) return null;
  return extractNameFromGoogleHtml(html, label, logs, source);
}

async function searchGoogleImagesUrl(
  query: string,
  label: string,
  logs: string[],
  signal: AbortSignal,
): Promise<{ image: string } | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&hl=pl`;
  const html = await fetchHtml(url, label, logs, signal);
  if (!html) return null;
  const image = extractImageUrl(html, label, logs);
  return image ? { image } : null;
}

async function searchGoogleShopping(
  ean: string,
  logs: string[],
  signal: AbortSignal,
): Promise<LookupResult | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(ean)}&tbm=shop`;
  const html = await fetchHtml(url, "GoogleShopping", logs, signal);
  if (!html) return null;
  return extractNameFromGoogleHtml(html, "GoogleShopping", logs, "google_shopping");
}

// ── Image-only fallbacks (when name found but no image) ──────────────────────

async function searchBingImages(
  query: string,
  logs: string[],
  signal: AbortSignal,
): Promise<{ image: string } | null> {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1`;
  const html = await fetchHtml(url, "BingImg", logs, signal);
  if (!html) return null;
  // Bing: m="{...&quot;murl&quot;:&quot;...&quot;...}" — easier than Google
  const murlMatch = html.match(/&quot;murl&quot;:&quot;([^&]+)&quot;/);
  if (murlMatch?.[1]) {
    const url2 = murlMatch[1];
    if (/^https?:\/\//.test(url2) && !/(sprite|logo|icon|favicon)/i.test(url2)) {
      logs.push(`[BingImg] via murl: ${url2.slice(0, 80)}`);
      return { image: url2 };
    }
  }
  const fallback = extractImageUrl(html, "BingImg", logs);
  return fallback ? { image: fallback } : null;
}

/**
 * Image-only fallback: re-query the Allegro Search API by the product name
 * we already pulled out of another source (OFF / UPCitemDB / …) and use
 * the first hit's images[0].url. Same official endpoint as the EAN lookup
 * above, so the same auth + silent-skip rules apply.
 */
async function searchAllegroImageByName(
  name: string,
  logs: string[],
  signal: AbortSignal,
): Promise<{ image: string } | null> {
  const r = await searchAllegroByPhrase(name, "allegro_search", "AllegroImg", logs, signal);
  return r?.image ? { image: r.image } : null;
}

// ── Scoring ──────────────────────────────────────────────────────────────────

interface ScoreOutcome {
  score: number;
  reason: string;
}

/**
 * Heuristic ranking: prefers complete records (name + image), Polish-market
 * sources (this app's primary audience), and entries with brand/category
 * metadata that helps the downstream Allegro categoriser.
 *
 * The point of scoring (rather than first-wins) is to pick the *best*
 * record when several sources hit at once — e.g. UPCitemDB returning a
 * name without image, while a parallel Ceneo hit returns name + image
 * + Polish locale.
 */
function scoreResult(r: LookupResult, sourceName: string): ScoreOutcome {
  let score = 0;
  const reasons: string[] = [];
  if (r.name && r.image) {
    score += 10;
    reasons.push("+10 name+image");
  } else if (r.name) {
    score += 4;
    reasons.push("+4 name only");
  } else if (r.image) {
    score += 2;
    reasons.push("+2 image only");
  }
  if (POLISH_SOURCES.has(sourceName)) {
    score += 5;
    reasons.push("+5 PL source");
  }
  if (TRUSTED_SOURCES.has(sourceName)) {
    score += 2;
    reasons.push("+2 trusted source");
  }
  if (r.brand) {
    score += 3;
    reasons.push("+3 brand");
  }
  if (r.category) {
    score += 2;
    reasons.push("+2 category");
  }
  if (r.image && /\/(s\d{3,}|[wh]\d{3,}|\d{3,}x\d{3,})/.test(r.image)) {
    score += 1;
    reasons.push("+1 large img URL");
  }
  return { score, reason: reasons.join(", ") || "0" };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export async function lookupEan(ean: string): Promise<LookupResult> {
  const startedAt = Date.now();
  const sources: SourceTrace[] = [];
  const logs: string[] = [`Szukam EAN: ${ean}`];

  // ── Phase A: structured APIs + direct PL e-commerce, all in parallel ───
  // Each source has its own timeout; one slow path can't drag the whole
  // pipeline down. Fuzzy variants are handled inside the OFF / UPCitemDB
  // helpers (only those benefit from variant lookups; web search engines
  // already do their own fuzziness).
  const phaseA = await Promise.all([
    trackSource("openfoodfacts", sources, (s) => searchOpenFoodFacts(ean, logs, s), PER_SOURCE_TIMEOUT_LONG_MS),
    trackSource("openbeautyfacts", sources, (s) =>
      searchOpenFactsApi("world.openbeautyfacts.org", "OpenBeautyFacts", ean, logs, s),
    ),
    trackSource("openpetfoodfacts", sources, (s) =>
      searchOpenFactsApi("world.openpetfoodfacts.org", "OpenPetFoodFacts", ean, logs, s),
    ),
    trackSource("upcitemdb", sources, (s) => searchUpcItemdb(ean, logs, s)),
    trackSource("allegro_search", sources, (s) =>
      searchAllegroByPhrase(ean, "allegro_search", "AllegroSearch", logs, s),
    ),
    trackSource("ceneo_listing", sources, (s) => searchCeneoListing(ean, logs, s)),
    trackSource("skapiec_listing", sources, (s) => searchSkapiecListing(ean, logs, s)),
  ]);

  // ── Phase B: parallel Google site: queries (was sequential for-loop) ──
  // Includes broad PL e-shops, international barcode databases, and one
  // generic Google search. Per-source timeout means a captcha on one
  // doesn't block the rest.
  const phaseB = await Promise.all([
    trackSource("google_allegro", sources, (s) => googleTextSearch(`site:allegro.pl ${ean}`, "Google/Allegro", "google_allegro", logs, s)),
    trackSource("google_ceneo", sources, (s) => googleTextSearch(`site:ceneo.pl ${ean}`, "Google/Ceneo", "google_ceneo", logs, s)),
    trackSource("google_barcodelookup", sources, (s) => googleTextSearch(`site:barcodelookup.com ${ean}`, "Google/BarcodeDB", "google_barcodelookup", logs, s)),
    trackSource("google_ean_search", sources, (s) => googleTextSearch(`site:ean-search.org ${ean}`, "Google/EANsearch", "google_ean_search", logs, s)),
    trackSource("google_kaufland", sources, (s) => googleTextSearch(`site:kaufland.de ${ean}`, "Google/Kaufland", "google_kaufland", logs, s)),
    trackSource("google_lidl_pl", sources, (s) => googleTextSearch(`site:lidl.pl ${ean}`, "Google/Lidl", "google_lidl_pl", logs, s)),
    trackSource("google_rossmann", sources, (s) => googleTextSearch(`site:rossmann.pl ${ean}`, "Google/Rossmann", "google_rossmann", logs, s)),
    trackSource("google_empik", sources, (s) => googleTextSearch(`site:empik.com ${ean}`, "Google/Empik", "google_empik", logs, s)),
    trackSource("google_amazon_de", sources, (s) => googleTextSearch(`site:amazon.de ${ean}`, "Google/Amazon.de", "google_amazon_de", logs, s)),
    trackSource("google_amazon_pl", sources, (s) => googleTextSearch(`site:amazon.pl ${ean}`, "Google/Amazon.pl", "google_amazon_pl", logs, s)),
    trackSource("google_ebay", sources, (s) => googleTextSearch(`site:ebay.com ${ean}`, "Google/eBay", "google_ebay", logs, s)),
    trackSource("google_codecheck", sources, (s) => googleTextSearch(`site:codecheck.info ${ean}`, "Google/Codecheck", "google_codecheck", logs, s)),
    trackSource("google_cosmetify", sources, (s) => googleTextSearch(`site:cosmetify.com ${ean}`, "Google/Cosmetify", "google_cosmetify", logs, s)),
    trackSource("google_shopping", sources, (s) => searchGoogleShopping(ean, logs, s)),
    trackSource("google_image_ean", sources, (s) => searchGoogleImagesUrl(ean, "GoogleImg/EAN", logs, s)),
    trackSource("google_image_ceneo", sources, (s) => searchGoogleImagesUrl(`site:ceneo.pl ${ean}`, "GoogleImg/Ceneo", logs, s)),
    trackSource("google_image_allegro", sources, (s) => searchGoogleImagesUrl(`site:allegro.pl ${ean}`, "GoogleImg/Allegro", logs, s)),
  ]);

  // ── Gather all hits and rank ──────────────────────────────────────────
  // phaseA entries: LookupResult | null (with name)
  // phaseB entries: LookupResult | null (text searches), or { image } for image searches
  const allHits: LookupResult[] = [];
  for (const r of phaseA) {
    if (r && "name" in r && r.name) allHits.push(r);
  }
  for (const r of phaseB) {
    if (r && "name" in r && r.name) allHits.push(r);
  }

  // Image-only fallbacks from phaseB are dealt with separately below.
  const phaseBImages: string[] = [];
  for (const r of phaseB) {
    if (r && "image" in r && r.image) phaseBImages.push(r.image);
  }

  if (allHits.length === 0) {
    // Maybe all that came back was a Google Images URL with no name —
    // we can't make an offer from a bare image, so treat as not found.
    logs.push("Nie znaleziono produktu w żadnym źródle");
    return {
      found: false,
      logs,
      debug: { sources, totalMs: Date.now() - startedAt },
    };
  }

  const scored = allHits
    .map((r) => ({ r, ...scoreResult(r, r.source ?? "unknown") }))
    .sort((a, b) => b.score - a.score);

  const winnerEntry = scored[0];
  const winner = winnerEntry.r;
  const winnerScore = winnerEntry.score;
  const winnerSource = winner.source ?? "unknown";

  // Annotate the SourceTrace for the winning source with the score reason,
  // and demote subsequent hits to "hit_lower_score" so the debug field
  // shows what was beaten. Match by prefix because the structured sources
  // append a region (`openfoodfacts/de`) to their source field while the
  // wrapper trace stores only the family name (`openfoodfacts`).
  function findHitTraceFor(sourceName: string): SourceTrace | undefined {
    const sn = sourceName.toLowerCase();
    return sources.find(
      (t) =>
        t.result === "hit" &&
        (t.name.toLowerCase() === sn || sn.startsWith(t.name.toLowerCase() + "/")),
    );
  }
  const winnerTrace = findHitTraceFor(winnerSource);
  if (winnerTrace) winnerTrace.scoreReason = winnerEntry.reason;
  for (const other of scored.slice(1)) {
    const sourceName = other.r.source ?? "unknown";
    const trace = findHitTraceFor(sourceName);
    if (trace && trace !== winnerTrace) {
      trace.result = "hit_lower_score";
      trace.scoreReason = other.reason;
    }
  }

  // ── Image hunt: if winner has no image, try fallbacks ──────────────────
  // 1. any image picked up by Google Images during phase B
  // 2. Bing Images (less aggressive bot detection than Google)
  // 3. Allegro listing search by product name
  // 4. Google Images for the product name (final fallback)
  let image: string | null = winner.image ?? phaseBImages[0] ?? null;
  if (!image && winner.name) {
    logs.push(`[ImageHunt] Searching by name: ${winner.name}`);
    const fromBing = await trackSource(
      "bing_images_name",
      sources,
      (s) => searchBingImages(winner.name!, logs, s),
    );
    if (fromBing?.image) image = fromBing.image;
    if (!image) {
      const fromAllegro = await trackSource(
        "allegro_images_name",
        sources,
        (s) => searchAllegroImageByName(winner.name!, logs, s),
      );
      if (fromAllegro?.image) image = fromAllegro.image;
    }
    if (!image) {
      const fromGoogle = await trackSource(
        "google_images_name",
        sources,
        (s) => searchGoogleImagesUrl(winner.name!, "GoogleImg/Name", logs, s),
      );
      if (fromGoogle?.image) image = fromGoogle.image;
    }
  }

  if (image) logs.push(`[Result] Image: ${image.slice(0, 80)}`);

  return {
    ...winner,
    image: image ?? null,
    logs,
    debug: {
      sources,
      totalMs: Date.now() - startedAt,
      winnerScore,
      alternativeCount: Math.max(0, scored.length - 1),
    },
  };
}
