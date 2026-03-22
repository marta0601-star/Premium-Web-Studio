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
 *   4. Refresh automatically when expired
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
  process.env.TOKEN_STORE_PATH || path.join(process.cwd(), ".allegro-token.json")
);

interface UserTokenStore {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

// Load from disk on startup
function loadTokenFromDisk(): UserTokenStore | null {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, "utf-8");
      const data = JSON.parse(raw) as UserTokenStore;
      if (data.accessToken && data.refreshToken && data.expiresAt) {
        logger.info({ expiresAt: new Date(data.expiresAt).toISOString() }, "Allegro user token loaded from disk");
        return data;
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Could not load Allegro token from disk");
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

function getBasicCredentials(): string {
  return Buffer.from(`${ALLEGRO_CLIENT_ID}:${ALLEGRO_CLIENT_SECRET}`).toString("base64");
}

// ── Token access ────────────────────────────────────────────────────────────

export function getUserTokenStatus(): {
  hasToken: boolean;
  expiresAt?: number;
  expiresInMs?: number;
  scopes?: string[];
  accessTokenPrefix?: string;
} {
  if (!userToken) return { hasToken: false };
  return {
    hasToken: true,
    expiresAt: userToken.expiresAt,
    expiresInMs: userToken.expiresAt - Date.now(),
    scopes: userToken.scopes,
    accessTokenPrefix: userToken.accessToken.slice(0, 20) + "...",
  };
}

async function refreshAccessToken(): Promise<void> {
  if (!userToken?.refreshToken) throw new Error("No refresh token available");

  logger.info("Refreshing Allegro user token...");
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

  userToken = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || userToken!.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    scopes,
  };

  saveTokenToDisk(userToken);
  logger.info("Allegro user token refreshed");
}

export async function getUserToken(): Promise<string> {
  if (!userToken) {
    throw new Error(
      "No user token available. Complete Device Flow at GET /api/auth/device/start"
    );
  }

  if (Date.now() >= userToken.expiresAt) {
    await refreshAccessToken();
  }

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
  userToken = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
    scopes,
  };
  saveTokenToDisk(userToken);
  logger.info({ scopes }, "Allegro user token stored");
}

export function clearUserToken(): void {
  userToken = null;
  saveTokenToDisk(null);
  logger.info("Allegro user token cleared");
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
