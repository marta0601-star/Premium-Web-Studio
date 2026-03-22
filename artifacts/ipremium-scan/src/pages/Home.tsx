import { useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ScanLine, Box, CheckCircle2, AlertCircle, RefreshCw, Layers,
  ExternalLink, Clock, ChevronRight, ChevronDown, Edit2, CheckCheck,
} from "lucide-react";
import { useScanBarcode, useSubmitOffer } from "@/hooks/use-allegro";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PremiumButton, PremiumInput, PremiumSelect, PremiumSwitch } from "@/components/ui-custom";
import { AllegroAuthBanner } from "@/components/AllegroAuth";
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
  source: string | null;
  brand?: string | null;
  weight?: string | null;
  category?: string | null;
  ean?: string;
  logs?: string[];
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
  const exact = options.find((o) => o.name.toLowerCase() === q);
  if (exact) return exact.id;
  const partial = options.find((o) => o.name.toLowerCase().includes(q) || q.includes(o.name.toLowerCase()));
  if (partial) return partial.id;
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
    // 1. Allegro catalog prefill (highest priority)
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

function SourceBanner({
  source,
  productId,
}: {
  source: string | null | undefined;
  productId?: string | null;
}) {
  const kind = getSourceKind(source);
  if (kind === "allegro") {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/30 mb-6">
        <span className="text-green-400 text-lg leading-none">✅</span>
        <div className="flex-1 min-w-0">
          <p className="text-green-300 font-semibold text-sm">Produkt znaleziony w katalogu Allegro</p>
          {productId && <p className="text-green-400/70 text-xs mt-0.5 font-mono truncate">ID: {productId}</p>}
        </div>
        {productId && (
          <a
            href={`https://allegro.pl/product/${productId}`}
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

// Category picker
function CategoryPicker({
  suggestions,
  onSelect,
  onClose,
}: {
  suggestions: CategorySuggestion[];
  onSelect: (cat: CategorySuggestion) => void;
  onClose: () => void;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-zinc-900 border border-white/20 rounded-xl p-4 shadow-2xl">
        <p className="text-white/50 text-sm text-center">Brak sugestii kategorii</p>
        <button onClick={onClose} className="mt-2 w-full text-xs text-white/30 hover:text-white/60">Zamknij</button>
      </div>
    );
  }
  return (
    <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-zinc-900 border border-white/20 rounded-xl shadow-2xl overflow-hidden max-h-72 overflow-y-auto">
      {suggestions.map((cat) => (
        <button
          key={cat.id}
          onClick={() => { onSelect(cat); onClose(); }}
          className="w-full flex flex-col gap-0.5 px-4 py-3 hover:bg-white/5 text-left border-b border-white/5 last:border-0"
        >
          <span className="text-white text-sm font-medium">{cat.name}</span>
          {cat.path && cat.path.length > 1 && (
            <span className="text-white/35 text-xs truncate">
              {cat.path.slice(1).map((p) => p.name).join(" › ")}
            </span>
          )}
        </button>
      ))}
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [scanHistory, setScanHistory] = useState<HistoryEntry[]>([]);

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

    try {
      const data = await scanMutation.mutateAsync(trimmed) as ExtendedScanResult;
      setScannedData(data);

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
        // External source — suggest category, then fetch parameters
        setStep("FORM");
        setCategoryId(null);
        setCategoryName("");
        setParameters([]);

        const productName = data.productName || "";
        if (productName) {
          const [suggestions] = await Promise.all([
            fetchMatchingCategories(productName),
          ]);
          setCategorySuggestions(suggestions);

          if (suggestions.length > 0) {
            const first = suggestions[0];
            const params = await fetchCategoryParameters(first.id);
            setCategoryId(first.id);
            setCategoryName(first.name);
            setParameters(params);
            const { formState: fs, autoFilledIds: ai } = buildAutoFilledState(params, {}, ctx);
            setFormState(fs);
            setAutoFilledIds(ai);
          }
        }
      }
    } catch (err: unknown) {
      console.error(err);
      setErrorMsg("Nie znaleziono produktu o podanym kodzie EAN lub wystąpił błąd serwera.");
      setScanHistory((prev) => {
        const without = prev.filter((e) => e.ean !== trimmed);
        return [{ ean: trimmed, productName: "Nie znaleziono", source: null, kind: "manual", ts: Date.now() }, ...without].slice(0, 10);
      });
      setStep("SCAN");
    }
  }, [scanMutation]);

  const handleCategoryChange = useCallback(
    async (cat: CategorySuggestion) => {
      if (!scannedData) return;
      const country = getCountryFromEan(currentEan);
      const ctx: ProductContext = {
        ean: currentEan,
        brand: scannedData.brand,
        weight: scannedData.weight,
        productName: scannedData.productName,
        country,
      };
      await applyCategory(cat.id, cat.name, [], scannedData.prefillValues || {}, ctx, true);
    },
    [scannedData, currentEan, applyCategory]
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

    const parameters_payload = Object.values(formState).filter(
      (p) =>
        (p.values && p.values.length > 0 && p.values[0] !== "") ||
        (p.valuesIds && p.valuesIds.length > 0 && p.valuesIds[0] !== "")
    );

    const payload: CreateOfferRequest = {
      productId: scannedData.productId as string,
      categoryId: categoryId as string,
      productName: scannedData.productName as string,
      parameters: parameters_payload,
    };

    try {
      const res = await submitMutation.mutateAsync(payload);
      const newOfferId = res.offerId || "Zapisano szkic";
      setOfferId(newOfferId);
      setScanHistory((prev) =>
        prev.map((e) => (e.ean === currentEan ? { ...e, offerId: newOfferId } : e))
      );
      setStep("SUCCESS");
    } catch (err: unknown) {
      const e = err as { message?: string };
      setErrorMsg(e.message || "Wystąpił błąd podczas tworzenia oferty.");
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
    setErrorMsg(null);
    setSubmitAttempted(false);
    setCategoryId(null);
    setCategoryName("");
    setCategorySuggestions([]);
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
              <SourceBanner source={scannedData.source} productId={scannedData.productId} />

              {/* Product header */}
              <div className="flex flex-col md:flex-row gap-8 mb-8">
                {scannedData.images && scannedData.images.length > 0 && (
                  <div className="w-full md:w-1/3 shrink-0">
                    <div className="aspect-square rounded-2xl overflow-hidden bg-white/5 border border-white/10 group">
                      <img src={scannedData.images[0].url} alt={scannedData.productName || ""} className="w-full h-full object-contain p-4 group-hover:scale-105 transition-transform duration-500" />
                    </div>
                  </div>
                )}
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
                      {categorySuggestions.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowCategoryPicker(!showCategoryPicker)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white/80 text-xs transition-colors"
                        >
                          <Edit2 className="w-3 h-3" /> Zmień kategorię
                          <ChevronDown className={`w-3 h-3 transition-transform ${showCategoryPicker ? "rotate-180" : ""}`} />
                        </button>
                      )}
                    </div>
                    {showCategoryPicker && (
                      <CategoryPicker
                        suggestions={categorySuggestions}
                        onSelect={handleCategoryChange}
                        onClose={() => setShowCategoryPicker(false)}
                      />
                    )}
                  </div>

                  <h2 className="text-2xl sm:text-3xl font-display text-white leading-tight">{scannedData.productName}</h2>

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
                      <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-500/20 border border-red-500/40 inline-block" /> Wymagane</span>
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

                  {!loadingParams && parameters.length > 0 && (
                    <>
                      {/* Required params first, then optional */}
                      {[true, false].map((showRequired) => {
                        const group = parameters.filter((p) => p.required === showRequired);
                        if (group.length === 0) return null;
                        return (
                          <div key={String(showRequired)} className="space-y-4">
                            <p className="text-xs font-semibold text-white/30 uppercase tracking-wider">
                              {showRequired ? "Wymagane *" : "Opcjonalne"}
                            </p>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                              {group.map((param) => {
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
                                      <PremiumSelect
                                        value={formState[param.id]?.valuesIds?.[0] || ""}
                                        onChange={(e) => updateForm(param.id, { valuesIds: [e.target.value] })}
                                        required={param.required}
                                        className={borderClass}
                                      >
                                        <option value="" disabled className="bg-background text-white/50">Wybierz wartość...</option>
                                        {param.options.map((opt) => (
                                          <option key={opt.id} value={opt.id} className="bg-background text-white">{opt.name}</option>
                                        ))}
                                      </PremiumSelect>
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
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>

                {errorMsg && (
                  <div className="p-4 rounded-xl bg-destructive/20 border border-destructive/50 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                    <p className="text-destructive-foreground text-sm font-medium">{errorMsg}</p>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-4 pt-6 border-t border-white/10">
                  <PremiumButton type="button" variant="secondary" onClick={resetWorkflow} className="sm:w-auto">Anuluj</PremiumButton>
                  <PremiumButton type="submit" isLoading={submitMutation.isPending} className="flex-1">
                    Utwórz ofertę (Szkic)
                  </PremiumButton>
                </div>
              </form>
            </motion.div>
          )}

          {/* STEP 4: SUCCESS */}
          {step === "SUCCESS" && (
            <motion.div key="success-step" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-10 text-center shadow-2xl max-w-xl mx-auto">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 mb-6">
                <CheckCircle2 className="w-10 h-10 text-green-500" />
              </div>
              <h2 className="text-3xl font-display text-white mb-4">Oferta utworzona!</h2>
              <p className="text-white/60 mb-8">Szkic oferty został pomyślnie zapisany w systemie Allegro z ceną bazową 999 PLN.</p>
              <div className="bg-black/40 border border-white/5 rounded-xl p-4 mb-4 flex flex-col items-center justify-center">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-1">ID Oferty</span>
                <span className="font-mono text-xl text-primary">{offerId}</span>
              </div>
              {offerId && offerId !== "Zapisano szkic" && (
                <a href={`https://allegro.pl/moje-allegro/sprzedaz/oferty/edytuj/${offerId}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors mb-8">
                  Otwórz ofertę na Allegro <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
              <PremiumButton onClick={resetWorkflow} className="w-full">Skanuj kolejny produkt</PremiumButton>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
