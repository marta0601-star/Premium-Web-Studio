/**
 * Small text-only Claude helper for semantically matching a product to an
 * Allegro dictionary (enum) parameter — e.g. picking the right "Smak" / "Rodzaj"
 * option when the value on the pack is in PL/DE/EN/FR and plain string-fuzzy
 * matching fails. Used only as an enhancement AFTER the deterministic filler;
 * fully gated behind ANTHROPIC_API_KEY (no key → null, no network call, no cost).
 */

import { logger } from "./logger";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const LLM_MODEL = process.env.LLM_MATCH_MODEL || "claude-haiku-4-5-20251001";

export interface LlmOption {
  id: string;
  name: string;
}

export function isLlmEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Pull error.type / error.message out of a non-OK Anthropic response so the log
 * says WHY (credit, unknown model, bad key…) instead of a bare status. Never
 * throws; a non-JSON body (e.g. a proxy error page) is logged truncated.
 */
export async function anthropicErrorFields(
  resp: Response,
): Promise<{ errorType?: string; errorMessage?: string; requestId?: string }> {
  try {
    const text = await resp.text();
    try {
      const body = JSON.parse(text) as {
        error?: { type?: string; message?: string };
        request_id?: string;
      };
      return {
        errorType: body.error?.type,
        errorMessage: body.error?.message,
        requestId: body.request_id ?? resp.headers.get("request-id") ?? undefined,
      };
    } catch {
      return { errorMessage: text.slice(0, 300) };
    }
  } catch {
    return {};
  }
}

/**
 * Ask Claude to pick the single best-matching option id for a dictionary
 * parameter, or null when none fits. `productContext` should be a short
 * human-readable description (name, brand, category, ingredients…).
 */
export async function semanticPickOption(
  paramName: string,
  productContext: string,
  options: LlmOption[],
): Promise<{ id: string; valueLabel: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || options.length === 0) return null;

  // Bound the option list so the call stays cheap; most enums are small.
  const opts = options.slice(0, 80);
  const optionList = opts.map((o) => `${o.id} = ${o.name}`).join("\n");

  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 128,
        tools: [
          {
            name: "choose_option",
            description: "Choose the best matching dictionary option, or NONE.",
            input_schema: {
              type: "object",
              properties: {
                option_id: {
                  type: "string",
                  description: "The id of the best-matching option, or the literal 'NONE' if none fits.",
                },
              },
              required: ["option_id"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "choose_option" },
        messages: [
          {
            role: "user",
            content:
              `For a Polish Allegro listing, choose the dictionary option that best matches the product ` +
              `for the parameter "${paramName}". Match meaning across languages (PL/DE/EN/FR). ` +
              `Only choose an option you are confident about; otherwise answer NONE.\n\n` +
              `Product: ${productContext}\n\nOptions (id = label):\n${optionList}\n\n` +
              `Call choose_option with the best option_id, or 'NONE'.`,
          },
        ],
      }),
    });

    if (!resp.ok) {
      logger.warn(
        { status: resp.status, ...(await anthropicErrorFields(resp)) },
        "llm: semanticPickOption non-OK",
      );
      return null;
    }
    const data = (await resp.json()) as {
      content?: Array<{ type: string; input?: Record<string, unknown> }>;
    };
    const toolUse = data.content?.find((b) => b.type === "tool_use");
    const chosen = (toolUse?.input?.option_id as string | undefined)?.trim();
    if (!chosen || chosen.toUpperCase() === "NONE") return null;
    const match = opts.find((o) => o.id === chosen);
    if (!match) return null;
    return { id: match.id, valueLabel: match.name };
  } catch (err) {
    logger.warn({ err }, "llm: semanticPickOption failed");
    return null;
  }
}
