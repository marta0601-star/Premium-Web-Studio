import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ScanLine, Box, CheckCircle2, AlertCircle, RefreshCw, Layers,
  ExternalLink, Clock, ChevronRight,
} from "lucide-react";
import { useScanBarcode, useSubmitOffer } from "@/hooks/use-allegro";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PremiumButton, PremiumInput, PremiumSelect, PremiumSwitch } from "@/components/ui-custom";
import { AllegroAuthBanner } from "@/components/AllegroAuth";
import type { ScanResult, CreateOfferRequest, ParameterValue } from "@workspace/api-client-react";

type WorkflowStep = "SCAN" | "LOADING" | "FORM" | "SUCCESS";

// Extended type — includes fields the server returns but the generated client omits
interface ExtendedScanResult extends ScanResult {
  source?: string | null;
  brand?: string | null;
  weight?: string | null;
  category?: string | null;
  logs?: string[];
}

type SourceKind = "allegro" | "external" | "manual";

interface HistoryEntry {
  ean: string;
  productName: string;
  source: string | null | undefined;
  kind: SourceKind;
  offerId?: string;
  ts: number;
}

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

// ── Source badge shown in the FORM step ───────────────────────────────────────
function SourceBanner({ source, productId }: { source: string | null | undefined; productId?: string | null }) {
  const kind = getSourceKind(source);

  if (kind === "allegro") {
    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/30 mb-6">
        <span className="text-green-400 text-lg leading-none">✅</span>
        <div className="flex-1 min-w-0">
          <p className="text-green-300 font-semibold text-sm">Produkt znaleziony w katalogu Allegro</p>
          {productId && (
            <p className="text-green-400/70 text-xs mt-0.5 font-mono truncate">ID: {productId}</p>
          )}
        </div>
        {productId && (
          <a
            href={`https://allegro.pl/product/${productId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 text-green-300 text-xs font-semibold transition-colors shrink-0"
          >
            Otwórz na Allegro
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    );
  }

  if (kind === "external") {
    return (
      <div className="flex flex-col gap-2 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/30 mb-6">
        <div className="flex items-start gap-3">
          <span className="text-amber-400 text-lg leading-none mt-0.5">⚠️</span>
          <div>
            <p className="text-amber-300 font-semibold text-sm">
              Produkt NIE jest w katalogu Allegro — znaleziony w:{" "}
              <span className="font-bold">{friendlySourceName(source)}</span>
            </p>
            <p className="text-amber-400/70 text-xs mt-1">
              Aby utworzyć ofertę, musisz ręcznie wybrać kategorię Allegro.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 mb-6">
      <span className="text-red-400 text-lg leading-none mt-0.5">❌</span>
      <p className="text-red-300 font-semibold text-sm">
        Produkt nie znaleziony — wypełnij dane ręcznie
      </p>
    </div>
  );
}

// ── Small dot badge used in history list ─────────────────────────────────────
function KindDot({ kind }: { kind: SourceKind }) {
  if (kind === "allegro") return <span title="Znaleziono w katalogu Allegro" className="text-base leading-none">🟢</span>;
  if (kind === "external") return <span title="Znaleziono zewnętrznie" className="text-base leading-none">🟠</span>;
  return <span title="Wprowadzono ręcznie" className="text-base leading-none">🔴</span>;
}

// ── History panel shown above the scan form ───────────────────────────────────
function ScanHistory({ entries, onRescan }: { entries: HistoryEntry[]; onRescan: (ean: string) => void }) {
  if (entries.length === 0) return null;
  return (
    <div className="bg-black/30 border border-white/8 rounded-2xl p-4 space-y-2 mb-8">
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
            <p className="text-white/35 text-xs font-mono truncate">{entry.ean}</p>
          </div>
          {entry.offerId && (
            <span className="text-xs text-green-400/70 font-mono shrink-0 hidden sm:block">
              #{entry.offerId.slice(0, 8)}
            </span>
          )}
          <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/40 transition-colors shrink-0" />
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>("SCAN");
  const [manualEan, setManualEan] = useState("");
  const [currentEan, setCurrentEan] = useState("");
  const [scannedData, setScannedData] = useState<ExtendedScanResult | null>(null);
  const [formState, setFormState] = useState<Record<string, ParameterValue>>({});
  const [offerId, setOfferId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [scanHistory, setScanHistory] = useState<HistoryEntry[]>([]);

  const scanMutation = useScanBarcode();
  const submitMutation = useSubmitOffer();

  const handleScan = async (ean: string) => {
    const trimmed = ean.trim();
    if (!trimmed) return;
    setErrorMsg(null);
    setCurrentEan(trimmed);
    setManualEan("");
    setStep("LOADING");

    try {
      const data = await scanMutation.mutateAsync(trimmed) as ExtendedScanResult;
      setScannedData(data);

      // Add to history (most recent first, no duplicates)
      const kind = getSourceKind(data.source);
      setScanHistory(prev => {
        const without = prev.filter(e => e.ean !== trimmed);
        const entry: HistoryEntry = {
          ean: trimmed,
          productName: data.productName || "Nieznany produkt",
          source: data.source,
          kind,
          ts: Date.now(),
        };
        return [entry, ...without].slice(0, 10);
      });

      const initialForm: Record<string, ParameterValue> = {};
      data.parameters?.forEach(param => {
        const prefill = data.prefillValues?.[param.id];
        if (prefill) {
          if (param.type === "dictionary") {
            const matchedOpt = param.options?.find(o => o.id === prefill || o.name === prefill);
            if (matchedOpt) {
              initialForm[param.id] = { id: param.id, valuesIds: [matchedOpt.id] };
            }
          } else if (param.type === "boolean") {
            initialForm[param.id] = { id: param.id, values: [prefill === "true" || prefill === "1" || prefill === true ? "true" : "false"] };
          } else {
            initialForm[param.id] = { id: param.id, values: [prefill] };
          }
        } else {
          initialForm[param.id] = { id: param.id };
        }
      });

      setFormState(initialForm);
      setStep("FORM");
    } catch (err: any) {
      console.error(err);
      setErrorMsg("Nie znaleziono produktu o podanym kodzie EAN lub wystąpił błąd serwera.");
      // Add "not found" to history
      setScanHistory(prev => {
        const without = prev.filter(e => e.ean !== trimmed);
        return [{ ean: trimmed, productName: "Nie znaleziono", source: null, kind: "manual", ts: Date.now() }, ...without].slice(0, 10);
      });
      setStep("SCAN");
    }
  };

  const updateForm = (id: string, value: Partial<ParameterValue>) => {
    setFormState(prev => ({ ...prev, [id]: { ...prev[id], ...value, id } }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scannedData) return;
    setErrorMsg(null);

    const parameters = Object.values(formState).filter(
      p => (p.values && p.values.length > 0 && p.values[0] !== "") ||
           (p.valuesIds && p.valuesIds.length > 0 && p.valuesIds[0] !== "")
    );

    const payload: CreateOfferRequest = {
      productId: scannedData.productId,
      categoryId: scannedData.categoryId,
      productName: scannedData.productName,
      parameters,
    };

    try {
      const res = await submitMutation.mutateAsync(payload);
      const newOfferId = res.offerId || "Zapisano szkic";
      setOfferId(newOfferId);
      // Update history entry with offerId
      setScanHistory(prev => prev.map(e =>
        e.ean === currentEan ? { ...e, offerId: newOfferId } : e
      ));
      setStep("SUCCESS");
    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "Wystąpił błąd podczas tworzenia oferty.");
    }
  };

  const resetWorkflow = () => {
    setScannedData(null);
    setFormState({});
    setManualEan("");
    setCurrentEan("");
    setOfferId(null);
    setErrorMsg(null);
    setStep("SCAN");
  };

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
          <motion.h1
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="text-4xl md:text-5xl font-display text-white mb-4"
          >
            iPremium Scan
          </motion.h1>
          <motion.p
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="text-lg text-white/60 font-medium max-w-xl mx-auto"
          >
            Szybkie tworzenie ofert Allegro na podstawie kodów kreskowych
          </motion.p>
        </div>

        {/* Allegro Auth Banner */}
        <AllegroAuthBanner />

        {/* Global Error Banner */}
        <AnimatePresence>
          {errorMsg && step !== "SCAN" && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="mb-8 p-4 rounded-xl bg-destructive/20 border border-destructive/50 flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
              <p className="text-destructive-foreground text-sm font-medium">{errorMsg}</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Workflow Stages */}
        <AnimatePresence mode="wait">

          {/* STEP 1: SCAN */}
          {step === "SCAN" && (
            <motion.div
              key="scan-step"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
              transition={{ duration: 0.3 }}
              className="space-y-8"
            >
              <BarcodeScanner onScan={handleScan} />

              <div className="flex items-center gap-4 max-w-sm mx-auto">
                <div className="h-px bg-white/10 flex-1" />
                <span className="text-xs font-semibold tracking-wider text-white/40 uppercase">LUB RĘCZNIE</span>
                <div className="h-px bg-white/10 flex-1" />
              </div>

              <form
                onSubmit={(e) => { e.preventDefault(); handleScan(manualEan); }}
                className="max-w-sm mx-auto space-y-4"
              >
                {errorMsg && (
                  <div className="p-3 rounded-lg bg-destructive/20 border border-destructive/50 text-destructive-foreground text-sm text-center">
                    {errorMsg}
                  </div>
                )}
                <PremiumInput
                  placeholder="Wprowadź kod EAN..."
                  value={manualEan}
                  onChange={(e) => setManualEan(e.target.value)}
                  autoFocus
                />
                <PremiumButton type="submit" className="w-full">
                  Szukaj EAN
                </PremiumButton>
              </form>

              {/* Scan History */}
              <div className="max-w-sm mx-auto">
                <ScanHistory entries={scanHistory} onRescan={handleScan} />
              </div>
            </motion.div>
          )}

          {/* STEP 2: LOADING */}
          {step === "LOADING" && (
            <motion.div
              key="loading-step"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="py-20 flex flex-col items-center justify-center text-center"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full" />
                <RefreshCw className="w-12 h-12 text-primary animate-spin relative z-10" />
              </div>
              <p className="mt-6 text-lg font-medium text-white/80">Pobieranie danych katalogowych...</p>
              {currentEan && (
                <p className="mt-2 text-sm text-white/40 font-mono">{currentEan}</p>
              )}
            </motion.div>
          )}

          {/* STEP 3: FORM */}
          {step === "FORM" && scannedData && (
            <motion.div
              key="form-step"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -40 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 sm:p-10 shadow-2xl"
            >
              {/* Source Banner — always first, most important info */}
              <SourceBanner source={scannedData.source} productId={scannedData.productId} />

              <div className="flex flex-col md:flex-row gap-8 mb-10">
                {scannedData.images && scannedData.images.length > 0 && (
                  <div className="w-full md:w-1/3 shrink-0">
                    <div className="aspect-square rounded-2xl overflow-hidden bg-white/5 border border-white/10 relative group">
                      <img
                        src={scannedData.images[0].url}
                        alt={scannedData.productName}
                        className="w-full h-full object-contain p-4 group-hover:scale-105 transition-transform duration-500"
                      />
                    </div>
                  </div>
                )}

                <div className="flex-1 space-y-4">
                  {scannedData.categoryName && (
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold uppercase tracking-wider">
                      <Layers className="w-3.5 h-3.5" />
                      {scannedData.categoryName}
                    </div>
                  )}
                  <h2 className="text-2xl sm:text-3xl font-display text-white leading-tight">
                    {scannedData.productName}
                  </h2>

                  {/* Product metadata */}
                  <div className="space-y-1.5">
                    {scannedData.productId && (
                      <p className="text-white/50 text-sm flex items-center gap-2">
                        <Box className="w-4 h-4 shrink-0" />
                        ID Produktu:{" "}
                        <span className="font-mono text-white/70">{scannedData.productId}</span>
                      </p>
                    )}
                    {scannedData.brand && (
                      <p className="text-white/50 text-sm">
                        Marka: <span className="text-white/70">{scannedData.brand}</span>
                      </p>
                    )}
                    {scannedData.weight && (
                      <p className="text-white/50 text-sm">
                        Waga/Objętość: <span className="text-white/70">{scannedData.weight}</span>
                      </p>
                    )}
                    {currentEan && (
                      <p className="text-white/30 text-xs font-mono">EAN: {currentEan}</p>
                    )}
                  </div>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-8">
                <div className="space-y-6">
                  <h3 className="text-xl font-display text-white border-b border-white/10 pb-4">
                    Parametry produktu
                  </h3>

                  {/* Category note for external sources */}
                  {getSourceKind(scannedData.source) === "external" && (
                    <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                      <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-amber-300/80 text-xs leading-relaxed">
                        Produkt pochodzi ze źródła zewnętrznego — kategoria Allegro nie jest znana. 
                        Wybierz odpowiednią kategorię przed wysłaniem oferty.
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {scannedData.parameters?.map((param) => (
                      <div key={param.id} className="space-y-2">
                        <label className="text-sm font-medium text-white/80 flex items-center justify-between">
                          <span>{param.name} {param.required && <span className="text-primary">*</span>}</span>
                          {param.unit && <span className="text-white/40 text-xs">({param.unit})</span>}
                        </label>

                        {param.type === "dictionary" && param.options ? (
                          <PremiumSelect
                            value={formState[param.id]?.valuesIds?.[0] || ""}
                            onChange={(e) => updateForm(param.id, { valuesIds: [e.target.value] })}
                            required={param.required}
                          >
                            <option value="" disabled className="bg-background text-white/50">Wybierz wartość...</option>
                            {param.options.map(opt => (
                              <option key={opt.id} value={opt.id} className="bg-background text-white">{opt.name}</option>
                            ))}
                          </PremiumSelect>
                        ) : param.type === "boolean" ? (
                          <div className="flex h-12 items-center px-4 rounded-xl bg-black/20 border border-white/5">
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
                            type={param.type === "string" ? "text" : "number"}
                            step={param.type === "float" ? "0.01" : "1"}
                            placeholder={`Wprowadź ${param.name.toLowerCase()}...`}
                            value={formState[param.id]?.values?.[0] || ""}
                            onChange={(e) => updateForm(param.id, { values: [e.target.value] })}
                            required={param.required}
                          />
                        )}
                      </div>
                    ))}

                    {(!scannedData.parameters || scannedData.parameters.length === 0) && (
                      <div className="col-span-full py-8 text-center text-white/40">
                        Brak wymaganych parametrów do uzupełnienia.
                      </div>
                    )}
                  </div>
                </div>

                {errorMsg && (
                  <div className="p-4 rounded-xl bg-destructive/20 border border-destructive/50 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                    <p className="text-destructive-foreground text-sm font-medium">{errorMsg}</p>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row gap-4 pt-6 border-t border-white/10">
                  <PremiumButton
                    type="button"
                    variant="secondary"
                    onClick={resetWorkflow}
                    className="sm:w-auto"
                  >
                    Anuluj
                  </PremiumButton>
                  <PremiumButton
                    type="submit"
                    isLoading={submitMutation.isPending}
                    className="flex-1"
                  >
                    Utwórz ofertę (Szkic)
                  </PremiumButton>
                </div>
              </form>
            </motion.div>
          )}

          {/* STEP 4: SUCCESS */}
          {step === "SUCCESS" && (
            <motion.div
              key="success-step"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-10 text-center shadow-2xl max-w-xl mx-auto"
            >
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 mb-6">
                <CheckCircle2 className="w-10 h-10 text-green-500" />
              </div>
              <h2 className="text-3xl font-display text-white mb-4">Oferta utworzona!</h2>
              <p className="text-white/60 mb-8">
                Szkic oferty został pomyślnie zapisany w systemie Allegro z ceną bazową 999 PLN.
              </p>

              <div className="bg-black/40 border border-white/5 rounded-xl p-4 mb-4 flex flex-col items-center justify-center">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-1">ID Oferty</span>
                <span className="font-mono text-xl text-primary">{offerId}</span>
              </div>

              {offerId && offerId !== "Zapisano szkic" && (
                <a
                  href={`https://allegro.pl/moje-allegro/sprzedaz/oferty/edytuj/${offerId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors mb-8"
                >
                  Otwórz ofertę na Allegro <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}

              <PremiumButton onClick={resetWorkflow} className="w-full">
                Skanuj kolejny produkt
              </PremiumButton>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
