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
  name: string | null;
  brand: string | null;
  /** Net weight/volume incl. unit, e.g. "500 g", "250 ml". */
  weight: string | null;
  flavor: string | null;
  ingredients: string | null;
  /** Country of origin/manufacture if printed on the pack. */
  country: string | null;
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
export async function extractProductFromImage(
  base64: string,
  mediaType: string,
): Promise<VisionExtract | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // disabled — never calls the paid API

  const mt = SUPPORTED_MEDIA.includes(mediaType) ? mediaType : "image/jpeg";

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
        max_tokens: 512,
        tools: [
          {
            name: "product_details",
            description: "Structured product data read off a food package photo.",
            input_schema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Product name as printed, WITHOUT the brand" },
                brand: { type: "string", description: "Brand / manufacturer" },
                weight: { type: "string", description: "Net weight or volume including unit, e.g. '500 g', '250 ml'" },
                flavor: { type: "string", description: "Flavour / variant if any" },
                ingredients: { type: "string", description: "Ingredients list if legible" },
                country: { type: "string", description: "Country of origin/manufacture if printed" },
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
              { type: "image", source: { type: "base64", media_type: mt, data: base64 } },
              {
                type: "text",
                text:
                  "Read the product details off this food package photo and call the product_details tool. " +
                  "Leave a field empty if it is not clearly legible. Do NOT guess or invent values.",
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
    const out: VisionExtract = {
      name: str("name"),
      brand: str("brand"),
      weight: str("weight"),
      flavor: str("flavor"),
      ingredients: str("ingredients"),
      country: str("country"),
    };
    // Need at least a name or brand to be useful.
    if (!out.name && !out.brand) return null;
    return out;
  } catch (err) {
    logger.warn({ err }, "vision: extraction failed");
    return null;
  }
}
