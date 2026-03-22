import app from "./app";
import { logger } from "./lib/logger";
import { loadFixedDefaults } from "./lib/allegro";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Resolve and cache DOSTAWA / ZWROT / REKLAMACJA IDs once at startup
  loadFixedDefaults().catch((e) =>
    logger.warn({ err: e }, "loadFixedDefaults failed at startup — will retry at first offer creation")
  );
});
