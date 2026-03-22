import { Router, type IRouter } from "express";
import axios from "axios";

const router: IRouter = Router();

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

interface LookupResult {
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

async function searchOpenFoodFacts(ean: string, logs: string[]): Promise<LookupResult | null> {
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
          category: p.categories
            ? p.categories.split(",")[0].trim()
            : null,
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

async function searchUpcItemdb(ean: string, logs: string[]): Promise<LookupResult | null> {
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

async function searchGoogle(ean: string, logs: string[]): Promise<LookupResult | null> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(ean + " product")}`;
  logs.push(`[Google] Trying ${url}`);
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
    });
    const html: string = resp.data;

    // Extract h3 tags
    const h3Matches = html.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
    const titles = h3Matches
      .map((m) => m.replace(/<[^>]+>/g, "").trim())
      .filter((t) => t.length > 3 && !t.toLowerCase().includes("google"))
      .map((t) => t.replace(STORE_NAMES_TO_REMOVE, "").trim())
      .filter((t) => t.length > 3);

    const name = titles[0] || null;

    // Extract weight from HTML
    const weightMatches = html.match(WEIGHT_REGEX);
    const weight = weightMatches ? weightMatches[0] : null;

    // Try to find an image URL
    const imgMatch = html.match(/https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*/i);
    const image = imgMatch ? imgMatch[0] : null;

    if (name) {
      logs.push(`[Google] Found: ${name}`);
      return {
        found: true,
        name,
        brand: null,
        weight,
        category: null,
        image,
        description: null,
        source: "google",
        logs,
      };
    } else {
      logs.push("[Google] No usable product name found in results");
    }
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      logs.push("[Google] Timeout");
    } else {
      logs.push(`[Google] Error: ${e.message}`);
    }
  }
  return null;
}

// GET /ping
router.get("/ping", (_req, res) => {
  res.json({ status: "ok" });
});

// GET /lookup?ean=...
router.get("/lookup", async (req, res) => {
  const ean = String(req.query.ean || "").trim();
  if (!ean) {
    res.status(400).json({ error: "bad_request", message: "Parametr 'ean' jest wymagany" });
    return;
  }

  const logs: string[] = [`Szukam EAN: ${ean}`];

  // Source 1: Open Food Facts
  const offResult = await searchOpenFoodFacts(ean, logs);
  if (offResult) {
    res.json(offResult);
    return;
  }

  // Source 2: UPCitemdb
  const upcResult = await searchUpcItemdb(ean, logs);
  if (upcResult) {
    res.json(upcResult);
    return;
  }

  // Source 3: Google
  const googleResult = await searchGoogle(ean, logs);
  if (googleResult) {
    res.json(googleResult);
    return;
  }

  logs.push("Nie znaleziono produktu w żadnym źródle");
  res.json({ found: false, logs });
});

export default router;
