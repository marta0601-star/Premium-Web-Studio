/**
 * Allegro Device Flow authentication
 *
 * Client Credentials only grants: sale:offers:*, sale:settings:*
 * Catalog search (/sale/products) requires a USER token obtained via Device Flow.
 *
 * One-time flow:
 *   1. POST /auth/oauth/device  → get device_code + user_code
 *   2. User visits verification_uri and approves
 *   3. Poll POST /auth/oauth/token until approved → store access_token + refresh_token
 *   4. Refresh automatically when 80% of token lifetime has elapsed
 *
 * 401 handling:
 *   An axios interceptor (setupAllegroAxiosInterceptor) catches 401s from the
 *   Allegro REST API, proactively refreshes the token, and retries the request
 *   once.  If the refresh_token is expired (invalid_grant), the user token is
 *   cleared and the frontend's auth status poll will prompt re-authorisation.
 */

import axios from "axios";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

const ALLEGRO_CLIENT_ID = process.env.ALLEGRO_CLIENT_ID!;
const ALLEGRO_CLIENT_SECRET = process.env.ALLEGRO_CLIENT_SECRET!;

const TOKEN_URL = "https://allegro.pl/auth/oauth/token";
const DEVICE_URL = "https://allegro.pl/auth/oauth/device";

// Persist tokens to this file so they survive server restarts
const TOKEN_FILE = path.resolve(
  process.env.TOKEN_STORE_PATH || path.join(process.cwd(), "tokens.json")
);

// Legacy path — migrate automatically on first load
const TOKEN_FILE_LEGACY = path.resolve(path.join(process.cwd(), ".allegro-token.json"));

// Allegro tokens typically last 43 200 seconds (12 h).  Used as a fallback
// when loading a token that was persisted before issuedAt was added.
const DEFAULT_ALLEGRO_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

interface UserTokenStore {
  accessToken: string;
  refreshToken: string;
  issuedAt: number;   // ms since epoch — when the token was issued/refreshed
  expiresAt: number;  // ms since epoch
  scopes: string[];
}

// Set to true when a refresh attempt fails with invalid_grant (refresh token expired)
// so the caller knows re-auth is needed without attempting another refresh.
let refreshTokenExpired = false;

// Load from disk on startup — also migrates from old filename
function loadTokenFromDisk(): UserTokenStore | null {
  const filesToTry = [TOKEN_FILE, TOKEN_FILE_LEGACY];
  for (const file of filesToTry) {
    try {
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, "utf-8");
        const data = JSON.parse(raw) as Partial<UserTokenStore>;
        if (data.accessToken && data.refreshToken && data.expiresAt) {
          // Back-fill issuedAt for tokens saved before this field existed
          const issuedAt = data.issuedAt ?? (data.expiresAt - DEFAULT_ALLEGRO_TOKEN_LIFETIME_MS);
          const store: UserTokenStore = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            issuedAt,
            expiresAt: data.expiresAt,
            scopes: data.scopes ?? [],
          };
          logger.info(
            { file, expiresAt: new Date(store.expiresAt).toISOString() },
            "Allegro user token loaded from disk"
          );
          // Migrate legacy file to new path
          if (file !== TOKEN_FILE) {
            try {
              fs.writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), "utf-8");
              fs.unlinkSync(file);
              logger.info({ from: file, to: TOKEN_FILE }, "Migrated token file to tokens.json");
            } catch { /* ignore migration errors */ }
          }
          return store;
        }
      }
    } catch (e) {
      logger.warn({ err: e, file }, "Could not load Allegro token from disk");
    }
  }
  return null;
}

function saveTokenToDisk(token: UserTokenStore | null): void {
  try {
    if (token) {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), "utf-8");
    } else {
      if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
    }
  } catch (e) {
    logger.warn({ err: e }, "Could not save Allegro token to disk");
  }
}

// In-memory store — initialised from disk
let userToken: UserTokenStore | null = loadTokenFromDisk();

// In-progress device flow state
interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  interval: number;
  polling: boolean;
}

let pendingDeviceFlow: DeviceFlowState | null = null;

// Guard against concurrent refresh attempts
let refreshInProgress: Promise<void> | null = null;

function getBasicCredentials(): string {
  return Buffer.from(`${ALLEGRO_CLIENT_ID}:${ALLEGRO_CLIENT_SECRET}`).toString("base64");
}

// ── Token access ────────────────────────────────────────────────────────────

export function getUserTokenStatus(): {
  hasToken: boolean;
  needsReAuth: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  scopes?: string[];
  accessTokenPrefix?: string;
} {
  if (!userToken) return { hasToken: false, needsReAuth: refreshTokenExpired };
  return {
    hasToken: true,
    needsReAuth: false,
    expiresAt: userToken.expiresAt,
    expiresInMs: userToken.expiresAt - Date.now(),
    scopes: userToken.scopes,
    accessTokenPrefix: userToken.accessToken.slice(0, 20) + "...",
  };
}

