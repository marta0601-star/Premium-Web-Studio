import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ScanLine, Box, CheckCircle2, AlertCircle, RefreshCw, Layers,
  ExternalLink, Clock, ChevronRight, ChevronDown, Edit2, CheckCheck,
  Camera, ImageIcon, Loader2,
} from "lucide-react";
import { useScanBarcode, useSubmitOffer } from "@/hooks/use-allegro";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PremiumButton, PremiumInput, PremiumSwitch, CustomSelect } from "@/components/ui-custom";
import { AllegroAuthBanner } from "@/components/AllegroAuth";
import { LocationSetup } from "@/components/LocationSetup";
import type { CreateOfferRequest, ParameterValue } from "@workspace/api-client-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface AllegroParam {
  id: string;
  name: string;
  type: string;
  required: boolean;
  requiredForProduct: boolean;
  unit: string | null;
  options: Array<{ id: string; name: string }>;
  restrictions: Record<string, unknown> | null;
}

interface ExtendedScanResult {
  productId: string | null;
  productName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  images: Array<{ url: string }>;
  parameters: AllegroParam[];
  prefillValues: Record<string, string[]>;
  productParamIds?: string[];
  source: string | null;
  brand?: string | null;
  weight?: string | null;
  category?: string | null;
  ean?: string;
  logs?: string[];
}

interface AllegroError {
  code?: string;
  message?: string;
  path?: string;
  userMessage?: string;
}

interface CategorySuggestion {
  id: string;
  name: string;
  leaf: boolean;
  path?: Array<{ id: string; name: string }>;
}

type WorkflowStep = "SCAN" | "LOADING" | "FORM" | "SUCCESS";
type SourceKind = "allegro" | "external" | "manual";

// ── EAN prefix → country of origin ──────────────────────────────────────────

const EAN_COUNTRY_MAP: Array<[number, number, string]> = [
  [300, 379, "Francja"],
  [400, 440, "Niemcy"],
  [471, 471, "Tajwan"],
  [489, 489, "Hongkong"],
  [490, 499, "Japonia"],
  [500, 509, "Wielka Brytania"],
  [590, 590, "Polska"],
  [690, 699, "Chiny"],
  [800, 839, "Włochy"],
  [840, 849, "Hiszpania"],
  [858, 858, "Czechy"],
  [859, 859, "Słowacja"],
  [869, 869, "Turcja"],
  [880, 880, "Korea Południowa"],
];

function getCountryFromEan(ean: string): string | null {
  const prefix3 = parseInt(ean.slice(0, 3), 10);
  for (const [from, to, country] of EAN_COUNTRY_MAP) {
    if (prefix3 >= from && prefix3 <= to) return country;
  }
  return null;
}

// ── Smart auto-fill logic ────────────────────────────────────────────────────

function extractNumber(s: string): string | null {
  const m = s.match(/(\d+(?:[.,]\d+)?)/);
  return m ? m[1].replace(",", ".") : null;
}

function fuzzyMatchOption(
  options: Array<{ id: string; name: string }>,
  query: string | null | undefined
): string | null {
  if (!query || !options.length) return null;
  const q = query.toLowerCase().trim();
  // 1. Exact match
  const exact = options.find((o) => o.name.toLowerCase() === q);
  if (exact) return exact.id;
  // 2. Option name contains query
  const optContains = options.find((o) => o.name.toLowerCase().includes(q));
  if (optContains) return optContains.id;
  // 3. Query contains option name — only if option name is ≥4 chars (avoids "Bio" matching "Schlossblick Bio Wasser")
  const qContains = options.find((o) => {
    const n = o.name.toLowerCase();
    return n.length >= 4 && q.includes(n);
  });
  if (qContains) return qContains.id;
  return null;
}

interface ProductContext {
  ean: string;
  brand?: string | null;
  weight?: string | null;
  productName?: string | null;
  country?: string | null;
}

function autoFillParam(
  param: AllegroParam,
  ctx: ProductContext
): { value?: ParameterValue; autoFilled: boolean } {
  const nameLower = param.name.toLowerCase();

  const isEan = /ean|gtin|kod kreskowy|barcode/.test(nameLower);
  const isBrand = /marka|brand|producent/.test(nameLower);
  const isWeight = /waga|gramatu|masa netto|netto|weight/.test(nameLower);
  const isVolume = /pojemność|volume|litraż/.test(nameLower);
  const isName = nameLower === "nazwa handlowa" || nameLower === "nazwa produktu";
  const isCountry = /kraj pochodzenia|country of origin|kraj prod/.test(nameLower);
  const isCondition = /stan/.test(nameLower) && param.type === "dictionary";

  // EAN/GTIN string
  if (isEan && param.type === "string" && ctx.ean) {
    return { value: { id: param.id, values: [ctx.ean] }, autoFilled: true };
  }

  // Brand — dictionary fuzzy match
  if (isBrand && param.type === "dictionary") {
    const matched = fuzzyMatchOption(param.options, ctx.brand);
    if (matched) {
      return { value: { id: param.id, valuesIds: [matched] }, autoFilled: true };
    }
  }
  // Brand — string
  if (isBrand && param.type === "string" && ctx.brand) {
    return { value: { id: param.id, values: [ctx.brand] }, autoFilled: true };
  }

  // Weight / Volume — extract numeric from weight string
  if ((isWeight || isVolume) && (param.type === "float" || param.type === "integer") && ctx.weight) {
    const num = extractNumber(ctx.weight);
    if (num) return { value: { id: param.id, values: [num] }, autoFilled: true };
  }

  // Product name
  if (isName && param.type === "string" && ctx.productName) {
    return { value: { id: param.id, values: [ctx.productName] }, autoFilled: true };
  }

  // Country of origin — dictionary fuzzy match
  if (isCountry && param.type === "dictionary" && ctx.country) {
    const matched = fuzzyMatchOption(param.options, ctx.country);
    if (matched) {
      return { value: { id: param.id, valuesIds: [matched] }, autoFilled: true };
    }
  }
  if (isCountry && param.type === "string" && ctx.country) {
    return { value: { id: param.id, values: [ctx.country] }, autoFilled: true };
  }

  // Condition — always "Nowy" if only one option
  if (isCondition && param.options.length === 1) {
    return { value: { id: param.id, valuesIds: [param.options[0].id] }, autoFilled: true };
  }
  if (isCondition) {
    const nowy = fuzzyMatchOption(param.options, "Nowy") || fuzzyMatchOption(param.options, "nowy") || param.options[0]?.id;
    if (nowy) return { value: { id: param.id, valuesIds: [nowy] }, autoFilled: true };
  }

  return { autoFilled: false };
}

