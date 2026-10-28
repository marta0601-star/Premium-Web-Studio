/**
 * Category for a product OUTSIDE the Allegro catalog — without an LLM.
 *
 * Signals (accuracy measured on our own history, 2026-10-28):
 *   hist_ean   this EAN was listed before                     (product)
 *   hist_tag   our listings sharing OpenFoodFacts tags        (product, ~83 %)
 *   drill      the Supermarket drill / matching-categories    (product, ~92 % when it lands in food)
 *   cat_name   catalog products found by the product name     (product, ~77 %)
 *   hist_brand our listings of the same brand                 (brand, ~74 %)
 *   cat_brand  catalog products of the same brand             (brand, ~62 %)
 *   mc_*       matching-categories for the OFF product type   (weak, tie-break only)
 *
 * Two brand signals agreeing is NOT independent evidence (Mentos gum → "Cukierki"
 * because most Mentos are). A category is preselected only when a brand signal
 * and a product signal agree, two product signals agree, or the drill landed in
 * food and nothing contradicts it. Otherwise: no preselection, ≤ 3 suggestions.
 * Only leaves inside Supermarket (#258832) are ever returned.
 */
import axios from "axios";
import { getUserToken } from "./allegro-auth";
import { logger } from "./logger";
import { historyVotes } from "./category-history";
import { normalizeForMatch } from "./shared/autofill-rules";
import tree from "./data/supermarket-tree.json";

const ALLEGRO_BASE_URL = "https://api.allegro.pl";
const SUPERMARKET_ID = "258832";

type Node = { name: string; parent: string | null; leaf: boolean };
const SNAPSHOT = (tree as { nodes: Record<string, Node> }).nodes;

export type Votes = Map<string, number>;
export type SignalName =
  | "hist_ean" | "hist_tag" | "drill" | "cat_name" | "hist_brand" | "cat_brand" | "mc_pl_type" | "mc_en_tag";

const WEIGHT: Record<SignalName, number> = {
  hist_ean: 1.2, drill: 1.0, hist_brand: 0.8, cat_brand: 0.6, cat_name: 0.6, hist_tag: 0.5, mc_pl_type: 0.4, mc_en_tag: 0.4,
};
const BRAND_SIGNALS: SignalName[] = ["hist_brand", "cat_brand"];
const PRODUCT_SIGNALS: SignalName[] = ["hist_ean", "hist_tag", "drill", "cat_name"];
const STRONG_SIGNALS: SignalName[] = [...PRODUCT_SIGNALS, ...BRAND_SIGNALS];
const SUGGESTION_MIN_SHARE = 0.1;

/** A leaf of the Supermarket subtree (per the bundled snapshot). */
export function isSupermarketLeaf(id: string | null | undefined): boolean {
  return !!id && SNAPSHOT[id]?.leaf === true;
}

export function categoryPath(id: string): string[] {
  const out: string[] = [];
  let n: Node | undefined = SNAPSHOT[id];
  let cur: string | null = id;
  while (n && cur) {
    out.unshift(n.name);
    cur = n.parent;
    n = cur ? SNAPSHOT[cur] : undefined;
  }
  return out;
}

export interface CategoryDecision {
  categoryId: string | null;
  confidence: "high" | "medium" | "none";
  /** Ranked candidates (best first), leaves inside Supermarket only. */
  ranked: string[];
  decision: string;
  top: Partial<Record<SignalName, string>>;
}