/**
 * Refresh the user token using the stored refresh_token.
 * Throws if the refresh_token is expired (invalid_grant) — in that case
 * the user token is cleared and needsReAuth is set to true.
 */
async function refreshAccessToken(): Promise<void> {
  if (!userToken?.refreshToken) throw new Error("No refresh token available");

  logger.info("Refreshing Allegro user token...");
  try {
    const resp = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: userToken.refreshToken,
      }),
      {
        headers: {
          Authorization: `Basic ${getBasicCredentials()}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    const data = resp.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    let scopes: string[] = [];
    if (data.scope) {
      scopes = data.scope.split(" ");
    } else if (userToken) {
      scopes = userToken.scopes;
    }

    const now = Date.now();
    userToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || userToken!.refreshToken,
      issuedAt: now,
      expiresAt: now + data.expires_in * 1000,
      scopes,
    };

    refreshTokenExpired = false;
    saveTokenToDisk(userToken);
    logger.info(
      { expiresAt: new Date(userToken.expiresAt).toISOString() },
      "Allegro user token refreshed"
    );
  } catch (err: unknown) {
    const e = err as { response?: { data?: { error?: string } }; message?: string };
    const errCode = e.response?.data?.error;

    // invalid_grant means the refresh token has expired — user must re-authorise
    if (errCode === "invalid_grant" || errCode === "invalid_token") {
      logger.warn({ errCode }, "Allegro refresh token expired — user must re-authorise");
      refreshTokenExpired = true;
      userToken = null;
      saveTokenToDisk(null);
      throw new Error("ALLEGRO_REFRESH_TOKEN_EXPIRED");
    }

    logger.error({ err: e.message, errCode }, "Failed to refresh Allegro token");
    throw err;
  }
}

/**
 * How early to refresh the token — when 80% of its lifetime has elapsed
 * (i.e. 20% of lifetime remains).  For a 12-hour token that is 2.4 hours.
 * Floor: never wait until there is less than 5 minutes left.
 */
function shouldRefresh(token: UserTokenStore): boolean {
  const now = Date.now();
  const lifetime = token.expiresAt - token.issuedAt;
  const refreshAt = token.issuedAt + lifetime * 0.8;
  const fiveMinutes = 5 * 60 * 1000;
  // Trigger if 80% elapsed OR within 5 minutes of expiry (whichever is first)
  return now >= refreshAt || now >= token.expiresAt - fiveMinutes;
}

export async function getUserToken(): Promise<string> {
  if (!userToken) {
    throw new Error(
      "No user token available. Complete Device Flow at GET /api/auth/device/start"
    );
  }

  if (shouldRefresh(userToken)) {
    const lifetimePct = Math.round(
      ((Date.now() - userToken.issuedAt) / (userToken.expiresAt - userToken.issuedAt)) * 100
    );
    logger.info(
      {
        expiresAt: new Date(userToken.expiresAt).toISOString(),
        lifetimeElapsedPct: lifetimePct,
      },
      "Token refresh threshold reached — refreshing automatically"
    );

    // Deduplicate concurrent refresh attempts
    if (!refreshInProgress) {
      refreshInProgress = refreshAccessToken().finally(() => {
        refreshInProgress = null;
      });
    }
    await refreshInProgress;
  }

  return userToken!.accessToken;
}

/**
 * Force-refresh the token immediately (used by the 401 interceptor).
 * Returns the new access token string.
 */
export async function forceRefreshToken(): Promise<string> {
  if (!refreshInProgress) {
    refreshInProgress = refreshAccessToken().finally(() => {
      refreshInProgress = null;
    });
  }
  await refreshInProgress;
  if (!userToken) throw new Error("Token refresh failed — re-auth required");
  return userToken.accessToken;
}

export function setUserToken(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  scope?: string
): void {
  if (!accessToken) {
    userToken = null;
    saveTokenToDisk(null);
    logger.info("Allegro user token cleared");
    return;
  }
  const scopes = scope ? scope.split(" ") : [];
  const now = Date.now();
  userToken = {
    accessToken,
    refreshToken,
    issuedAt: now,
    expiresAt: now + expiresIn * 1000,
    scopes,
  };
  refreshTokenExpired = false;
  saveTokenToDisk(userToken);
  logger.info({ scopes, expiresIn }, "Allegro user token stored");
}

export function clearUserToken(): void {
  userToken = null;
  refreshTokenExpired = false;
  saveTokenToDisk(null);
  logger.info("Allegro user token cleared");
}

// ── Background refresh scheduler ─────────────────────────────────────────────

/**
 * Start a background interval that checks the token every 5 minutes and
 * proactively refreshes it when 80% of the lifetime has elapsed.
 * Call this once at server startup.
 */
export function setupTokenRefreshScheduler(): void {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

  setInterval(async () => {
    if (!userToken || refreshInProgress) return;
    if (shouldRefresh(userToken)) {
      logger.info("Background scheduler: refreshing Allegro token");
      refreshInProgress = refreshAccessToken().finally(() => {
        refreshInProgress = null;
      });
      try {
        await refreshInProgress;
      } catch (err: unknown) {
        const e = err as { message?: string };
        logger.error({ err: e.message }, "Background token refresh failed");
      }
    }
  }, CHECK_INTERVAL_MS);

  logger.info(
    { intervalMinutes: CHECK_INTERVAL_MS / 60_000 },
    "Token refresh scheduler started"
  );
}

// ── Axios interceptor for 401 auto-retry ─────────────────────────────────────

/**
 * Install a global axios response interceptor that:
 *  - Catches 401 responses from the Allegro REST API (not from the auth endpoints)
 *  - Refreshes the user token once
 *  - Retries the original request with the new token
 *  - If the refresh fails (refresh token expired), lets the error propagate
 *
 * Call this once at server startup, AFTER the token is loaded.
 */
export function setupAllegroAxiosInterceptor(): void {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config as (typeof error.config) & { _allegroRetried?: boolean };
      const status = error.response?.status;

      // Only intercept 401s from the Allegro REST API (bearer-authenticated calls)
      // — not from the OAuth token endpoint itself (that would loop)
      const isAllegroApi =
        typeof config?.url === "string" &&
        config.url.includes("api.allegro.pl") &&
        typeof config?.headers?.Authorization === "string" &&
        config.headers.Authorization.startsWith("Bearer ");

      if (status === 401 && isAllegroApi && !config._allegroRetried) {
        config._allegroRetried = true;
        logger.warn(
          { url: config.url },
          "Allegro API returned 401 — refreshing token and retrying"
        );
        try {
          const newToken = await forceRefreshToken();
          config.headers = config.headers ?? {};
          config.headers.Authorization = `Bearer ${newToken}`;
          return axios(config);
        } catch (refreshErr: unknown) {
          const e = refreshErr as { message?: string };
          logger.error({ err: e.message }, "Token refresh after 401 failed — cannot retry");
          throw refreshErr;
        }
      }

      throw error;
    }
  );

  logger.info("Allegro axios 401-retry interceptor installed");
}

// ── Device Flow ──────────────────────────────────────────────────────────────

export async function startDeviceFlow(): Promise<{
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}> {
  logger.info("Starting Allegro Device Flow...");

  // Allegro device flow: Basic Auth carries client identity — do NOT also send client_id in body
  const resp = await axios.post(
    `${DEVICE_URL}`,
    new URLSearchParams({}),
    {
      headers: {
        Authorization: `Basic ${getBasicCredentials()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );

  const data = resp.data as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    expires_in: number;
    interval: number;
  };

  pendingDeviceFlow = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresAt: Date.now() + data.expires_in * 1000,
    interval: data.interval || 5,
    polling: false,
  };

  logger.info({ userCode: data.user_code, verificationUri: data.verification_uri }, "Device flow started");

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete,
    expiresIn: data.expires_in,
    interval: data.interval || 5,
  };
}

