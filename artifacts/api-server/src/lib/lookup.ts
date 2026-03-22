import axios from "axios";

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

const STORE_NAMES_TO_REMOVE =
  /\b(amazon|ebay|allegro|kaufland|walmart|target|costco|tesco|carrefour|auchan|lidl|aldi|biedronka|rossmann|dm|drogerie|media markt|saturn)\b/gi;

const WEIGHT_REGEX = /\b(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|cl|oz|lb|pieces?|szt|sztuk)\b/gi;

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
}

// ── Image URL extraction helpers ─────────────────────────────────────────────

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

  // 4. Direct image URL with extension on a non-Google domain
  const extRegex = /https?:\/\/(?!(?:www\.google|ssl\.gstatic|fonts\.gstatic|lh[0-9]\.googleusercontent))[^"'\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\s<>]{0,120})?/gi;
  let extMatch: RegExpExecArray | null;
  while ((extMatch = extRegex.exec(html)) !== null) {
    const url = extMatch[0];
    if (url.length < 400 && !url.includes("google.com")) {
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

// ── Google HTML search helpers ───────────────────────────────────────────────

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchGoogle(url: string, label: string, logs: string[], timeoutMs = 10000): Promise<string | null> {
  logs.push(`[${label}] GET ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        "User-Agent": CHROME_UA,
        Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    return resp.data as string;
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      logs.push(`[${label}] Timeout`);
    } else {
      logs.push(`[${label}] Error: ${e.message}`);
    }
    return null;
  }
}

async function searchGoogleImagesUrl(
  query: string,
  label: string,
  logs: string[],
  timeoutMs = 9000
): Promise<string | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&hl=pl`;
  const html = await fetchGoogle(url, label, logs, timeoutMs);
  if (!html) return null;
  return extractImageUrl(html, label, logs);
}

function extractNameFromGoogleHtml(html: string, label: string, logs: string[]): LookupResult | null {
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

  if (name) {
    logs.push(`[${label}] Name found: ${name}`);
    return { found: true, name, brand: null, weight, category: null, image: imgUrl, description: null, source: label.toLowerCase().replace(/[^a-z_/]/g, "_"), logs };
  }
  logs.push(`[${label}] No product name found`);
  return null;
}

// ── Structured source searches ───────────────────────────────────────────────

// Extract best image URL from OFF product object — tries many fallbacks
function extractOffImage(p: Record<string, unknown>, ean: string): string | null {
  // 1. Top-level standard fields (front image preferred)
  const direct =
    (p.image_front_url as string | null) ||
    (p.image_front_small_url as string | null) ||
    (p.image_url as string | null) ||
    (p.image_small_url as string | null);
  if (direct) return direct;

  // 2. selected_images — check ALL types (front, ingredients, nutrition, packaging)
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

  // 3. Top-level ingredient/nutrition image fields (fallback to any product photo)
  const anyPhoto =
    (p.image_ingredients_url as string | null) ||
    (p.image_ingredients_small_url as string | null) ||
    (p.image_nutrition_url as string | null) ||
    (p.image_nutrition_small_url as string | null) ||
    (p.image_packaging_url as string | null);
  if (anyPhoto) return anyPhoto;

  // 4. images dict — build URL from path + key
  const eanPath = buildOffEanPath(ean);
  const imgs = p.images as Record<string, unknown> | undefined;
  if (imgs && eanPath) {
    const BASE = "https://images.openfoodfacts.org/images/products";
    // Named types first (front > ingredients > nutrition)
    for (const prefix of ["front_en", "front_de", "front_fr", "front", "ingredients_en", "ingredients"]) {
      if (imgs[prefix]) return `${BASE}/${eanPath}/${prefix}.400.jpg`;
    }
    // Numbered images (image "1", "2", etc.)
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

async function searchOpenFoodFacts(ean: string, logs: string[]): Promise<LookupResult | null> {
  // Collect all found entries (name+image if possible)
  let bestWithImage: LookupResult | null = null;
  let bestWithoutImage: LookupResult | null = null;

  for (const region of OPEN_FOOD_FACTS_REGIONS) {
    const url = `https://${region}.openfoodfacts.org/api/v2/product/${ean}.json`;
    logs.push(`[OpenFoodFacts/${region}] ${url}`);
    try {
      const resp = await axios.get(url, {
        timeout: 6000,
        headers: { "User-Agent": "iPremiumScan/1.0" },
      });
      const data = resp.data;
      if (data.status === 1 && data.product) {
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
          logs.push(`[OpenFoodFacts/${region}] Found but no name — skipping`);
          continue;
        }

        const image = extractOffImage(p, ean);
        logs.push(`[OpenFoodFacts/${region}] Found: ${name}${image ? ` (image: ${image.slice(0, 60)})` : " (no image)"}`);

        const entry: LookupResult = {
          found: true,
          name,
          brand: (p.brands as string) || null,
          weight: (p.quantity as string) || null,
          category: p.categories ? (p.categories as string).split(",")[0].trim() : null,
          image,
          description: null,
          source: `openfoodfacts/${region}`,
          logs,
        };

        if (image && !bestWithImage) bestWithImage = entry;
        if (!bestWithoutImage) bestWithoutImage = entry;

        // If we have both name and image, return immediately
        if (image) return entry;
      } else {
        logs.push(`[OpenFoodFacts/${region}] status=${data.status}`);
      }
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; response?: { status?: number } };
      if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
        logs.push(`[OpenFoodFacts/${region}] Timeout`);
      } else if (e.response?.status === 404) {
        logs.push(`[OpenFoodFacts/${region}] 404`);
      } else {
        logs.push(`[OpenFoodFacts/${region}] Error: ${e.message}`);
      }
    }
  }

  return bestWithImage || bestWithoutImage || null;
}

async function searchUpcItemdb(ean: string, logs: string[]): Promise<LookupResult | null> {
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`;
  logs.push(`[UPCitemdb] ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "iPremiumScan/1.0" },
    });
    const data = resp.data;
    if (data.code === "OK" && data.items?.length > 0) {
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
    } else {
      logs.push(`[UPCitemdb] code=${data.code}`);
    }
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; response?: { status?: number } };
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      logs.push("[UPCitemdb] Timeout");
    } else if (e.response?.status === 429) {
      logs.push("[UPCitemdb] Rate limited");
    } else {
      logs.push(`[UPCitemdb] Error: ${e.message}`);
    }
  }
  return null;
}

