import { Router, type IRouter } from "express";
import axios from "axios";
import {
  startDeviceFlow,
  pollDeviceFlow,
  getPendingDeviceFlow,
  getUserTokenStatus,
  setUserToken,
  clearUserToken,
} from "../lib/allegro-auth";

const ALLEGRO_CLIENT_ID = process.env.ALLEGRO_CLIENT_ID!;
const ALLEGRO_CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET!;

const router: IRouter = Router();

/**
 * GET /api/auth/status
 * Returns whether a valid user token is available.
 */
router.get("/auth/status", (_req, res) => {
  const status = getUserTokenStatus();
  const pending = getPendingDeviceFlow();

  res.json({
    hasUserToken: status.hasToken,
    tokenExpiresInMs: status.expiresInMs ?? null,
    tokenScopes: status.scopes ?? null,
    hasPendingDeviceFlow: !!pending,
    pendingUserCode: pending?.userCode ?? null,
    pendingVerificationUri: pending?.verificationUri ?? null,
    pendingExpiresAt: pending ? pending.expiresAt : null,
  });
});

/**
 * POST /api/auth/device/start
 * Initiates Allegro Device Flow. Returns user_code + verification_uri.
 * NOTE: Requires Device Flow to be enabled for the app in Allegro Developer Portal.
 */
router.post("/auth/device/start", async (_req, res) => {
  try {
    const flow = await startDeviceFlow();
    res.json({
      message: "Device flow started. Open the verification URL and enter the user code.",
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      verificationUriComplete: flow.verificationUriComplete,
      expiresIn: flow.expiresIn,
      pollIntervalSeconds: flow.interval,
      nextStep: "Call POST /api/auth/device/poll every " + flow.interval + "s until status=authorized",
    });
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { status?: number; data?: unknown } };
    res.status(500).json({
      error: "device_flow_failed",
      message: e.message,
      details: e.response?.data,
    });
  }
});

/**
 * POST /api/auth/device/poll
 * Polls Allegro for the token. Call every `interval` seconds until status=authorized.
 */
router.post("/auth/device/poll", async (_req, res) => {
  try {
    const result = await pollDeviceFlow();
    res.json(result);
  } catch (err: unknown) {
    const e = err as { message?: string };
    res.status(500).json({ error: "poll_failed", message: e.message });
  }
});

/**
 * GET /api/auth/allegro/authorize
 * Redirects user to Allegro OAuth authorization page (Authorization Code Flow).
 * The redirect_uri must be registered in the Allegro Developer Portal.
 */
router.get("/auth/allegro/authorize", (req, res) => {
  const redirectUri = buildRedirectUri(req);
  const url = new URL("https://allegro.pl/auth/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ALLEGRO_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("prompt", "confirm");

  res.json({
    authUrl: url.toString(),
    redirectUri,
    instructions: [
      "1. Zarejestruj redirect URI w Allegro Developer Portal:",
      `   ${redirectUri}`,
      "2. Otwórz authUrl w przeglądarce i zaakceptuj uprawnienia.",
      "3. Zostaniesz przekierowany z powrotem — token zostanie zapisany automatycznie.",
    ],
  });
});

/**
 * GET /api/auth/allegro/callback
 * OAuth callback endpoint — exchanges code for tokens and stores them.
 * Register this URI in Allegro Developer Portal:
 *   https://<your-domain>/api/auth/allegro/callback
 */
router.get("/auth/allegro/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    res.status(400).send(`
      <html><body style="font-family:monospace;background:#111;color:#fff;padding:40px">
        <h2 style="color:#f55">Autoryzacja odrzucona</h2>
        <p>Błąd: ${error}</p>
        <p>Opis: ${req.query.error_description || "brak"}</p>
        <p><a href="/" style="color:#7c3aed">← Wróć do aplikacji</a></p>
      </body></html>
    `);
    return;
  }

  if (!code) {
    res.status(400).send("Brakuje parametru 'code'");
    return;
  }

  const redirectUri = buildRedirectUri(req);

  try {
    const credentials = Buffer.from(`${ALLEGRO_CLIENT_ID}:${ALLEGRO_CLIENT_SECRET}`).toString("base64");

    const tokenResp = await axios.post(
      "https://allegro.pl/auth/oauth/token",
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
      token_type?: string;
    };

    setUserToken(data.access_token, data.refresh_token, data.expires_in, data.scope);

    const scopes = data.scope ? data.scope.split(" ") : [];

    res.send(`
      <html><body style="font-family:monospace;background:#111;color:#fff;padding:40px;text-align:center">
        <h2 style="color:#22c55e;font-size:32px">✓ Autoryzacja zakończona sukcesem!</h2>
        <p style="color:#aaa;margin:16px 0">Token użytkownika Allegro został zapisany.</p>
        <p style="color:#888;font-size:13px">Uprawnienia: ${scopes.join(", ") || "nieznane"}</p>
        <p style="color:#888;font-size:13px">Wygasa za: ${Math.round(data.expires_in / 3600)} godzin</p>
        <div style="margin-top:32px">
          <a href="/" style="background:#7c3aed;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:16px">
            → Wróć do iPremium Scan
          </a>
        </div>
        <script>setTimeout(()=>window.location.href='/',3000)</script>
      </body></html>
    `);
  } catch (err: unknown) {
    const e = err as { message?: string; response?: { data?: unknown } };
    res.status(500).send(`
      <html><body style="font-family:monospace;background:#111;color:#f55;padding:40px">
        <h2>Błąd wymiany kodu na token</h2>
        <p>${e.message}</p>
        <pre style="color:#aaa;font-size:12px">${JSON.stringify(e.response?.data, null, 2)}</pre>
        <p><a href="/" style="color:#7c3aed">← Wróć do aplikacji</a></p>
      </body></html>
    `);
  }
});

/**
 * DELETE /api/auth/user-token
 * Clears the stored user token (logout).
 */
router.delete("/auth/user-token", (_req, res) => {
  clearUserToken();
  res.json({ message: "Token usunięty" });
});

function buildRedirectUri(req: import("express").Request): string {
  const host = req.get("host") || "localhost";
  const protocol = host.includes("replit") || host.includes(".app") ? "https" : req.protocol;
  return `${protocol}://${host}/api/auth/allegro/callback`;
}

export default router;