function buildAutoFilledState(
  params: AllegroParam[],
  prefillValues: Record<string, string[]>,
  ctx: ProductContext
): { formState: Record<string, ParameterValue>; autoFilledIds: Set<string> } {
  const formState: Record<string, ParameterValue> = {};
  const autoFilledIds = new Set<string>();

  for (const param of params) {
    const nameLower = param.name.toLowerCase();
    const isBrandParam = /marka|brand|producent/.test(nameLower);

    // Brand parameters: always prefer ctx.brand from product lookup over Allegro catalog prefill.
    // The Allegro catalog can match a completely different product for the same EAN,
    // resulting in a wrong brand being populated (e.g. CHAOKOH for a German water brand).
    if (isBrandParam && ctx.brand) {
      if (param.type === "dictionary") {
        const matched = fuzzyMatchOption(param.options, ctx.brand);
        if (matched) {
          formState[param.id] = { id: param.id, valuesIds: [matched] };
          autoFilledIds.add(param.id);
        } else {
          // Brand not in options list — leave empty so user selects manually
          formState[param.id] = { id: param.id };
        }
      } else if (param.type === "string") {
        formState[param.id] = { id: param.id, values: [ctx.brand] };
        autoFilledIds.add(param.id);
      }
      continue; // Skip Allegro catalog prefill for brand
    }

    // 1. Allegro catalog prefill (highest priority for non-brand params)
    const catalogValues = prefillValues[param.id];
    if (catalogValues && catalogValues.length > 0) {
      if (param.type === "dictionary") {
        formState[param.id] = { id: param.id, valuesIds: catalogValues };
      } else {
        formState[param.id] = { id: param.id, values: catalogValues };
      }
      autoFilledIds.add(param.id);
      continue;
    }

    // 2. Smart auto-fill from product context
    const { value, autoFilled } = autoFillParam(param, ctx);
    if (value) {
      formState[param.id] = value;
      if (autoFilled) autoFilledIds.add(param.id);
    } else {
      formState[param.id] = { id: param.id };
    }
  }

  return { formState, autoFilledIds };
}

// ── Source utilities ─────────────────────────────────────────────────────────

function getSourceKind(source: string | null | undefined): SourceKind {
  if (!source) return "manual";
  if (source === "allegro_catalog") return "allegro";
  return "external";
}

