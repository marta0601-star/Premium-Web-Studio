import { Router, type IRouter } from "express";
import axios from "axios";
import { getClientCredentialsToken } from "../lib/allegro";
import { getUserToken, getUserTokenStatus } from "../lib/allegro-auth";

const router: IRouter = Router();

router.get("/debug/allegro-token", async (req, res) => {
  const result: Record<string, unknown> = { steps: [] as string[] };
  const steps = result.steps as string[];

  const clientId = process.env.ALLEGRO_CLIENT_ID;
  const clientSecret = process.env.ALLEGRO_CLIENT_SECRET;

  result.hasClientId = !!clientId;
  result.hasClientSecret = !!clientSecret;
  result.clientIdPrefix = clientId ? clientId.slice(0, 8) + "..." : null;

  if (!clientId || !clientSecret) {
    steps.push("ERROR: Missing ALLEGRO_CLIENT_ID or ALLEGRO_CLIENT_SECRET");
    res.status(500).json(result);
    return;
  }

  steps.push("Credentials present — requesting token...");

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const tokenResp = await axios.post(
      "https://allegro.pl/auth/oauth/token?grant_type=client_credentials",
      {},
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    const data = tokenResp.data as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
    };

    steps.push(`Token acquired — type: ${data.token_type}, expires_in: ${data.expires_in}s`);

    // Decode JWT payload without verifying signature (for inspection only)
    let jwtPayload: Record<string, unknown> | null = null;
    if (data.access_token) {
      try {
        const payloadB64 = data.access_token.split(".")[1];
        jwtPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
      } catch {
        steps.push("Could not decode JWT payload");
      }
    }

    result.tokenType = data.token_type;
    result.expiresIn = data.expires_in;
    result.tokenPrefix = data.access_token ? data.access_token.slice(0, 20) + "..." : null;
    result.scope = data.scope || jwtPayload?.scope || null;
    result.jwtScopes = jwtPayload?.scope || null;
    result.jwtClientId = jwtPayload?.client_id || null;
    result.jwtIssuer = jwtPayload?.iss || null;

    steps.push(`Scopes granted: ${JSON.stringify(jwtPayload?.scope || data.scope || "unknown")}`);
    steps.push("Token OK");
    result.ok = true;

    res.json(result);
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      response?: { status?: number; data?: unknown };
    };
    steps.push(`Token request FAILED: ${e.message}`);
    result.error = e.message;
    result.httpStatus = e.response?.status;
    result.responseBody = e.response?.data;
    result.ok = false;
    res.status(500).json(result);
  }
});

router.get("/debug/allegro-search/:ean", async (req, res) => {
  const { ean } = req.params;
  const results: Record<string, unknown> = {
    ean,
    timestamp: new Date().toISOString(),
    attempts: [] as unknown[],
  };
  const attempts = results.attempts as Array<Record<string, unknown>>;

  // Try user token first (Device Flow) — has catalog scope
  // Fall back to client credentials for comparison
  const userStatus = getUserTokenStatus();
  results.userTokenAvailable = userStatus.hasToken;
  results.userTokenScopes = userStatus.scopes ?? null;

  let token: string;
  let tokenSource: string;

  if (userStatus.hasToken) {
    try {
      token = await getUserToken();
      tokenSource = "device_flow_user_token";
    } catch {
      token = await getClientCredentialsToken();
      tokenSource = "client_credentials_fallback";
    }
  } else {
    token = await getClientCredentialsToken();
    tokenSource = "client_credentials_only";
  }

  results.tokenSource = tokenSource;
  results.tokenPrefix = token.slice(0, 20) + "...";

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.allegro.public.v1+json",
  };

  const searches: Array<{ label: string; params: Record<string, string> }> = [
    { label: "phrase search", params: { phrase: ean, language: "pl-PL" } },
    { label: "filters.EAN", params: { "filters.EAN": ean, language: "pl-PL" } },
    { label: "filters.GTIN", params: { "filters.GTIN": ean, language: "pl-PL" } },
    { label: "ean param (original)", params: { ean, language: "pl-PL" } },
  ];

  for (const search of searches) {
    const attempt: Record<string, unknown> = {
      label: search.label,
      params: search.params,
    };

    const queryString = new URLSearchParams(search.params as Record<string, string>).toString();
    const url = `https://api.allegro.pl/sale/products?${queryString}`;
    attempt.url = url;

    try {
      const resp = await axios.get(url, { headers, timeout: 10000 });
      attempt.httpStatus = resp.status;
      attempt.responseData = resp.data;
      const data = resp.data as { products?: unknown[]; totalCount?: number };
      attempt.productsFound = data.products?.length ?? 0;
      attempt.totalCount = data.totalCount ?? 0;
      attempt.success = true;
    } catch (err: unknown) {
      const e = err as {
        message?: string;
        response?: { status?: number; data?: unknown };
      };
      attempt.httpStatus = e.response?.status;
      attempt.responseData = e.response?.data;
      attempt.error = e.message;
      attempt.success = false;
    }

    attempts.push(attempt);

    const last = attempts[attempts.length - 1] as { success?: boolean; productsFound?: number };
    if (last.success && (last.productsFound ?? 0) > 0) {
      results.foundWithMethod = search.label;
      break;
    }
  }

  if (!userStatus.hasToken) {
    results.note =
      "Using CLIENT CREDENTIALS token — catalog search requires a USER token. " +
      "Call POST /api/auth/device/start to begin Device Flow authorization.";
  }

  res.json(results);
});

export default router;
