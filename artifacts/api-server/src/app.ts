import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import crypto from "crypto";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import oauthPublicRouter from "./routes/oauth-public";
import { logger } from "./lib/logger";

const app: Express = express();

// Railway terminates HTTPS at the edge proxy and forwards plain HTTP to the
// container. Without trust proxy, req.secure is false and cookie-session with
// `secure: true` refuses to set Set-Cookie — login returns 200 but no cookie.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── App-level session cookie (single shared password gate) ───────────────────
// COOKIE_SECRET should be set in production (Railway). On a fresh boot
// without it we fall back to a per-process random key, which means cookies
// invalidate on every restart — fail-secure but bad UX, hence the warning.
const COOKIE_SECRET =
  process.env.SESSION_SECRET ??
  process.env.COOKIE_SECRET ??
  crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET && !process.env.COOKIE_SECRET) {
  logger.warn(
    "Neither SESSION_SECRET nor COOKIE_SECRET env var is set — using random per-process key. Sessions will not survive a restart.",
  );
}
app.use(
  cookieSession({
    name: "ipremium_session",
    keys: [COOKIE_SECRET],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  }),
);

// ── Public Allegro OAuth router ──────────────────────────────────────────────
// Mounted BEFORE the /api password gate so /auth/allegro/login and
// /auth/allegro/callback work even when the user has no app session — the
// callback comes from allegro.pl as a top-level cross-site redirect and the
// authorization_code is short-lived (~60 s), so any extra hop through the
// password form would burn the window.
app.use(oauthPublicRouter);

// ── /api auth gate ───────────────────────────────────────────────────────────
// Paths are RELATIVE to the /api mount (Express strips the prefix before the
// middleware runs), so the whitelist uses /healthz, /auth/login, etc.
const PUBLIC_API_PATHS = new Set<string>([
  "/healthz",
  "/auth/login",
  "/auth/logout",
]);

function requireAppAuth(req: Request, res: Response, next: NextFunction): void {
  if (PUBLIC_API_PATHS.has(req.path)) {
    next();
    return;
  }
  if (req.session?.authed === true) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

// ── API routes (must be before static files) ─────────────────────────────────
app.use("/api", requireAppAuth, router);

// ── Static frontend ───────────────────────────────────────────────────────────
// Resolve relative to the api-server working directory
// process.cwd() = /…/artifacts/api-server → ../ipremium-scan/dist/public
const FRONTEND_DIST = path.resolve(process.cwd(), "..", "ipremium-scan", "dist", "public");
const FRONTEND_INDEX = path.join(FRONTEND_DIST, "index.html");

if (fs.existsSync(FRONTEND_DIST)) {
  logger.info({ path: FRONTEND_DIST }, "Serving iPremium Scan frontend as static files");

  // Serve static assets (JS, CSS, images, etc.) with long cache headers
  app.use(
    express.static(FRONTEND_DIST, {
      maxAge: "1y",
      immutable: true,
      index: false, // let the catch-all handle root
    })
  );

  // Catch-all: return index.html for any non-API route (client-side routing)
  // Express 5 does not accept bare "*" wildcards — use app.use as a fallback handler
  app.use((_req, res) => {
    res.sendFile(FRONTEND_INDEX);
  });
} else {
  logger.warn(
    { path: FRONTEND_DIST },
    "Frontend dist not found — run `pnpm --filter @workspace/ipremium-scan run build` to generate it"
  );
}

export default app;
