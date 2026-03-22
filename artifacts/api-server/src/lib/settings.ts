import fs from "fs";
import path from "path";
import { logger } from "./logger";

const SETTINGS_FILE = path.resolve(process.cwd(), "settings.json");

export interface SellerSettings {
  city: string;
  postCode: string;
  state: string;
}

interface AppSettings {
  seller?: SellerSettings;
}

function readSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")) as AppSettings;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to read settings.json");
  }
  return {};
}

function writeSettings(settings: AppSettings): void {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to write settings.json");
    throw err;
  }
}

export function getSellerSettings(): SellerSettings | null {
  const s = readSettings();
  if (s.seller?.city && s.seller?.postCode && s.seller?.state) {
    return s.seller;
  }
  // Fall back to env vars
  const city = process.env.SELLER_CITY;
  const postCode = process.env.SELLER_POSTCODE;
  const state = process.env.SELLER_STATE;
  if (city && postCode && state) {
    return { city, postCode, state };
  }
  return null;
}

export function saveSellerSettings(seller: SellerSettings): void {
  const existing = readSettings();
  writeSettings({ ...existing, seller });
  logger.info({ seller }, "Seller settings saved");
}