/** Pure decision over per-signal votes (votes outside Supermarket leaves are ignored). */
export function decideCategory(signals: Partial<Record<SignalName, Votes>>): CategoryDecision {
  const score = new Map<string, number>();
  const top: Partial<Record<SignalName, string>> = {};
  for (const [name, raw] of Object.entries(signals) as Array<[SignalName, Votes]>) {
    const v = [...raw].filter(([id, n]) => n > 0 && isSupermarketLeaf(id)).sort((a, b) => b[1] - a[1]);
    if (!v.length) continue;
    top[name] = v[0][0];
    const total = v.reduce((s, [, n]) => s + n, 0);
    for (const [id, n] of v.slice(0, 5)) score.set(id, (score.get(id) ?? 0) + (WEIGHT[name] * n) / total);
  }
  // Candidates under 10 % of the best score are noise ("Miotły, zmiotki i szufelki"
  // for gummies); measured: dropping them loses no correct suggestion.
  const sorted = [...score].sort((a, b) => b[1] - a[1]);
  const ranked = sorted.filter(([, v]) => v >= SUGGESTION_MIN_SHARE * sorted[0][1]).map(([id]) => id);
  if (!ranked.length) return { categoryId: null, confidence: "none", ranked, decision: "no_signal", top };

  if (top.hist_ean) return { categoryId: top.hist_ean, confidence: "high", ranked, decision: "listed_before", top };

  const best = ranked[0];
  const brandAgrees = BRAND_SIGNALS.some((s) => top[s] === best);
  const productAgrees = PRODUCT_SIGNALS.filter((s) => top[s] === best).length;
  const against = new Map<string, number>();
  for (const s of STRONG_SIGNALS) if (top[s] && top[s] !== best) against.set(top[s]!, (against.get(top[s]!) ?? 0) + 1);
  const contradicted = [...against.values()].some((n) => n >= 2);

  if ((brandAgrees && productAgrees >= 1) || productAgrees >= 2)
    return { categoryId: best, confidence: "high", ranked, decision: "signals_agree", top };
  if (top.drill === best && !contradicted)
    return { categoryId: best, confidence: "medium", ranked, decision: "drill_uncontradicted", top };
  return { categoryId: null, confidence: "none", ranked, decision: "suggest_only", top };
}

// ── Live signals ─────────────────────────────────────────────────────────────

const gtin = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^0+/, "");

async function allegroGet<T>(url: string): Promise<T | null> {
  try {
    const token = await getUserToken();
    const r = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.allegro.public.v1+json" },
      timeout: 5000,
    });
    return r.data as T;
  } catch (err) {
    logger.warn({ url, msg: (err as Error).message }, "category signal request failed");
    return null;
  }
}

type CatalogProduct = {
  category?: { id?: string };
  parameters?: Array<{ id?: string; values?: string[] | null; valuesLabels?: string[] | null }>;
};

/** Categories of catalog products (inside Supermarket) found for a phrase. */
async function catalogVotes(phrase: string, ean: string, brand: string | null): Promise<Votes> {
  const v: Votes = new Map();
  if (!phrase.trim()) return v;
  const q = new URLSearchParams({ phrase, language: "pl-PL", "category.id": SUPERMARKET_ID });
  const data = await allegroGet<{ products?: CatalogProduct[] }>(`${ALLEGRO_BASE_URL}/sale/products?${q}`);
  for (const p of data?.products ?? []) {
    const cat = p.category?.id;
    if (!cat) continue;
    const pEan = p.parameters?.find((x) => x.id === "225693")?.values?.[0];
    if (pEan && gtin(pEan) === gtin(ean)) continue; // that would be a catalog hit, not a signal
    const pBrand = p.parameters?.find((x) => x.id === "248811")?.valuesLabels?.[0];
    const w = brand && pBrand && normalizeForMatch(pBrand) === normalizeForMatch(brand) ? 2 : 1;
    v.set(cat, (v.get(cat) ?? 0) + w);
  }
  return v;
}

async function matchingVotes(phrase: string | null): Promise<Votes> {
  const v: Votes = new Map();
  if (!phrase?.trim()) return v;
  const data = await allegroGet<{ matchingCategories?: Array<{ id: string }> }>(
    `${ALLEGRO_BASE_URL}/sale/matching-categories?name=${encodeURIComponent(phrase)}`,
  );
  (data?.matchingCategories ?? []).forEach((c, i) => v.set(c.id, (v.get(c.id) ?? 0) + 1 / (i + 1)));
  return v;
}