function friendlySourceName(source: string | null | undefined): string {
  if (!source) return "Nieznane";
  if (source === "allegro_catalog") return "Katalog Allegro";
  if (source.startsWith("openfoodfacts/")) {
    const region = source.replace("openfoodfacts/", "").toUpperCase();
    return `Open Food Facts (${region})`;
  }
  const map: Record<string, string> = {
    upcitemdb: "UPCitemdb",
    google: "Google",
    allegro_google: "Google / allegro.pl",
    ceneo_google: "Google / ceneo.pl",
    barcodelookup_google: "Google / barcodelookup.com",
    ean_search_google: "Google / ean-search.org",
  };
  return map[source] ?? source;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function buildAllegroProductUrl(productId: string, productName: string): string {
  const slug = productName
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return `https://allegro.pl/produkt/${slug}-${productId}`;
}

function SourceBanner({
  source,
  productId,
  productName,
}: {
  source: string | null | undefined;
  productId?: string | null;
  productName?: string | null;
}) {
  const kind = getSourceKind(source);
  if (kind === "allegro") {
    const allegroUrl =
      productId && productName
        ? buildAllegroProductUrl(productId, productName)
        : null;
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/30 mb-6">
        <span className="text-green-400 text-lg leading-none">✅</span>
        <div className="flex-1 min-w-0">
          <p className="text-green-300 font-semibold text-sm">Produkt znaleziony w katalogu Allegro</p>
          {productId && <p className="text-green-400/70 text-xs mt-0.5 font-mono truncate">ID: {productId}</p>}
        </div>
        {allegroUrl && (
          <a
            href={allegroUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 text-green-300 text-xs font-semibold transition-colors shrink-0"
          >
            Otwórz na Allegro <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    );
  }
  if (kind === "external") {
    return (
      <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 mb-6">
        <span className="text-amber-400 text-lg leading-none mt-0.5">⚠️</span>
        <div>
          <p className="text-amber-300 font-semibold text-sm">
            Produkt NIE jest w katalogu Allegro — znaleziony w:{" "}
            <span className="font-bold">{friendlySourceName(source)}</span>
          </p>
          <p className="text-amber-400/70 text-xs mt-1">Kategoria dobrana automatycznie — możesz ją zmienić.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 mb-6">
      <span className="text-red-400 text-lg leading-none mt-0.5">❌</span>
      <p className="text-red-300 font-semibold text-sm">Produkt nie znaleziony — wypełnij dane ręcznie</p>
    </div>
  );
}

function KindDot({ kind }: { kind: SourceKind }) {
  if (kind === "allegro") return <span title="Katalog Allegro" className="text-base leading-none">🟢</span>;
  if (kind === "external") return <span title="Źródło zewnętrzne" className="text-base leading-none">🟠</span>;
  return <span title="Ręcznie" className="text-base leading-none">🔴</span>;
}

interface HistoryEntry {
  ean: string;
  productName: string;
  source: string | null | undefined;
  kind: SourceKind;
  offerId?: string;
  ts: number;
}

function ScanHistory({ entries, onRescan }: { entries: HistoryEntry[]; onRescan: (ean: string) => void }) {
  if (entries.length === 0) return null;
  return (
    <div className="bg-black/30 border border-white/8 rounded-2xl p-4 space-y-1 mb-8">
      <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Clock className="w-3.5 h-3.5" /> Historia skanów
      </p>
      {entries.map((entry) => (
        <button
          key={entry.ts}
          onClick={() => onRescan(entry.ean)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors text-left group"
        >
          <KindDot kind={entry.kind} />
          <div className="flex-1 min-w-0">
            <p className="text-white/80 text-sm font-medium truncate">{entry.productName}</p>
            <p className="text-white/35 text-xs font-mono">{entry.ean}</p>
          </div>
          {entry.offerId && (
            <span className="text-xs text-green-400/70 font-mono shrink-0 hidden sm:block">#{entry.offerId.slice(0, 8)}</span>
          )}
          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/40 transition-colors shrink-0" />
        </button>
      ))}
    </div>
  );
}

// Progress indicator
function ParamProgress({ formState, params }: { formState: Record<string, ParameterValue>; params: AllegroParam[] }) {
  const required = params.filter((p) => p.required);
  const filled = required.filter((p) => {
    const v = formState[p.id];
    return (v?.values?.[0] && v.values[0] !== "") || (v?.valuesIds?.[0] && v.valuesIds[0] !== "");
  });
  if (required.length === 0) return null;
  const pct = Math.round((filled.length / required.length) * 100);
  const complete = filled.length === required.length;
  return (
    <div className="flex items-center gap-3 mb-6">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${complete ? "bg-green-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs font-semibold whitespace-nowrap ${complete ? "text-green-400" : "text-white/50"}`}>
        {complete && <CheckCheck className="w-3.5 h-3.5 inline mr-1" />}
        {filled.length}/{required.length} wymaganych
      </span>
    </div>
  );
}

// Category picker — caller controls open/close, not this component
function CategoryPicker({
  suggestions,
  currentCatName,
  onSelect,
  onClose,
}: {
  suggestions: CategorySuggestion[];
  currentCatName?: string;
  onSelect: (cat: CategorySuggestion) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CategorySuggestion[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
        const r = await fetch(`${BASE}/api/allegro/category-search?q=${encodeURIComponent(query.trim())}`);
        const d = (await r.json()) as { categories?: Array<{ id: string; name: string; leaf: boolean }> };
        setSearchResults((d.categories || []).map((c) => ({ id: c.id, name: c.name, leaf: c.leaf })));
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  const listToShow = query.trim() ? searchResults : suggestions;

  return (
    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-zinc-900 border border-white/20 rounded-xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-white/5">
        <span className="text-white/50 text-xs uppercase tracking-wider">
          {query.trim() ? "Wyniki wyszukiwania" : currentCatName ? `▸ ${currentCatName}` : "Wybierz kategorię"}
        </span>
        <button onClick={onClose} className="text-white/30 hover:text-white/60 text-xs">✕</button>
      </div>
      {/* Search input */}
      <div className="px-3 py-2 border-b border-white/10">
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Szukaj kategorii (np. kapsułki do kawy)..."
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary/50"
        />
      </div>
      {/* Results */}
      <div className="max-h-64 overflow-y-auto">
        {searching && (
          <div className="flex items-center justify-center py-6 text-white/40 text-sm gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Szukam...
          </div>
        )}
        {!searching && listToShow.length === 0 && (
          <p className="text-white/40 text-sm text-center py-6">
            {query.trim() ? "Brak wyników — spróbuj innej frazy" : "Brak podkategorii — wpisz nazwę kategorii powyżej"}
          </p>
        )}
        {!searching && listToShow.map((cat) => (
          <button
            key={cat.id}
            onClick={() => onSelect(cat)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/5 text-left border-b border-white/5 last:border-0"
          >
            <span className="text-white text-sm font-medium">{cat.name}</span>
            {!cat.leaf && <span className="text-white/30 text-xs ml-2">›</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function fetchMatchingCategories(name: string): Promise<CategorySuggestion[]> {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  try {
    const r = await fetch(`${BASE}/api/allegro/matching-categories?name=${encodeURIComponent(name)}`);
    const d = await r.json();
    // Allegro returns { matchingCategories: [...] } or { categories: [...] }
    const raw = d.matchingCategories || d.categories || [];
    return raw.map((c: Record<string, unknown>) => ({
      id: (c.id as string) || String(c.id),
      name: (c.name as string) || "Kategoria",
      leaf: (c.leaf as boolean) ?? true,
      path: c.path as CategorySuggestion["path"],
    }));
  } catch {
    return [];
  }
}

async function fetchCategoryChildren(parentId: string): Promise<CategorySuggestion[]> {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  try {
    const r = await fetch(`${BASE}/api/allegro/category-children?id=${encodeURIComponent(parentId)}`);
    const d = await r.json();
    return ((d.categories || []) as Array<{ id: string; name: string; leaf: boolean }>).map((c) => ({
      id: c.id,
      name: c.name,
      leaf: c.leaf,
    }));
  } catch {
    return [];
  }
}

async function fetchCategoryParameters(categoryId: string): Promise<AllegroParam[]> {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  try {
    const r = await fetch(`${BASE}/api/allegro/category-parameters/${categoryId}`);
    const d = await r.json();
    return (d.parameters || []) as AllegroParam[];
  } catch {
    return [];
  }
}

// ── Main component ───────────────────────────────────────────────────────────

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>("SCAN");
  const [manualEan, setManualEan] = useState("");
  const [currentEan, setCurrentEan] = useState("");

  const [scannedData, setScannedData] = useState<ExtendedScanResult | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryName, setCategoryName] = useState<string>("");
  const [parameters, setParameters] = useState<AllegroParam[]>([]);
  const [formState, setFormState] = useState<Record<string, ParameterValue>>({});
  const [autoFilledIds, setAutoFilledIds] = useState<Set<string>>(new Set());

  const [categorySuggestions, setCategorySuggestions] = useState<CategorySuggestion[]>([]);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [loadingParams, setLoadingParams] = useState(false);

  const [offerId, setOfferId] = useState<string | null>(null);
  const [offerUrl, setOfferUrl] = useState<string | null>(null);
  const [offerStatus, setOfferStatus] = useState<string | null>(null);
  const [productStatus, setProductStatus] = useState<string | null>(null);
  const [offerMessage, setOfferMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allegroErrors, setAllegroErrors] = useState<AllegroError[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [scanHistory, setScanHistory] = useState<HistoryEntry[]>([]);
  const [productParamIds, setProductParamIds] = useState<string[]>([]);
  const [userImagePreviewUrl, setUserImagePreviewUrl] = useState<string | null>(null);
  const [allegroImageUrl, setAllegroImageUrl] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [description, setDescription] = useState<string>("");
  const [productTitle, setProductTitle] = useState<string>("");

  const scanMutation = useScanBarcode();
  const submitMutation = useSubmitOffer();

  // When category changes, re-fetch parameters and re-auto-fill
  const applyCategory = useCallback(
    async (
      catId: string,
      catName: string,
      existingParams: AllegroParam[],
      prefillValues: Record<string, string[]>,
      ctx: ProductContext,
      fetchNew: boolean
    ) => {
      setLoadingParams(true);
      let params = existingParams;
      if (fetchNew) {
        params = await fetchCategoryParameters(catId);
      }
      setCategoryId(catId);
      setCategoryName(catName);
      setParameters(params);
      const { formState: fs, autoFilledIds: ai } = buildAutoFilledState(params, prefillValues, ctx);
      setFormState(fs);
      setAutoFilledIds(ai);
      setLoadingParams(false);
    },
    []
  );

  const handleImageFile = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setUserImagePreviewUrl(previewUrl);
    setAllegroImageUrl(null);
    setImageUploading(true);
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const resp = await fetch(`${BASE}/api/allegro/upload-image`, {
        method: "POST",
        headers: { "Content-Type": file.type || "image/jpeg" },
        body: file,
      });
      if (resp.ok) {
        const data = (await resp.json()) as { url?: string };
        if (data.url) setAllegroImageUrl(data.url);
      }
    } catch {
      /* ignore — preview still visible */
    } finally {
      setImageUploading(false);
    }
  }, []);

  const handleScan = useCallback(async (ean: string) => {
    const trimmed = ean.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setSubmitAttempted(false);
    setCurrentEan(trimmed);
    setManualEan("");
    setStep("LOADING");
    setParameters([]);
    setFormState({});
    setAutoFilledIds(new Set());
    setCategorySuggestions([]);
    if (userImagePreviewUrl) URL.revokeObjectURL(userImagePreviewUrl);
    setUserImagePreviewUrl(null);
    setAllegroImageUrl(null);

    try {
      const data = await scanMutation.mutateAsync(trimmed) as ExtendedScanResult;
      setScannedData(data);
      setProductParamIds(data.productParamIds || []);
      setDescription(`EAN: ${trimmed}`);

      const kind = getSourceKind(data.source);
      setScanHistory((prev) => {
        const without = prev.filter((e) => e.ean !== trimmed);
        return [
          { ean: trimmed, productName: data.productName || "Nieznany produkt", source: data.source, kind, ts: Date.now() },
          ...without,
        ].slice(0, 10);
      });

      const country = getCountryFromEan(trimmed);
      const ctx: ProductContext = {
        ean: trimmed,
        brand: data.brand,
        weight: data.weight,
        productName: data.productName,
        country,
      };

      if (kind === "allegro") {
        // Allegro catalog — parameters already in data.parameters
        const params = data.parameters || [];
        setCategoryId(data.categoryId);
        setCategoryName(data.categoryName || "");
        setParameters(params);
        const { formState: fs, autoFilledIds: ai } = buildAutoFilledState(params, data.prefillValues || {}, ctx);
        setFormState(fs);
        setAutoFilledIds(ai);
        setStep("FORM");
      } else {
        // External source — backend auto-detects category and loads params
        setStep("FORM");
        const defaultCatId = data.categoryId || "258832";
        const defaultCatName = data.categoryName || "Supermarket";
        setCategoryId(defaultCatId);
        setCategoryName(defaultCatName);

        const params = data.parameters || [];
        setParameters(params);

        if (params.length > 0) {
          // Backend detected category AND loaded params — build form state from them
          const { formState: fs, autoFilledIds: ai } = buildAutoFilledState(params, data.prefillValues || {}, ctx);
          setFormState(fs);
          setAutoFilledIds(ai);
          // Don't auto-open picker — just show the detected category with the change button
        }

        // Auto-upload any image found by the lookup to Allegro in background
        const lookupImageUrl = data.images?.[0]?.url ?? null;
        if (lookupImageUrl) {
          setImageUploading(true);
          const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
          fetch(`${BASE}/api/allegro/upload-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: lookupImageUrl }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((d: { url?: string } | null) => {
              if (d?.url) setAllegroImageUrl(d.url);
            })
            .catch(() => {/* best-effort */})
            .finally(() => setImageUploading(false));
        }

        // Pre-load subcategories of detected category (for picker, if user wants to change)
        fetchCategoryChildren(defaultCatId).then((children) => {
          setCategorySuggestions(children);
        });
      }
    } catch (err: unknown) {
      const apiErr = err as { data?: { error?: string } };
      const isNotFound = apiErr?.data?.error === "not_found";

      setScanHistory((prev) => {
        const without = prev.filter((e) => e.ean !== trimmed);
        return [{ ean: trimmed, productName: "Nie znaleziono", source: null, kind: "manual", ts: Date.now() }, ...without].slice(0, 10);
      });

      if (isNotFound) {
        // Product not found anywhere — open an empty form for full manual entry
        setScannedData({
          productId: null,
          productName: "",
          categoryId: null,
          categoryName: "",
          images: [],
          parameters: [],
          prefillValues: {},
          productParamIds: [],
          source: null,
          ean: trimmed,
        });
        setProductTitle("");
        setCategoryId(null);
        setCategoryName("");
        setParameters([]);
        setFormState({});
        setAutoFilledIds(new Set());
        setShowCategoryPicker(true); // auto-open picker so user can immediately select category
        // Pre-load Supermarket subcategories so the picker is immediately useful
        fetchCategoryChildren("258832").then(setCategorySuggestions);
        setDescription(`EAN: ${trimmed}`);
        setStep("FORM");
      } else {
        setErrorMsg("Wystąpił błąd serwera podczas pobierania danych. Spróbuj ponownie.");
        setStep("SCAN");
      }
    }
  }, [scanMutation, userImagePreviewUrl]);

  const handleCategoryChange = useCallback(
    async (cat: CategorySuggestion) => {
      if (!scannedData) return;

      // If this is NOT a leaf category, drill down: show its children in the picker
      if (!cat.leaf) {
        setCategoryId(cat.id);
        setCategoryName(cat.name);
        setParameters([]);
        setLoadingParams(true);
        const children = await fetchCategoryChildren(cat.id);
        setCategorySuggestions(children);
        setShowCategoryPicker(true);
        setLoadingParams(false);
        return;
      }

      // Leaf category — close picker and load parameters
      setShowCategoryPicker(false);
      const country = getCountryFromEan(currentEan);
      const ctx: ProductContext = {
        ean: currentEan,
        brand: scannedData.brand,
        weight: scannedData.weight,
        // For manual entry, scannedData.productName is "" — use productTitle instead
        productName: scannedData.productName || productTitle,
        country,
      };
      await applyCategory(cat.id, cat.name, [], scannedData.prefillValues || {}, ctx, true);
    },
    [scannedData, currentEan, productTitle, applyCategory]
  );

  const updateForm = useCallback((id: string, value: Partial<ParameterValue>) => {
    setFormState((prev) => ({ ...prev, [id]: { ...prev[id], ...value, id } }));
    // Once user manually changes a field, remove it from auto-filled
    setAutoFilledIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scannedData) return;
    setSubmitAttempted(true);
    setErrorMsg(null);
    setAllegroErrors([]);

    // For manual entry, productTitle is the name entered by the user
    const resolvedProductName = (productTitle.trim() || scannedData.productName || "").trim();
    if (!resolvedProductName) {
      setErrorMsg("Wprowadź nazwę produktu.");
      return;
    }
    if (!categoryId) {
      setErrorMsg("Wybierz kategorię produktu.");
      return;
    }

    const parameters_payload = Object.values(formState).filter(
      (p) =>
        (p.values && p.values.length > 0 && p.values[0] !== "") ||
        (p.valuesIds && p.valuesIds.length > 0 && p.valuesIds[0] !== "")
    );

    const resolvedImageUrl =
      allegroImageUrl ||
      (scannedData.images && scannedData.images.length > 0 ? scannedData.images[0].url : null);

    const payload: CreateOfferRequest = {
      productId: scannedData.productId,
      categoryId: categoryId as string,
      categoryName: categoryName || undefined,
      productName: resolvedProductName,
      parameters: parameters_payload,
      productParamIds,
      imageUrl: resolvedImageUrl || undefined,
      ean: currentEan || undefined,
      description: description.trim() || undefined,
    };

    try {
      const res = await submitMutation.mutateAsync(payload);
      const newOfferId = (res as { offerId?: string }).offerId || "";
      setOfferId(newOfferId);
      setOfferUrl((res as { offerUrl?: string }).offerUrl || null);
      setOfferStatus((res as { status?: string }).status || null);
      setProductStatus((res as { productStatus?: string }).productStatus || null);
      setOfferMessage((res as { message?: string }).message || null);
      setScanHistory((prev) =>
        prev.map((e) => (e.ean === currentEan ? { ...e, offerId: newOfferId } : e))
      );
      setStep("SUCCESS");
    } catch (err: unknown) {
      // ApiError has .data = parsed JSON body; extract structured Allegro errors
      const e = err as { data?: { errors?: AllegroError[]; message?: string }; message?: string };
      const apiErrors: AllegroError[] = e.data?.errors || [];
      if (apiErrors.length > 0) {
        setAllegroErrors(apiErrors);
        setErrorMsg(e.data?.message || "Allegro zwróciło błędy walidacji.");
      } else {
        setErrorMsg(e.data?.message || e.message || "Wystąpił błąd podczas tworzenia oferty.");
      }
    }
  };

  const resetWorkflow = () => {
    setScannedData(null);
    setParameters([]);
    setFormState({});
    setAutoFilledIds(new Set());
    setManualEan("");
    setCurrentEan("");
    setOfferId(null);
    setOfferUrl(null);
    setOfferStatus(null);
    setProductStatus(null);
    setOfferMessage(null);
    setErrorMsg(null);
    setAllegroErrors([]);
    setSubmitAttempted(false);
    setCategoryId(null);
    setCategoryName("");
    setCategorySuggestions([]);
    setProductParamIds([]);
    if (userImagePreviewUrl) URL.revokeObjectURL(userImagePreviewUrl);
    setUserImagePreviewUrl(null);
    setAllegroImageUrl(null);
    setImageUploading(false);
    setDescription("");
    setProductTitle("");
    setStep("SCAN");
  };

  const sourceKind = getSourceKind(scannedData?.source);

  return (
    <div
      className="min-h-screen w-full relative pb-20"
      style={{
        backgroundImage: `url(${import.meta.env.BASE_URL}images/premium-bg.png)`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundAttachment: "fixed",
      }}
    >
      <div className="absolute inset-0 bg-background/80 backdrop-blur-[2px]" />

      <main className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 pt-12 sm:pt-20">

        {/* Header */}
        <div className="text-center mb-12">
          <motion.div
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="inline-flex items-center justify-center p-4 rounded-3xl bg-black/40 border border-white/10 shadow-2xl mb-6"
          >
            <ScanLine className="w-10 h-10 text-primary" />
          </motion.div>
          <motion.h1 initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="text-4xl md:text-5xl font-display text-white mb-4">
            iPremium Scan
          </motion.h1>
          <motion.p initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }} className="text-lg text-white/60 font-medium max-w-xl mx-auto">
            Szybkie tworzenie ofert Allegro na podstawie kodów kreskowych
          </motion.p>
        </div>

        <AllegroAuthBanner />

        <LocationSetup onConfigured={() => {}} />

        <AnimatePresence mode="wait">

          {/* STEP 1: SCAN */}
          {step === "SCAN" && (
            <motion.div key="scan-step" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }} transition={{ duration: 0.3 }} className="space-y-8">
              <BarcodeScanner onScan={handleScan} />
              <div className="flex items-center gap-4 max-w-sm mx-auto">
                <div className="h-px bg-white/10 flex-1" />
                <span className="text-xs font-semibold tracking-wider text-white/40 uppercase">LUB RĘCZNIE</span>
                <div className="h-px bg-white/10 flex-1" />
              </div>
              <form onSubmit={(e) => { e.preventDefault(); handleScan(manualEan); }} className="max-w-sm mx-auto space-y-4">
                {errorMsg && (
                  <div className="p-3 rounded-lg bg-destructive/20 border border-destructive/50 text-destructive-foreground text-sm text-center">{errorMsg}</div>
                )}
                <PremiumInput placeholder="Wprowadź kod EAN..." value={manualEan} onChange={(e) => setManualEan(e.target.value)} autoFocus />
                <PremiumButton type="submit" className="w-full">Szukaj EAN</PremiumButton>
              </form>
              <div className="max-w-sm mx-auto">
                <ScanHistory entries={scanHistory} onRescan={handleScan} />
              </div>
            </motion.div>
          )}

          {/* STEP 2: LOADING */}
          {step === "LOADING" && (
            <motion.div key="loading-step" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-20 flex flex-col items-center justify-center text-center">
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full" />
                <RefreshCw className="w-12 h-12 text-primary animate-spin relative z-10" />
              </div>
              <p className="mt-6 text-lg font-medium text-white/80">Pobieranie danych katalogowych...</p>
              {currentEan && <p className="mt-2 text-sm text-white/40 font-mono">{currentEan}</p>}
            </motion.div>
          )}

          {/* STEP 3: FORM */}
          {step === "FORM" && scannedData && (
            <motion.div key="form-step" initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -40 }} transition={{ duration: 0.4, ease: "easeOut" }} className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 sm:p-10 shadow-2xl">

              {/* Source Banner */}
              <SourceBanner source={scannedData.source} productId={scannedData.productId} productName={scannedData.productName} />

              {/* Product header */}
              <div className="flex flex-col md:flex-row gap-8 mb-8">
                {/* Image panel — always shown */}
                <div className="w-full md:w-1/3 shrink-0">
                  {(() => {
                    const displayUrl = userImagePreviewUrl || allegroImageUrl || (scannedData.images && scannedData.images.length > 0 ? scannedData.images[0].url : null);
                    return (
                      <div className="aspect-square rounded-2xl overflow-hidden bg-white/5 border border-white/10 relative group">
                        {displayUrl ? (
                          <>
                            <img
                              src={displayUrl}
                              alt={scannedData.productName || ""}
                              className="w-full h-full object-contain p-4 group-hover:scale-105 transition-transform duration-500"
                            />
                            {imageUploading && (
                              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                <Loader2 className="w-8 h-8 text-primary animate-spin" />
                              </div>
                            )}
                            {/* Change photo button */}
                            <label className="absolute bottom-2 right-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-black/70 hover:bg-black/90 border border-white/20 text-white/70 hover:text-white text-xs cursor-pointer transition-colors">
                              <Camera className="w-3.5 h-3.5" />
                              Zmień
                              <input
                                type="file"
                                accept="image/*"
                                capture="environment"
                                className="hidden"
                                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }}
                              />
                            </label>
                          </>
                        ) : (
                          <label className="flex flex-col items-center justify-center h-full gap-3 cursor-pointer group/upload">
                            {imageUploading ? (
                              <Loader2 className="w-10 h-10 text-primary animate-spin" />
                            ) : (
                              <>
                                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center group-hover/upload:bg-primary/20 transition-colors">
                                  <ImageIcon className="w-8 h-8 text-primary/60 group-hover/upload:text-primary/80 transition-colors" />
                                </div>
                                <div className="text-center px-4">
                                  <p className="text-white/60 text-sm font-medium">Brak zdjęcia</p>
                                  <p className="text-white/30 text-xs mt-0.5">Dotknij aby dodać</p>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary/10 hover:bg-primary/20 border border-primary/20 text-primary text-xs transition-colors">
                                  <Camera className="w-3.5 h-3.5" />
                                  Aparat lub galeria
                                </div>
                              </>
                            )}
                            <input
                              type="file"
                              accept="image/*"
                              capture="environment"
                              className="hidden"
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); }}
                            />
                          </label>
                        )}
                      </div>
                    );
                  })()}
                  {userImagePreviewUrl && !allegroImageUrl && !imageUploading && (
                    <p className="text-amber-400/70 text-xs mt-2 text-center">
                      Zdjęcie nie zostało przesłane na Allegro
                    </p>
                  )}
                  {allegroImageUrl && (
                    <p className="text-green-400/70 text-xs mt-2 text-center flex items-center justify-center gap-1">
                      <CheckCheck className="w-3 h-3" />
                      Zdjęcie gotowe
                      {scannedData?.source && scannedData.source !== "allegro_catalog" && (
                        <span className="text-white/30 ml-1">· {friendlySourceName(scannedData.source)}</span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex-1 space-y-3">
                  {/* Category row with change button */}
                  <div className="relative">
                    <div className="flex items-center gap-2 flex-wrap">
                      {categoryName ? (
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold uppercase tracking-wider">
                          <Layers className="w-3.5 h-3.5" />
                          {categoryName}
                          {categoryId && <span className="opacity-60 font-mono">#{categoryId}</span>}
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Brak kategorii
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={async () => {
                          const opening = !showCategoryPicker;
                          setShowCategoryPicker(opening);
                          // When opening with no suggestions yet, default to Supermarket subcategories
                          if (opening && categorySuggestions.length === 0) {
                            const children = await fetchCategoryChildren("258832");
                            setCategorySuggestions(children);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white/80 text-xs transition-colors"
                      >
                        <Edit2 className="w-3 h-3" /> Zmień kategorię
                        <ChevronDown className={`w-3 h-3 transition-transform ${showCategoryPicker ? "rotate-180" : ""}`} />
                      </button>
                    </div>
                    {showCategoryPicker && (
                      <CategoryPicker
                        suggestions={categorySuggestions}
                        currentCatName={categoryName}
                        onSelect={handleCategoryChange}
                        onClose={() => setShowCategoryPicker(false)}
                      />
                    )}
                  </div>

                  {/* Product name — editable input for manual entry, static heading otherwise */}
                  {(!scannedData.productId && !scannedData.productName) ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold uppercase tracking-wider text-white/40">
                        Nazwa produktu <span className="text-primary">*</span>
                      </label>
                      <PremiumInput
                        value={productTitle}
                        onChange={(e) => setProductTitle(e.target.value)}
                        placeholder="Wpisz pełną nazwę produktu..."
                      />
                      {submitAttempted && !productTitle.trim() && (
                        <p className="text-red-400 text-xs flex items-center gap-1">
                          <AlertCircle className="w-3 h-3" /> Nazwa jest wymagana
                        </p>
                      )}
                    </div>
                  ) : (
                    <h2 className="text-2xl sm:text-3xl font-display text-white leading-tight">{scannedData.productName}</h2>
                  )}

                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {scannedData.productId && (
                      <p className="text-white/40 flex items-center gap-1.5"><Box className="w-3.5 h-3.5" /><span className="font-mono text-white/60">{scannedData.productId}</span></p>
                    )}
                    {scannedData.brand && <p className="text-white/40">Marka: <span className="text-white/70">{scannedData.brand}</span></p>}
                    {scannedData.weight && <p className="text-white/40">Waga: <span className="text-white/70">{scannedData.weight}</span></p>}
                    {currentEan && <p className="text-white/30 text-xs font-mono">EAN: {currentEan}</p>}
                    {getCountryFromEan(currentEan) && <p className="text-white/30 text-xs">Kraj: {getCountryFromEan(currentEan)}</p>}
                  </div>
                </div>
              </div>

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-8">

                {/* Parameter section */}
                <div className="space-y-5">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h3 className="text-xl font-display text-white">Parametry produktu</h3>
                    <div className="flex items-center gap-3 text-xs text-white/40">
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-500/40 border border-green-500/60 inline-block" /> Auto-wypełnione</span>
                    </div>
                  </div>

                  {/* Progress */}
                  <ParamProgress formState={formState} params={parameters} />

                  {loadingParams && (
                    <div className="flex items-center gap-3 text-white/50 py-6 justify-center">
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span className="text-sm">Pobieranie parametrów kategorii...</span>
                    </div>
                  )}

                  {!loadingParams && parameters.length === 0 && (
                    <div className="py-8 text-center text-white/40 text-sm">
                      {categoryId ? "Brak wymaganych parametrów." : "Wybierz kategorię, aby zobaczyć parametry."}
                    </div>
                  )}

                  {!loadingParams && parameters.some((p) => p.required) && (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        {parameters.filter((p) => p.required).map((param) => {
                                const isAutoFilled = autoFilledIds.has(param.id);
                                const hasValue =
                                  (formState[param.id]?.values?.[0] && formState[param.id]?.values?.[0] !== "") ||
                                  (formState[param.id]?.valuesIds?.[0] && formState[param.id]?.valuesIds?.[0] !== "");
                                const isEmptyRequired = param.required && !hasValue && submitAttempted;
                                const borderClass = isAutoFilled
                                  ? "border-green-500/50 bg-green-500/5"
                                  : isEmptyRequired
                                  ? "border-red-500/50 bg-red-500/5"
                                  : "";

                                return (
                                  <div key={param.id} className="space-y-1.5">
                                    <label className="text-sm font-medium text-white/80 flex items-center justify-between gap-2">
                                      <span className="flex items-center gap-1.5">
                                        {param.name}
                                        {param.required && <span className="text-primary text-xs">*</span>}
                                        {isAutoFilled && (
                                          <span className="text-green-400 text-xs font-normal flex items-center gap-0.5">
                                            <CheckCheck className="w-3 h-3" /> auto
                                          </span>
                                        )}
                                      </span>
                                      {param.unit && <span className="text-white/30 text-xs shrink-0">({param.unit})</span>}
                                    </label>

                                    {param.type === "dictionary" && param.options.length > 0 ? (
                                      <CustomSelect
                                        value={formState[param.id]?.valuesIds?.[0] || ""}
                                        onChange={(v) => updateForm(param.id, { valuesIds: [v] })}
                                        options={param.options.map((opt) => ({ value: opt.id, label: opt.name }))}
                                        required={param.required}
                                        className={borderClass}
                                      />
                                    ) : param.type === "boolean" ? (
                                      <div className={`flex h-12 items-center px-4 rounded-xl bg-black/20 border ${isAutoFilled ? "border-green-500/50" : "border-white/5"}`}>
                                        <PremiumSwitch
                                          checked={formState[param.id]?.values?.[0] === "true"}
                                          onChange={(val) => updateForm(param.id, { values: [val ? "true" : "false"] })}
                                        />
                                        <span className="ml-3 text-sm text-white/60">
                                          {formState[param.id]?.values?.[0] === "true" ? "Tak" : "Nie"}
                                        </span>
                                      </div>
                                    ) : (
                                      <PremiumInput
                                        type={param.type === "float" || param.type === "integer" ? "number" : "text"}
                                        step={param.type === "float" ? "0.01" : param.type === "integer" ? "1" : undefined}
                                        min={param.restrictions?.min != null ? String(param.restrictions.min) : undefined}
                                        max={param.restrictions?.max != null ? String(param.restrictions.max) : undefined}
                                        maxLength={param.restrictions?.maxLength != null ? Number(param.restrictions.maxLength) : undefined}
                                        placeholder={`Wprowadź ${param.name.toLowerCase()}...`}
                                        value={formState[param.id]?.values?.[0] || ""}
                                        onChange={(e) => updateForm(param.id, { values: [e.target.value] })}
                                        required={param.required}
                                        className={borderClass}
                                      />
                                    )}

                                    {isEmptyRequired && (
                                      <p className="text-red-400 text-xs flex items-center gap-1">
                                        <AlertCircle className="w-3 h-3" /> To pole jest wymagane
                                      </p>
                                    )}
                                  </div>
                                );
                        })}
                      </div>

                    </>
                  )}
                </div>

                {/* Description field */}
                <div className="space-y-2 pt-2">
                  <label className="text-sm font-medium text-white/80 flex items-center gap-1.5">
                    Opis oferty
                    <span className="text-primary text-xs">*</span>
                    <span className="text-white/30 text-xs font-normal ml-1">(wymagany przez Allegro)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={3}
                    placeholder="Opis produktu..."
                    className="w-full rounded-xl bg-black/30 border border-white/10 focus:border-primary/60 focus:ring-2 focus:ring-primary/20 text-white placeholder:text-white/30 text-sm px-4 py-3 resize-none outline-none transition-all"
                  />
                  {submitAttempted && !description.trim() && (
                    <p className="text-red-400 text-xs flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Opis jest wymagany
                    </p>
                  )}
                </div>

                {(errorMsg || allegroErrors.length > 0) && (
                  <div className="space-y-3">
                    <div className="p-4 rounded-xl bg-destructive/20 border border-destructive/50 flex items-start gap-3">
                      <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                      <p className="text-destructive-foreground text-sm font-medium">{errorMsg}</p>
                    </div>
                    {allegroErrors.length > 0 && (
                      <div className="rounded-xl border border-destructive/30 bg-destructive/10 overflow-hidden">
                        <div className="px-4 py-2 border-b border-destructive/20 flex items-center gap-2">
                          <span className="text-xs font-semibold text-destructive/80 uppercase tracking-wider">Błędy Allegro API ({allegroErrors.length})</span>
                        </div>
                        <div className="divide-y divide-destructive/10">
                          {allegroErrors.map((err, i) => (
                            <div key={i} className="px-4 py-3 space-y-0.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                {err.code && <span className="font-mono text-xs bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">{err.code}</span>}
                                {err.path && <span className="text-xs text-white/40 font-mono">@ {err.path}</span>}
                              </div>
                              <p className="text-sm text-destructive-foreground/90">{err.userMessage || err.message}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-4 pt-6 border-t border-white/10">
                  <PremiumButton type="button" variant="secondary" onClick={resetWorkflow} className="sm:w-auto">Anuluj</PremiumButton>
                  <PremiumButton type="submit" isLoading={submitMutation.isPending} className="flex-1">
                    Wystaw ofertę na Allegro
                  </PremiumButton>
                </div>
              </form>
            </motion.div>
          )}

          {/* STEP 4: SUCCESS */}
          {step === "SUCCESS" && (
            <motion.div key="success-step" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-10 text-center shadow-2xl max-w-xl mx-auto">
              <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-6 ${offerStatus === "ACTIVE" ? "bg-green-500/10" : "bg-amber-500/10"}`}>
                <CheckCircle2 className={`w-10 h-10 ${offerStatus === "ACTIVE" ? "text-green-500" : "text-amber-400"}`} />
              </div>
              <h2 className="text-3xl font-display text-white mb-3">
                {offerStatus === "ACTIVE" ? "Oferta aktywna!" : "Oferta złożona!"}
              </h2>
              <p className="text-white/60 mb-2 text-sm leading-relaxed max-w-sm mx-auto">
                {offerMessage || (offerStatus === "ACTIVE"
                  ? "Oferta jest aktywna i widoczna na Allegro za 999 PLN."
                  : "Produkt oczekuje na akceptację Allegro — oferta aktywuje się automatycznie."
                )}
              </p>
              {productStatus === "PROPOSED" && (
                <p className="text-amber-400/70 text-xs mb-4">
                  Nowy produkt wymaga akceptacji Allegro (zazwyczaj do 24h).
                </p>
              )}

              {offerId && (
                <div className={`border rounded-xl p-4 mb-5 flex flex-col items-center justify-center ${offerStatus === "ACTIVE" ? "bg-green-500/5 border-green-500/20" : "bg-amber-500/5 border-amber-500/20"}`}>
                  <span className={`text-xs font-semibold uppercase tracking-wider mb-1 ${offerStatus === "ACTIVE" ? "text-green-400/60" : "text-amber-400/60"}`}>ID Oferty</span>
                  <span className={`font-mono text-xl ${offerStatus === "ACTIVE" ? "text-green-400" : "text-amber-300"}`}>{offerId}</span>
                </div>
              )}

              <div className="flex flex-col gap-3 mb-8">
                {offerUrl && (
                  <a
                    href={offerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`inline-flex items-center justify-center gap-2 w-full px-5 py-3 rounded-xl border font-medium text-sm transition-colors ${offerStatus === "ACTIVE" ? "bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20" : "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"}`}
                  >
                    <ExternalLink className="w-4 h-4" />
                    {offerStatus === "ACTIVE" ? "Otwórz ofertę na Allegro" : "Podgląd oferty na Allegro"}
                  </a>
                )}
                <a
                  href="https://allegro.pl/moje-allegro/sprzedaz/oferty"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center gap-2 w-full px-5 py-3 rounded-xl bg-white/5 border border-white/10 text-white/50 hover:text-white/70 transition-colors text-sm"
                >
                  Przejdź do Moje Allegro → Oferty
                </a>
              </div>

              <PremiumButton onClick={resetWorkflow} className="w-full">Skanuj kolejny produkt</PremiumButton>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
