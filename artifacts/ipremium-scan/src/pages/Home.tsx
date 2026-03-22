import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ScanLine, Box, CheckCircle2, AlertCircle, RefreshCw, Layers } from "lucide-react";
import { useScanBarcode, useSubmitOffer } from "@/hooks/use-allegro";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import { PremiumButton, PremiumInput, PremiumSelect, PremiumSwitch } from "@/components/ui-custom";
import { AllegroAuthBanner } from "@/components/AllegroAuth";
import type { ScanResult, CreateOfferRequest, ParameterValue } from "@workspace/api-client-react";

type WorkflowStep = "SCAN" | "LOADING" | "FORM" | "SUCCESS";

export default function Home() {
  const [step, setStep] = useState<WorkflowStep>("SCAN");
  const [manualEan, setManualEan] = useState("");
  const [scannedData, setScannedData] = useState<ScanResult | null>(null);
  const [formState, setFormState] = useState<Record<string, ParameterValue>>({});
  const [offerId, setOfferId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scanMutation = useScanBarcode();
  const submitMutation = useSubmitOffer();

  const handleScan = async (ean: string) => {
    if (!ean.trim()) return;
    setErrorMsg(null);
    setStep("LOADING");
    
    try {
      const data = await scanMutation.mutateAsync(ean);
      setScannedData(data);
      
      // Initialize form state
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
            // Assume boolean prefill might be "true" / "false" string or similar
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
      setStep("SCAN");
    }
  };

  const updateForm = (id: string, value: Partial<ParameterValue>) => {
    setFormState(prev => ({
      ...prev,
      [id]: { ...prev[id], ...value, id }
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scannedData) return;
    
    setErrorMsg(null);
    
    // Filter out empty parameter values before sending
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
      setOfferId(res.offerId || "Zapisano szkic");
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
    setOfferId(null);
    setErrorMsg(null);
    setStep("SCAN");
  };

  return (
    <div 
      className="min-h-screen w-full relative pb-20"
      style={{
        backgroundImage: `url(${import.meta.env.BASE_URL}images/premium-bg.png)`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed'
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
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold uppercase tracking-wider">
                    <Layers className="w-3.5 h-3.5" />
                    {scannedData.categoryName}
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-display text-white leading-tight">
                    {scannedData.productName}
                  </h2>
                  <p className="text-white/50 text-sm flex items-center gap-2">
                    <Box className="w-4 h-4" />
                    ID Produktu: {scannedData.productId}
                  </p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-8">
                <div className="space-y-6">
                  <h3 className="text-xl font-display text-white border-b border-white/10 pb-4">
                    Parametry produktu
                  </h3>
                  
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
              
              <div className="bg-black/40 border border-white/5 rounded-xl p-4 mb-10 flex flex-col items-center justify-center">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-1">ID Oferty</span>
                <span className="font-mono text-xl text-primary">{offerId}</span>
              </div>
              
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