// ── Google text searches for product name ────────────────────────────────────

async function googleTextSearch(query: string, label: string, logs: string[]): Promise<LookupResult | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const html = await fetchGoogle(url, label, logs);
  if (!html) return null;
  return extractNameFromGoogleHtml(html, label, logs);
}

// ── Main lookup ───────────────────────────────────────────────────────────────

export async function lookupEan(ean: string): Promise<LookupResult> {
  const logs: string[] = [`Szukam EAN: ${ean}`];

  // ── Phase 1: All sources run in parallel ──────────────────────────────────
  // Structured sources (name + image) and image-specific searches start together
  const [
    offResult,
    upcResult,
    imgEan,
    imgEanProduct,
    imgCeneo,
    imgAllegro,
  ] = await Promise.all([
    searchOpenFoodFacts(ean, logs).catch(() => null),
    searchUpcItemdb(ean, logs).catch(() => null),
    searchGoogleImagesUrl(ean, "GoogleImg/EAN", logs),
    searchGoogleImagesUrl(`${ean} produkt`, "GoogleImg/EAN+produkt", logs),
    searchGoogleImagesUrl(`site:ceneo.pl ${ean}`, "GoogleImg/Ceneo", logs),
    searchGoogleImagesUrl(`site:allegro.pl ${ean}`, "GoogleImg/Allegro", logs),
  ]);

  // Best name from structured sources
  const structuredResult = offResult || upcResult;

  // Best image: structured source first, then Google Images results
  const googleImage = imgEan || imgEanProduct || imgCeneo || imgAllegro || null;
  const structuredImage = offResult?.image || upcResult?.image || null;
  let image = structuredImage || googleImage;

  // ── Phase 2: If we have name but no image yet, search by name ────────────
  if (structuredResult?.name && !image) {
    logs.push(`[ImageHunt] Searching by name: ${structuredResult.name}`);
    image = await searchGoogleImagesUrl(structuredResult.name, "GoogleImg/Name", logs);
  }

  // Return early if structured sources found a name
  if (structuredResult) {
    if (image) logs.push(`[Result] Image: ${image.slice(0, 80)}`);
    return { ...structuredResult, image: image || null, logs };
  }

  // ── Phase 3: No structured result — Google text searches for name ─────────
  logs.push("[Phase3] Structured sources empty — trying Google text searches");

  const textSources = [
    { query: `${ean} produkt`, label: "Google/EAN+produkt" },
    { query: `site:allegro.pl ${ean}`, label: "Google/Allegro" },
    { query: `site:ceneo.pl ${ean}`, label: "Google/Ceneo" },
    { query: `site:barcodelookup.com ${ean}`, label: "Google/BarcodeDB" },
    { query: `site:ean-search.org ${ean}`, label: "Google/EANsearch" },
  ];

  for (const { query, label } of textSources) {
    const result = await googleTextSearch(query, label, logs);
    if (result?.name) {
      // Found a name — use it and any inline image or search for image by name
      image = image || result.image || null;
      if (!image) {
        logs.push(`[ImageHunt] Searching by name: ${result.name}`);
        image = await searchGoogleImagesUrl(result.name, "GoogleImg/Name2", logs);
      }
      if (image) logs.push(`[Result] Image: ${image.slice(0, 80)}`);
      return { ...result, image: image || null, logs };
    }
  }

  // ── Phase 4: Nothing found ────────────────────────────────────────────────
  logs.push("Nie znaleziono produktu w żadnym źródle");
  return { found: false, logs };
}
