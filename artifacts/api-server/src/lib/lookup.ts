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

export async function searchOpenFoodFacts(ean: string, logs: string[]): Promise<LookupResult | null> {
  for (const region of OPEN_FOOD_FACTS_REGIONS) {
    const url = `https://${region}.openfoodfacts.org/api/v2/product/${ean}.json`;
    logs.push(`[OpenFoodFacts/${region}] Trying ${url}`);
    try {
      const resp = await axios.get(url, {
        timeout: 6000,
        headers: { "User-Agent": "iPremiumScan/1.0" },
      });
      const data = resp.data;
      if (data.status === 1 && data.product) {
        const p = data.product;
        const name =
          p.product_name ||
          p.product_name_pl ||
          p.product_name_de ||
          p.product_name_en ||
          p.product_name_fr ||
          p.product_name_sk ||
          null;

        if (!name) {
          logs.push(`[OpenFoodFacts/${region}] Product found but no name — skipping`);
          continue;
        }

        logs.push(`[OpenFoodFacts/${region}] Found: ${name}`);
        return {
          found: true,
          name,
          brand: p.brands || null,
          weight: p.quantity || null,
          category: p.categories ? p.categories.split(",")[0].trim() : null,
          image: p.image_front_url || null,
          description: null,
          source: `openfoodfacts/${region}`,
          logs,
        };
      } else {
        logs.push(`[OpenFoodFacts/${region}] Not found (status=${data.status})`);
      }
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string; response?: { status?: number } };
      if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
        logs.push(`[OpenFoodFacts/${region}] Timeout`);
      } else if (e.response?.status === 404) {
        logs.push(`[OpenFoodFacts/${region}] Not found (404)`);
      } else {
        logs.push(`[OpenFoodFacts/${region}] Error: ${e.message}`);
      }
    }
  }
  return null;
}

export async function searchUpcItemdb(ean: string, logs: string[]): Promise<LookupResult | null> {
  const url = `https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`;
  logs.push(`[UPCitemdb] Trying ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "iPremiumScan/1.0" },
    });
    const data = resp.data;
    if (data.code === "OK" && data.items && data.items.length > 0) {
      const item = data.items[0];
      if (!item.title) {
        logs.push("[UPCitemdb] Item found but no title — skipping");
        return null;
      }
      logs.push(`[UPCitemdb] Found: ${item.title}`);
      return {
        found: true,
        name: item.title || null,
        brand: item.brand || null,
        weight: item.weight || null,
        category: item.category || null,
        image: item.images?.[0] || null,
        description: item.description || null,
        source: "upcitemdb",
        logs,
      };
    } else {
      logs.push(`[UPCitemdb] Not found (code=${data.code})`);
    }
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; response?: { status?: number } };
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      logs.push("[UPCitemdb] Timeout");
    } else if (e.response?.status === 429) {
      logs.push("[UPCitemdb] Rate limited (429)");
    } else {
      logs.push(`[UPCitemdb] Error: ${e.message}`);
    }
  }
  return null;
}

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function extractFromGoogleHtml(
  html: string,
  label: string,
  logs: string[],
  source: string
): LookupResult | null {
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

  const imgMatch = html.match(/https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*/i);
  const image = imgMatch ? imgMatch[0] : null;

  if (name) {
    logs.push(`[${label}] Found: ${name}`);
    return { found: true, name, brand: null, weight, category: null, image, description: null, source, logs };
  }
  logs.push(`[${label}] No usable product name found in results`);
  return null;
}

async function googleSearch(
  query: string,
  label: string,
  source: string,
  logs: string[],
  timeoutMs = 10000
): Promise<LookupResult | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  logs.push(`[${label}] Trying ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: timeoutMs,
      headers: { "User-Agent": CHROME_UA, Accept: "text/html" },
    });
    return extractFromGoogleHtml(resp.data as string, label, logs, source);
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

export async function searchGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  return googleSearch(`${ean} product`, "Google", "google", logs);
}

export async function searchAllegroGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  return googleSearch(`site:allegro.pl ${ean}`, "Allegro/Google", "allegro_google", logs);
}

export async function searchCeneoGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  return googleSearch(`site:ceneo.pl ${ean}`, "Ceneo/Google", "ceneo_google", logs);
}

export async function searchBarcodeLookupGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  return googleSearch(`site:barcodelookup.com ${ean}`, "BarcodeLookup/Google", "barcodelookup_google", logs);
}

export async function searchEanSearchGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  return googleSearch(`site:ean-search.org ${ean}`, "EAN-Search/Google", "ean_search_google", logs);
}

export async function lookupEan(ean: string): Promise<LookupResult> {
  const logs: string[] = [`Szukam EAN: ${ean}`];

  const off = await searchOpenFoodFacts(ean, logs);
  if (off) return off;

  const upc = await searchUpcItemdb(ean, logs);
  if (upc) return upc;

  const google = await searchGoogle(ean, logs);
  if (google) return google;

  const allegroG = await searchAllegroGoogle(ean, logs);
  if (allegroG) return allegroG;

  const ceneo = await searchCeneoGoogle(ean, logs);
  if (ceneo) return ceneo;

  const barcode = await searchBarcodeLookupGoogle(ean, logs);
  if (barcode) return barcode;

  const eanSearch = await searchEanSearchGoogle(ean, logs);
  if (eanSearch) return eanSearch;

  logs.push("Nie znaleziono produktu w żadnym źródle");
  return { found: false, logs };
}
