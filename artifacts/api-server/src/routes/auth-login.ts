/**
 * App-level login (separate from Allegro OAuth).
 *
 * Single shared password compared plaintext against APP_PASSWORD env var,
 * cookie-session flips req.session.authed = true on success. Mounted on
 * the same router as Allegro auth (/api), so the public paths are
 * /api/auth/login, /api/auth/logout, /api/auth/me.
 *
 * The auth gate in app.ts whitelists /auth/login and /auth/logout (and
 * /healthz + /auth/allegro/callback) so an unauthenticated client can
 * reach this endpoint to obtain a session in the first place.
 */
import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/auth/login", (req, res) => {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    logger.error("APP_PASSWORD env var is not set — login is impossible");
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }
  const { password } = (req.body ?? {}) as { password?: string };
  if (typeof password !== "string" || password !== expected) {
    res.status(401).json({ error: "Nieprawidłowe hasło" });
    return;
  }
  if (req.session) {
    req.session.authed = true;
  }
  res.json({ ok: true });
});

router.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get("/auth/me", (req, res) => {
  if (req.session?.authed === true) {
    res.json({ authed: true });
    return;
  }
  res.status(401).json({ authed: false });
});

export default router;
