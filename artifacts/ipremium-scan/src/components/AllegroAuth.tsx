import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Shield,
  ShieldCheck,
  ShieldX,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Unlink,
} from "lucide-react";
import { PremiumButton } from "@/components/ui-custom";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface AuthStatus {
  hasUserToken: boolean;
  needsReAuth: boolean;
  tokenExpiresInMs: number | null;
  tokenScopes: string[] | null;
}

async function apiFetch(path: string, options?: RequestInit) {
  const resp = await fetch(`${BASE}${path}`, options);
  return resp.json();
}

export function AllegroAuthBanner() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiFetch("/api/auth/status");
      setStatus(s);
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

  // After the OAuth round-trip the backend redirects back to "/" with
  // ?allegro_auth=success|error — strip the param from the URL and refresh
  // the status so the banner flips to "autoryzowany" without a reload.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("allegro_auth");
    if (!result) return;
    params.delete("allegro_auth");
    params.delete("reason");
    const search = params.toString();
    const cleanUrl =
      window.location.pathname + (search ? `?${search}` : "") + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
    if (result === "success") {
      fetchStatus();
    } else {
      setExpanded(true);
    }
  }, [fetchStatus]);

  const startAuthorize = () => {
    // Top-level navigation to the backend, which generates a state token,
    // stores it in the cookie-session and 302-redirects to allegro.pl.
    window.location.href = `${BASE}/auth/allegro/login`;
  };

  const disconnect = async () => {
    await apiFetch("/api/auth/user-token", { method: "DELETE" });
    await fetchStatus();
    setExpanded(false);
  };

  if (!status) return null;

  const expiresHours =
    status.tokenExpiresInMs != null
      ? Math.round(status.tokenExpiresInMs / 3_600_000)
      : null;

  return (
    <div className="mb-8">
      {/* Status bar */}
      <button
        onClick={() => setExpanded((v) => !v)}
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
            <span
              className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                status.needsReAuth
                  ? "text-red-400 bg-red-400/10 border-red-400/20"
                  : "text-amber-400 bg-amber-400/10 border-amber-400/20"
              }`}
            >
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
                      <p className="text-sm font-semibold text-green-400">
                        Konto Allegro połączone
                      </p>
                      <p className="text-xs text-white/50 mt-0.5">
                        Token wygasa za {expiresHours} godzin. Odświeżany automatycznie (przy 80% czasu życia).
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(status.tokenScopes || []).map((s) => (
                      <span
                        key={s}
                        className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/40 font-mono"
                      >
                        {s.split(":").pop()}
                      </span>
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
                          <p className="text-sm font-semibold text-red-400">
                            Token odświeżania wygasł
                          </p>
                          <p className="text-xs text-white/50 mt-1">
                            Token dostępu nie mógł zostać odświeżony — token odświeżania wygasł lub został unieważniony. Wymagana jest ponowna autoryzacja konta Allegro.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <div className="flex items-start gap-3">
                        <Shield className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-semibold text-amber-400">
                            Autoryzacja wymagana do katalogu Allegro
                          </p>
                          <p className="text-xs text-white/50 mt-1">
                            Wyszukiwanie produktów w katalogu Allegro wymaga połączenia z Twoim kontem sprzedawcy. Do czasu autoryzacji dane produktu są pobierane z zewnętrznych źródeł (Open Food Facts, Google itp.).
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Authorization Code Flow (single supported method) */}
                  <div className="space-y-3">
                    <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider">
                      Autoryzacja konta Allegro
                    </h4>
                    <p className="text-xs text-white/50">
                      Kliknij poniżej — zostaniesz przekierowany do Allegro, aby zatwierdzić uprawnienia. Po akceptacji wrócisz do iPremium Scan z aktywnym tokenem.
                    </p>

                    <PremiumButton
                      onClick={startAuthorize}
                      className="w-full sm:w-auto"
                    >
                      <span className="inline-flex items-center gap-2">
                        Połącz konto Allegro
                        <ExternalLink className="w-4 h-4" />
                      </span>
                    </PremiumButton>

                    <p className="text-[11px] text-white/30 leading-relaxed">
                      Device Flow nie jest aktywny dla tej aplikacji w Allegro Developer Portal — używamy grant <code className="font-mono">authorization_code</code>.
                    </p>
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
