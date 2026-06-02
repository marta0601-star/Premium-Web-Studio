/**
 * Photo → product-data extraction via a vision LLM (Anthropic Claude).
 *
 * This is the FALLBACK for when EAN lookup misses entirely (product not in the
 * Allegro catalog, OpenFoodFacts, UPCitemDB, …) — common for the long tail of
 * imported DE/FR sweets/coffee. The package photo is sent to Claude, which
 * returns structured fields that feed the SAME parameter-filler pipeline as
 * every other source, so the result is confirmed-by-exception in the UI just
 * like an OFF/catalog hit (no separate trust path, no auto-submit).
 *
 * COST / SAFETY: this calls a PAID API. It is gated entirely behind the
 * ANTHROPIC_API_KEY env var — if that is unset the feature is OFF and
 * extractProductFromImage() returns null without making any network call, so
 * there is zero cost until the operator opts in by setting the key.
 */

import { logger } from "./logger";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Haiku is cheap and good enough for legible package OCR; override via env.
const VISION_MODEL = process.env.VISION_MODEL || "claude-haiku-4-5-20251001";
const SUPPORTED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export interface VisionExtract {
  brand: string | null;
  /** Product name WITHOUT the brand. */
  name: string | null;
  /** Net weight in grams (converted from kg if needed); null if not legible. */
  net_weight_g: number | null;
  flavor: string | null;
  ingredients: string[];
  /** Country of MANUFACTURE from the back of pack; null if absent. */
  country_of_origin: string | null;
  /** Short free-text product type, e.g. "ground coffee", "gummy candy". */
  category_hint: string | null;
}

export interface VisionImage {
  /** base64-encoded image bytes (no data: prefix). */
  data: string;
  mediaType: string;
}

/** True when a key is configured — used to gate the route and the UI affordance. */
export function isVisionEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Extract product fields from a base64 package photo. Returns null when the
 * feature is disabled, the API errors, or nothing usable was read — callers
 * treat null as "couldn't recognise, fall back to manual entry".
 */
export async function extractProductFromImages(
  images: VisionImage[],
): Promise<VisionExtract | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // disabled — never calls the paid API
  if (!images.length) return null;

  const imageBlocks = images.slice(0, 4).map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: SUPPORTED_MEDIA.includes(img.mediaType) ? img.mediaType : "image/jpeg",
      data: img.data,
    },
  }));

  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 1024,
        tools: [
          {
            name: "product_details",
            description: "Structured product data read off food package photos (front + back).",
            input_schema: {
              type: "object",
              properties: {
                brand: { type: "string", description: "Brand / manufacturer" },
                name: { type: "string", description: "Product name as printed, WITHOUT the brand" },
                net_weight_g: {
                  type: "number",
                  description:
                    "Net weight in GRAMS. Convert kg→g (×1000). For liquids give the ml number. null if not legible.",
                },
                flavor: { type: "string", description: "Flavour / variant if any" },
                ingredients: {
                  type: "array",
                  items: { type: "string" },
                  description: "Ingredients, one per array item, if legible (usually on the back).",
                },
                country_of_origin: {
                  type: "string",
                  description:
                    "Country of MANUFACTURE from the back of pack ('Wyprodukowano w' / 'Hergestellt in' / manufacturer address). null if absent.",
                },
                category_hint: {
                  type: "string",
                  description: "Short product type, e.g. 'milk chocolate', 'gummy candy', 'ground coffee'.",
                },
              },
              required: [],
            },
          },
        ],
        tool_choice: { type: "tool", name: "product_details" },
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              {
                type: "text",
                text:
                  "These photos show the FRONT and BACK of one food package. Read its details and call the " +
                  "product_details tool. Weight, ingredients and country of manufacture are usually on the BACK. " +
                  "Leave a field empty/null if it is not clearly legible. Do NOT guess or invent values.",
              },
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "vision: Anthropic API returned non-OK");
      return null;
    }

    const data = (await resp.json()) as {
      content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
    };
    const toolUse = data.content?.find((b) => b.type === "tool_use");
    const inp = (toolUse?.input ?? {}) as Record<string, unknown>;
    const str = (k: string): string | null => {
      const v = inp[k];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const num = (k: string): number | null => {
      const v = inp[k];
      if (typeof v === "number" && isFinite(v) && v > 0) return Math.round(v);
      if (typeof v === "string") {
        const n = parseFloat(v.replace(",", "."));
        return isFinite(n) && n > 0 ? Math.round(n) : null;
      }
      return null;
    };
    const ingredients = Array.isArray(inp.ingredients)
      ? (inp.ingredients as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];

    const out: VisionExtract = {
      brand: str("brand"),
      name: str("name"),
      net_weight_g: num("net_weight_g"),
      flavor: str("flavor"),
      ingredients,
      country_of_origin: str("country_of_origin"),
      category_hint: str("category_hint"),
    };
    // Need at least a name or brand to be useful.
    if (!out.name && !out.brand) return null;
    return out;
  } catch (err) {
    logger.warn({ err }, "vision: extraction failed");
    return null;
  }
}