const liveLeaf = new Map<string, Promise<boolean>>();
/** Re-check a category is still a leaf on Allegro (the snapshot can age). */
function stillLeaf(id: string): Promise<boolean> {
  if (!liveLeaf.has(id)) {
    liveLeaf.set(
      id,
      allegroGet<{ leaf?: boolean }>(`${ALLEGRO_BASE_URL}/sale/categories/${id}`).then((d) => {
        if (d === null) liveLeaf.delete(id); // transient — ask again next time
        return d?.leaf ?? isSupermarketLeaf(id);
      }),
    );
  }
  return liveLeaf.get(id)!;
}

/** Most specific English OFF tag, as words ("en:gummy-bears" → "gummy bears"). */
export function englishTypeFromOffTags(tags: string[]): string | null {
  const t = [...tags].reverse().find((x) => x.startsWith("en:"));
  return t ? t.slice(3).replace(/-/g, " ") : null;
}

export interface CategorySuggestion {
  id: string;
  name: string;
  path: string[];
}

export interface OffCatalogCategory {
  categoryId: string | null;
  categoryName: string | null;
  categoryPath: string[];
  confidence: "high" | "medium" | "none";
  /** ≤ 3 one-tap alternatives (when preselected: the next best ones). */
  suggestions: CategorySuggestion[];
  decision: string;
  top: Partial<Record<SignalName, string>>;
}

export async function resolveOffCatalogCategory(input: {
  ean: string;
  brands: string[];
  offTags: string[];
  plType: string | null;
  cleanedName: string;
  /** What the existing Supermarket drill / matching-categories fallback found. */
  drillCategoryId: string | null;
}): Promise<OffCatalogCategory> {
  const hist = historyVotes(input.ean, input.brands, input.offTags);
  const [catBrand1, catBrand2, catName, mcPl, mcEn] = await Promise.all([
    input.brands[0] ? catalogVotes(input.brands[0], input.ean, input.brands[0]) : Promise.resolve<Votes>(new Map()),
    input.brands[1] ? catalogVotes(input.brands[1], input.ean, input.brands[1]) : Promise.resolve<Votes>(new Map()),
    catalogVotes(input.cleanedName, input.ean, null),
    matchingVotes(input.plType),
    matchingVotes(englishTypeFromOffTags(input.offTags)),
  ]);
  const catBrand: Votes = new Map(catBrand1);
  for (const [k, n] of catBrand2) catBrand.set(k, (catBrand.get(k) ?? 0) + n);

  const d = decideCategory({
    hist_ean: hist.exact ? new Map([[hist.exact, 1]]) : new Map(),
    hist_tag: hist.tag,
    drill: input.drillCategoryId ? new Map([[input.drillCategoryId, 1]]) : new Map(),
    cat_name: catName,
    hist_brand: hist.brand,
    cat_brand: catBrand,
    mc_pl_type: mcPl,
    mc_en_tag: mcEn,
  });

  // Final guard: only categories Allegro still reports as leaves.
  const candidates = [...new Set([d.categoryId, ...d.ranked].filter((x): x is string => !!x))].slice(0, 5);
  const ok = new Set((await Promise.all(candidates.map(async (id) => ((await stillLeaf(id)) ? id : null)))).filter(Boolean));
  const chosen = d.categoryId && ok.has(d.categoryId) ? d.categoryId : null;
  const suggestions = d.ranked
    .filter((id) => ok.has(id) && id !== chosen)
    .slice(0, 3)
    .map((id) => ({ id, name: SNAPSHOT[id].name, path: categoryPath(id) }));

  return {
    categoryId: chosen,
    categoryName: chosen ? SNAPSHOT[chosen].name : null,
    categoryPath: chosen ? categoryPath(chosen) : [],
    confidence: chosen ? d.confidence : "none",
    suggestions,
    decision: chosen || !d.categoryId ? d.decision : "chosen_not_leaf_anymore",
    top: d.top,
  };
}
