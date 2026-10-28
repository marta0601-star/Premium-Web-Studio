/**
 * Our own listing history as a category signal: which final Allegro category
 * a product with this EAN / brand / OpenFoodFacts tags ended up in.
 *
 * Seed: every successful offer from the production logs (data/category-
 * history.seed.json). Every new successful offer is appended to a JSONL file
 * next to the token store (/data in production), so the signal keeps learning.
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";
import { normalizeForMatch } from "./shared/autofill-rules";
import seed from "./data/category-history.seed.json";

export interface CategoryHistoryRecord {
  ean: string;
  /** Marka as on the listed card. */
  brand: string | null;
  categoryId: string;
  /** OpenFoodFacts categories_tags seen when the product was scanned. */
  tags: string[];
}

const HISTORY_FILE = path.resolve(
  process.env.CATEGORY_HISTORY_PATH ||
    path.join(path.dirname(path.resolve(process.env.TOKEN_STORE_PATH || path.join(process.cwd(), "tokens.json"))), "category-history.jsonl"),
);

const gtin = (ean: string) => ean.replace(/\D/g, "").replace(/^0+/, "");

let records: Map<string, CategoryHistoryRecord> | null = null;
let tagDf: Map<string, number> | null = null;

function load(): Map<string, CategoryHistoryRecord> {
  if (records) return records;
  records = new Map();
  for (const r of (seed as { records: CategoryHistoryRecord[] }).records) records.set(gtin(r.ean), r);
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      for (const line of fs.readFileSync(HISTORY_FILE, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as CategoryHistoryRecord;
          if (r.ean && r.categoryId) records.set(gtin(r.ean), r);
        } catch { /* skip a broken line */ }
      }
    }
  } catch (err) {
    logger.warn({ err, file: HISTORY_FILE }, "category history: could not read runtime file");
  }
  tagDf = null;
  return records;
}

function df(): Map<string, number> {
  if (tagDf) return tagDf;
  tagDf = new Map();
  for (const r of load().values()) for (const t of new Set(r.tags)) tagDf.set(t, (tagDf.get(t) ?? 0) + 1);
  return tagDf;
}

/** Append a successful listing (best effort — never breaks offer creation). */
export function recordCategoryUse(rec: CategoryHistoryRecord): void {
  if (!rec.ean || !rec.categoryId) return;
  load().set(gtin(rec.ean), rec);
  tagDf = null;
  try {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(rec) + "\n", "utf-8");
  } catch (err) {
    logger.warn({ err, file: HISTORY_FILE }, "category history: could not append");
  }
}

export interface HistoryVotes {
  /** Category this exact EAN was listed in before. */
  exact: string | null;
  /** Categories of other products with the same brand (count). */
  brand: Map<string, number>;
  /** Categories of other products sharing OFF tags (Σ 1/df per shared tag). */
  tag: Map<string, number>;
}

export function historyVotes(ean: string, brands: string[], tags: string[]): HistoryVotes {
  const all = load();
  const own = gtin(ean);
  const brandKeys = new Set(brands.slice(0, 2).map(normalizeForMatch).filter(Boolean));
  const tagSet = new Set(tags);
  const d = df();
  const brand = new Map<string, number>();
  const tag = new Map<string, number>();
  for (const [key, r] of all) {
    if (key === own) continue;
    if (r.brand && brandKeys.has(normalizeForMatch(r.brand))) brand.set(r.categoryId, (brand.get(r.categoryId) ?? 0) + 1);
    let w = 0;
    for (const t of r.tags) if (tagSet.has(t)) w += 1 / (d.get(t) ?? 1);
    if (w > 0) tag.set(r.categoryId, (tag.get(r.categoryId) ?? 0) + w);
  }
  return { exact: all.get(own)?.categoryId ?? null, brand, tag };
}

// ── What the scan knew, for recording when the offer is created ─────────────

const scanContext = new Map<string, { brands: string[]; tags: string[] }>();

export function rememberScanContext(ean: string, ctx: { brands: string[]; tags: string[] }): void {
  scanContext.delete(gtin(ean));
  scanContext.set(gtin(ean), ctx);
  if (scanContext.size > 1000) scanContext.delete(scanContext.keys().next().value as string);
}

export function scanContextFor(ean: string): { brands: string[]; tags: string[] } | undefined {
  return scanContext.get(gtin(ean));
}
