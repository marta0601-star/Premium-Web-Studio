import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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

// ── API routes (must be before static files) ─────────────────────────────────
app.use("/api", router);

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
