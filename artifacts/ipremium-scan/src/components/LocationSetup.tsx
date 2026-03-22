import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPin, CheckCircle2, Loader2 } from "lucide-react";
import { PremiumButton, PremiumInput, PremiumSelect } from "@/components/ui-custom";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const PROVINCES = [
  { value: "DOLNOSLASKIE", label: "Dolnośląskie" },
  { value: "KUJAWSKO_POMORSKIE", label: "Kujawsko-Pomorskie" },
  { value: "LUBELSKIE", label: "Lubelskie" },
  { value: "LUBUSKIE", label: "Lubuskie" },
  { value: "LODZKIE", label: "Łódzkie" },
  { value: "MALOPOLSKIE", label: "Małopolskie" },
  { value: "MAZOWIECKIE", label: "Mazowieckie" },
  { value: "OPOLSKIE", label: "Opolskie" },
  { value: "PODKARPACKIE", label: "Podkarpackie" },
  { value: "PODLASKIE", label: "Podlaskie" },
  { value: "POMORSKIE", label: "Pomorskie" },
  { value: "SLASKIE", label: "Śląskie" },
  { value: "SWIETOKRZYSKIE", label: "Świętokrzyskie" },
  { value: "WARMINSKO_MAZURSKIE", label: "Warmińsko-Mazurskie" },
  { value: "WIELKOPOLSKIE", label: "Wielkopolskie" },
  { value: "ZACHODNIOPOMORSKIE", label: "Zachodniopomorskie" },
];

interface SellerSettings {
  city: string;
  postCode: string;
  state: string;
}

interface LocationSetupProps {
  onConfigured: () => void;
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-white/50 uppercase tracking-wider">{label}</label>
      {children}
    </div>
  );
}

export function LocationSetup({ onConfigured }: LocationSetupProps) {
  const [checking, setChecking] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [city, setCity] = useState("");
  const [postCode, setPostCode] = useState("");
  const [state, setState] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function check() {
      try {
        const resp = await fetch(`${BASE}/api/allegro/settings`);
        const data = await resp.json() as { seller: SellerSettings | null };
        if (data.seller?.city && data.seller?.postCode && data.seller?.state) {
          onConfigured();
        } else {
          setNeedsSetup(true);
        }
      } catch {
        setNeedsSetup(true);
      } finally {
        setChecking(false);
      }
    }
    check();
  }, [onConfigured]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleaned = postCode.trim();
    if (!/^\d{2}-\d{3}$/.test(cleaned)) {
      setError("Kod pocztowy musi być w formacie XX-XXX (np. 00-001)");
      return;
    }
    if (!city.trim()) {
      setError("Wpisz nazwę miasta");
      return;
    }
    if (!state) {
      setError("Wybierz województwo");
      return;
    }

    setSaving(true);
    try {
      const resp = await fetch(`${BASE}/api/allegro/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: city.trim(), postCode: cleaned, state }),
      });
      if (!resp.ok) {
        const data = await resp.json() as { error?: string };
        setError(data.error || "Błąd zapisu ustawień");
        return;
      }
      onConfigured();
    } catch {
      setError("Błąd połączenia z serwerem");
    } finally {
      setSaving(false);
    }
  };

  if (checking) return null;

  return (
    <AnimatePresence>
      {needsSetup && (
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ duration: 0.25 }}
          className="mb-8"
        >
          <div className="rounded-2xl bg-gradient-to-br from-amber-500/10 to-orange-500/5 border border-amber-500/20 p-6">
            <div className="flex items-start gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                <MapPin className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">Konfiguracja lokalizacji sprzedawcy</h3>
                <p className="text-sm text-white/50 mt-0.5">
                  Allegro wymaga lokalizacji dla każdej oferty. Skonfiguruj raz — zostanie zapamiętana.
                </p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label="Miasto">
                  <PremiumInput
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    placeholder="np. Warszawa"
                    required
                  />
                </FormField>
                <FormField label="Kod pocztowy">
                  <PremiumInput
                    value={postCode}
                    onChange={e => {
                      const v = e.target.value.replace(/[^0-9-]/g, "");
                      if (v.length <= 6) setPostCode(v);
                    }}
                    placeholder="00-001"
                    required
                  />
                </FormField>
              </div>

              <FormField label="Województwo">
                <PremiumSelect
                  value={state}
                  onChange={e => setState(e.target.value)}
                  required
                >
                  <option value="">Wybierz województwo...</option>
                  {PROVINCES.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </PremiumSelect>
              </FormField>

              {error && (
                <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                  {error}
                </div>
              )}

              <PremiumButton
                type="submit"
                isLoading={saving}
                icon={saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                className="w-full sm:w-auto"
              >
                Zapisz lokalizację
              </PremiumButton>
            </form>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
