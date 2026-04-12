import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Shield, ShieldCheck, ShieldX, ExternalLink, RefreshCw, Copy, Check, ChevronDown, ChevronUp, Unlink } from "lucide-react";
import { PremiumButton } from "@/components/ui-custom";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AuthStatus {
  hasUserToken: boolean;
  needsReAuth: boolean;
  tokenExpiresInMs: number | null;
  tokenScopes: string[] | null;
  hasPendingDeviceFlow: boolean;
  pendingUserCode: string | null;
  pendingVerificationUri: string | null;
  pendingExpiresAt: number | null;
}

interface DeviceFlowResponse {
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  pollIntervalSeconds?: number;
  error?: string;
  details?: { error?: string; error_description?: string };
}

async function apiFetch(path: string, options?: RequestInit) {
  const resp = await fetch(`${BASE}${path}`, options);
  return resp.json();
}

export function AllegroAuthBanner() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowResponse | null>(null);
  const [polling, setPolling] = useState(false);
  const [pollStatus, setPollStatus] = useState<string>("");
  const [authCodeInfo, setAuthCodeInfo] = useState<{ authUrl?: string; redirectUri?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiFetch("/api/auth/status");
      setStatus(s);
      if (s.hasUserToken) {
        setPolling(false);
        setDeviceFlow(null);
      }
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 30_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Auto-expand and show re-auth prompt when the refresh token has expired
  useEffect(() => {
    if (status?.needsReAuth) {
      setExpanded(true);
    }
  }, [status?.needsReAuth]);

  // Poll device flow when active
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(async () => {
      try {
        const result = await apiFetch("/api/auth/device/poll", { method: "POST" });
        if (result.status === "authorized") {
          setPolling(false);
          setDeviceFlow(null);
          setPollStatus("authorized");
          await fetchStatus();
        } else if (result.status === "expired" || result.status === "error") {
          setPolling(false);
          setPollStatus(result.error || result.status);
        } else {
          setPollStatus("pending");
        }
      } catch {
        // silent
      }
    }, (deviceFlow?.pollIntervalSeconds || 5) * 1000);
    return () => clearInterval(id);
  }, [polling, deviceFlow, fetchStatus]);

  const startDeviceFlow = async () => {
    setLoading(true);
    setError(null);
    setAuthCodeInfo(null);
    try {
      const resp: DeviceFlowResponse = await apiFetch("/api/auth/device/start", { method: "POST" });
      if (resp.error) {
        if (resp.details?.error === "unauthorized_client") {
          setError(
            "Device Flow nie jest włączony dla tej aplikacji. " +
            "Włącz go w Allegro Developer Portal (allegro.pl/developer) dla swojej aplikacji, " +
            "lub skorzystaj z metody \"Kod autoryzacji\" poniżej."
          );
        } else {
          setError(resp.details?.error_description || resp.error || "Nieznany błąd");
        }
      } else {
        setDeviceFlow(resp);
        setPolling(true);
        setPollStatus("pending");
      }
    } catch {
      setError("Błąd połączenia z serwerem");
    } finally {
      setLoading(false);
    }
  };

  const getAuthCodeUrl = async () => {
    setLoading(true);
    setError(null);
    setDeviceFlow(null);
    setPolling(false);
    try {
      const resp = await apiFetch("/api/auth/allegro/authorize");
      setAuthCodeInfo({ authUrl: resp.authUrl, redirectUri: resp.redirectUri });
    } catch {
      setError("Błąd połączenia z serwerem");
    } finally {
      setLoading(false);
    }
  };

  const disconnect = async () => {
    await apiFetch("/api/auth/user-token", { method: "DELETE" });
    await fetchStatus();
    setExpanded(false);
  };

  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!status) return null;

  const expiresHours = status.tokenExpiresInMs != null
    ? Math.round(status.tokenExpiresInMs / 3_600_000)
    : null;

  return (
    <div className="mb-8">
      {/* Status bar */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-black/40 border border-white/10 hover:border-white/20 transition-colors group"
      >
        <div className="flex items-center gap-3">
          {status.hasUserToken ? (
            <ShieldCheck className="w-4 h-4 text-green-400 shrink-0" />
          ) : status.needsReAuth ? (
            <ShieldX className="w-4 h-4 text-red-400 shrink-0" />
          ) : (
            <ShieldX className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <span className="text-sm font-medium text-white/70">
            {status.hasUserToken
              ? `Allegro: autoryzowany (wygasa za ${expiresHours}h)`
              : status.needsReAuth
              ? "Allegro: token wygasł — wymagana ponowna autoryzacja"
              : "Allegro: wymagana autoryzacja konta"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!status.hasUserToken && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
              status.needsReAuth
                ? "text-red-400 bg-red-400/10 border-red-400/20"
                : "text-amber-400 bg-amber-400/10 border-amber-400/20"
            }`}>
              {status.needsReAuth ? "Odśwież autoryzację" : "Połącz konto"}
            </span>
          )}
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-white/40 group-hover:text-white/60 transition-colors" />
          ) : (
            <ChevronDown className="w-4 h-4 text-white/40 group-hover:text-white/60 transition-colors" />
          )}
        </div>
      </button>

      {/* Expanded panel */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 p-6 rounded-xl bg-black/40 border border-white/10 space-y-6">

              {status.hasUserToken ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
                    <ShieldCheck className="w-5 h-5 text-green-400 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-green-400">Konto Allegro połączone</p>
                      <p className="text-xs text-white/50 mt-0.5">Token wygasa za {expiresHours} godzin. Odświeżany automatycznie (przy 80% czasu życia).</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(status.tokenScopes || []).map(s => (
                      <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/40 font-mono">{s.split(":").pop()}</span>
                    ))}
                  </div>
                  <button
                    onClick={disconnect}
                    className="flex items-center gap-2 text-xs text-white/40 hover:text-red-400 transition-colors"
                  >
                    <Unlink className="w-3 h-3" />
                    Rozłącz konto Allegro
                  </button>
                </div>
              ) : (
                <div className="space-y-6">
                  {status.needsReAuth ? (
                    <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                      <div className="flex items-start gap-3">
                        <ShieldX className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-semibold text-red-400">Token odświeżania wygasł</p>
                          <p className="text-xs text-white/50 mt-1">
                            Token dostępu nie mógł zostać odświeżony — token odświeżania wygasł lub został unieważniony.
                            Wymagana jest ponowna autoryzacja konta Allegro.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-start gap-3">
                        <Shield className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-semibold text-amber-400">Autoryzacja wymagana do katalogu Allegro</p>
                          <p className="text-xs text-white/50 mt-1">
                            Wyszukiwanie produktów w katalogu Allegro wymaga połączenia z Twoim kontem sprzedawcy.
                            Do czasu autoryzacji dane produktu są pobierane z zewnętrznych źródeł (Open Food Facts, Google itp.).
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {error && (
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
                      {error}
                    </div>
                  )}

                  {/* Device Flow */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
                      Metoda 1: Device Flow (zalecana)
                    </h4>
                    <p className="text-xs text-white/50">
                      Wymaga włączenia Device Flow w{" "}
                      <a href="https://developer.allegro.pl/console/applications" target="_blank" rel="noreferrer" className="text-primary underline">
                        Allegro Developer Portal
                      </a>{" "}
                      → Twoja aplikacja → OAuth → zaznacz Device Code.
                    </p>

                    {!deviceFlow ? (
                      <PremiumButton
                        onClick={startDeviceFlow}
                        isLoading={loading}
                        className="w-full sm:w-auto"
                      >
                        Uruchom Device Flow
                      </PremiumButton>
                    ) : (
                      <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-4">
                        <div className="text-center">
                          <p className="text-xs text-white/50 mb-2">Kod urządzenia (przepisz na allegro.pl)</p>
                          <div className="flex items-center justify-center gap-3">
                            <span className="text-3xl font-mono font-bold tracking-[0.3em] text-primary">
                              {deviceFlow.userCode}
                            </span>
                            <button
                              onClick={() => copyCode(deviceFlow.userCode!)}
                              className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                              title="Kopiuj kod"
                            >
                              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4 text-white/40" />}
                            </button>
                          </div>
                        </div>
                        <a
                          href={deviceFlow.verificationUriComplete || deviceFlow.verificationUri}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-primary/20 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/30 transition-colors"
                        >
                          Otwórz Allegro i zatwierdź
                          <ExternalLink className="w-4 h-4" />
                        </a>
                        <div className="flex items-center gap-2 justify-center">
                          <RefreshCw className={`w-3.5 h-3.5 text-white/40 ${polling ? "animate-spin" : ""}`} />
                          <span className="text-xs text-white/40">
                            {pollStatus === "authorized"
                              ? "Autoryzowano!"
                              : pollStatus === "pending"
                              ? "Oczekiwanie na zatwierdzenie..."
                              : pollStatus || "Sprawdzam..."}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Auth Code Flow */}
                  <div className="space-y-3 pt-4 border-t border-white/10">
                    <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
                      Metoda 2: Kod autoryzacji (wymaga redirect URI)
                    </h4>
                    <p className="text-xs text-white/50">
                      Zarejestruj adres callback w Allegro Developer Portal, a następnie kliknij poniżej.
                    </p>

                    {!authCodeInfo ? (
                      <PremiumButton
                        variant="secondary"
                        onClick={getAuthCodeUrl}
                        isLoading={loading}
                        className="w-full sm:w-auto"
                      >
                        Pobierz URL autoryzacji
                      </PremiumButton>
                    ) : (
                      <div className="space-y-3">
                        <div className="p-3 rounded-lg bg-black/40 border border-white/10">
                          <p className="text-xs text-white/40 mb-1">Redirect URI do zarejestrowania w Allegro:</p>
                          <div className="flex items-center gap-2">
                            <code className="text-xs text-primary break-all flex-1">{authCodeInfo.redirectUri}</code>
                            <button onClick={() => copyCode(authCodeInfo.redirectUri!)} className="shrink-0 p-1.5 rounded bg-white/5 hover:bg-white/10">
                              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3 text-white/40" />}
                            </button>
                          </div>
                        </div>
                        <a
                          href={authCodeInfo.authUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center justify-center gap-2 w-full py-3 rounded-lg bg-white/5 border border-white/10 text-white/70 text-sm font-semibold hover:bg-white/10 transition-colors"
                        >
                          Otwórz stronę autoryzacji Allegro
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