export function getPendingDeviceFlow(): DeviceFlowState | null {
  return pendingDeviceFlow;
}

export async function pollDeviceFlow(): Promise<{
  status: "authorized" | "pending" | "expired" | "error";
  error?: string;
  scopes?: string[];
}> {
  if (!pendingDeviceFlow) {
    return { status: "error", error: "No pending device flow. Call /api/auth/device/start first." };
  }

  if (Date.now() > pendingDeviceFlow.expiresAt) {
    pendingDeviceFlow = null;
    return { status: "expired", error: "Device flow expired. Start a new one." };
  }

  try {
    const resp = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pendingDeviceFlow.deviceCode,
      }),
      {
        headers: {
          Authorization: `Basic ${getBasicCredentials()}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 10000,
      }
    );

    const data = resp.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
      token_type?: string;
    };

    setUserToken(data.access_token, data.refresh_token, data.expires_in, data.scope);
    pendingDeviceFlow = null;

    let scopes: string[] = [];
    if (data.scope) scopes = data.scope.split(" ");

    logger.info({ scopes }, "Device flow completed — user token stored");

    return { status: "authorized", scopes };
  } catch (err: unknown) {
    const e = err as {
      response?: { data?: { error?: string; error_description?: string } };
      message?: string;
    };
    const errCode = e.response?.data?.error;

    if (errCode === "authorization_pending") {
      return { status: "pending" };
    }
    if (errCode === "slow_down") {
      return { status: "pending" };
    }
    if (errCode === "expired_token" || errCode === "access_denied") {
      pendingDeviceFlow = null;
      return { status: "expired", error: e.response?.data?.error_description || errCode };
    }

    return {
      status: "error",
      error: e.response?.data?.error_description || e.message,
    };
  }
}
