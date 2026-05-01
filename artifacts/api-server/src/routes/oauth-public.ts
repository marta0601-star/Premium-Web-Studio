/**
 * Public Allegro OAuth router (authorization_code grant).
 *
 * Mounted OUTSIDE /api so the password gate cannot intercept the redirect
 * coming back from allegro.pl — Allegro authorization codes expire in ~60 s
 * and any extra hop (re-login, SPA boot) used to burn that window.
 *
 *   GET /auth/allegro/login
 *     Generates a CSRF state token, stores it in the cookie-session, and
 *     302-redirects the browser to https://allegro.pl/auth/oauth/authorize.
 *
 *   GET /auth/allegro/callback
 *     Allegro redirects here with ?code=…&state=…. We verify state against
 *     the session, exchange the code for access + refresh tokens, persist
 *     them via setUserToken (which writes tokens.json), and 302-redirect
 *     back to "/" with ?allegro_auth=success|error.
 *
 * The redirect URI registered in the Allegro Developer Portal MUST match
 * exactly what buildRedirectUri() returns (host-derived or env override).
 */
import { Router, type IRouter, type Request } from "express";
import axios from "axios";
import crypto from "crypto";
import { setUserToken } from "../lib/allegro-auth";
import { logger } from "../lib/logger";

const ALLEGRO_CLIENT_ID = process.env.ALLEGRO_CLIENT_ID!;
const ALLEGRO_CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET!;

const AUTHORIZE_URL = "https://allegro.pl/auth/oauth/authorize";
const TOKEN_URL = "https://allegro.pl/auth/oauth/token";

// Scopes registered in the Allegro Developer Portal for this app. Sending
// them explicitly avoids surprises if the portal config is later widened.
const REQUESTED_SCOPES = [
  "allegro:api:sale:offers:read",
  "allegro:api:sale:offers:write",
  "allegro:api:sale:settings:read",
  "allegro:api:sale:settings:write",
];

function buildRedirectUri(req: Request): string {
  if (process.env.ALLEGRO_REDIRECT_URI) return process.env.ALLEGRO_REDIRECT_URI;
  const host = req.get("host") || "localhost";
  const protocol =
    host.includes("replit") || host.includes(".app") ? "https" : req.protocol;
  return `${protocol}://${host}/auth/allegro/callback`;
}

const router: IRouter = Router();

router.get("/auth/allegro/login", (req, res) => {
  if (!ALLEGRO_CLIENT_ID || !ALLEGRO_CLIENT_SECRET) {
    res.status(500).send("Allegro client credentials are not configured.");
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  if (req.session) {
    req.session.allegroOAuthState = state;
  }

  const redirectUri = buildRedirectUri(req);
  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", ALLEGRO_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", REQUESTED_SCOPES.join(" "));
  authUrl.searchParams.set("prompt", "confirm");

  logger.info({ redirectUri }, "Starting Allegro OAuth authorize flow");
  res.redirect(authUrl.toString());
});

router.get("/auth/allegro/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state =
    typeof req.query.state === "string" ? req.query.state : undefined;
  const oauthError =
    typeof req.query.error === "string" ? req.query.error : undefined;

  // Pull and consume the expected state regardless of outcome — it must not
  // survive into a second attempt.
  const expectedState = req.session?.allegroOAuthState as string | undefined;
  if (req.session) {
    req.session.allegroOAuthState = undefined;
  }

  if (oauthError) {
    logger.warn({ oauthError }, "Allegro returned OAuth error on callback");
    res.redirect(`/?allegro_auth=error&reason=${encodeURIComponent(oauthError)}`);
    return;
  }

  if (!code) {
    res.redirect("/?allegro_auth=error&reason=missing_code");
    return;
  }

  if (!state || !expectedState || state !== expectedState) {
    logger.warn(
      { hasState: !!state, hasExpected: !!expectedState, match: state === expectedState },
      "Allegro OAuth state mismatch"
    );
    res.redirect("/?allegro_auth=error&reason=invalid_state");
    return;
  }

  const redirectUri = buildRedirectUri(req);

  try {
    const credentials = Buffer.from(
      `${ALLEGRO_CLIENT_ID}:${ALLEGRO_CLIENT_SECRET}`
    ).toString("base64");

    const tokenResp = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    const data = tokenResp.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };

    setUserToken(
      data.access_token,
      data.refresh_token,
      data.expires_in,
      data.scope
    );

    logger.info(
      { expiresIn: data.expires_in, scope: data.scope },
      "Allegro OAuth code exchanged successfully"
    );
    res.redirect("/?allegro_auth=success");
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      response?: { status?: number; data?: unknown };
    };
    logger.error(
      { msg: e.message, status: e.response?.status, data: e.response?.data },
      "Allegro OAuth code exchange failed"
    );
    res.redirect("/?allegro_auth=error&reason=exchange_failed");
  }
});

export default router;
