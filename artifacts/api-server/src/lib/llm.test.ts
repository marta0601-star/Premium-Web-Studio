import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "./logger";
import { semanticPickOption } from "./llm";
import { extractProductFromImages } from "./vision";

// The real body Anthropic returned from the live container on 2026-10-28.
const CREDIT_BODY = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  request_id: "req_011CgTzJ2mTh3jpCm7FbKRRk",
};

function stubFetch(status: number, body: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers: { "content-type": "application/json" } })),
  );
}

describe("Anthropic non-OK logging", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("semanticPickOption logs error.type + error.message and still returns null", async () => {
    stubFetch(400, JSON.stringify(CREDIT_BODY));
    const out = await semanticPickOption("Smak", "Milka", [{ id: "1", name: "czekoladowy" }]);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      {
        status: 400,
        errorType: "invalid_request_error",
        errorMessage: CREDIT_BODY.error.message,
        requestId: CREDIT_BODY.request_id,
      },
      "llm: semanticPickOption non-OK",
    );
  });

  it("vision logs error.type + error.message and still returns null", async () => {
    stubFetch(400, JSON.stringify(CREDIT_BODY));
    const out = await extractProductFromImages([{ data: "AAAA", mediaType: "image/jpeg" }]);
    expect(out).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        errorType: "invalid_request_error",
        errorMessage: CREDIT_BODY.error.message,
      }),
      "vision: Anthropic API returned non-OK",
    );
  });

  it("a non-JSON error body is logged truncated instead of throwing", async () => {
    stubFetch(502, "<html>" + "x".repeat(1000) + "</html>");
    const out = await semanticPickOption("Smak", "Milka", [{ id: "1", name: "czekoladowy" }]);
    expect(out).toBeNull();
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields.status).toBe(502);
    expect(fields.errorType).toBeUndefined();
    expect(String(fields.errorMessage)).toHaveLength(300);
  });
});
