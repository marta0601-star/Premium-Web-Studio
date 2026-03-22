import { useState, useEffect } from "react";
import { RefreshCw, ShieldCheck, ShieldX, Search, ExternalLink } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch(path: string, options?: RequestInit) {
  const r = await fetch(`${BASE}${path}`, options);
  return r.json();
}

interface TokenInfo {
  ok?: boolean;
  tokenType?: string;
  expiresIn?: number;
  tokenPrefix?: string;
  jwtScopes?: string[];
  jwtClientId?: string;
  jwtIssuer?: string;
  steps?: string[];
  error?: string;
}

interface AuthStatus {
  hasUserToken: boolean;
  tokenExpiresInMs: number | null;
  tokenScopes: string[] | null;
}

interface SearchResult {
  ean?: string;
  tokenSource?: string;
  userTokenAvailable?: boolean;
  userTokenScopes?: string[] | null;
  attempts?: Array<{
    label: string;
    url: string;
    httpStatus: number;
    success: boolean;
    productsFound?: number;
    responseData?: unknown;
    error?: string;
  }>;
  note?: string;
  foundWithMethod?: string;
}

export default function Debug() {
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [ean, setEan] = useState("5449000000996");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [lookupResult, setLookupResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [authCodeInfo, setAuthCodeInfo] = useState<{ authUrl?: string; redirectUri?: string } | null>(null);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch("/api/debug/allegro-token").then(setTokenInfo),
      apiFetch("/api/auth/status").then(setAuthStatus),
    ]).finally(() => setInitializing(false));
  }, []);

  const runSearch = async () => {
    if (!ean.trim()) return;
    setLoading(true);
    setSearchResult(null);
    setLookupResult(null);
    try {
      const [allegro, lookup] = await Promise.all([
        apiFetch(`/api/debug/allegro-search/${ean.trim()}`),
        apiFetch(`/api/lookup?ean=${ean.trim()}`),
      ]);
      setSearchResult(allegro);
      setLookupResult(lookup);
    } finally {
      setLoading(false);
    }
  };

  const getAuthUrl = async () => {
    const info = await apiFetch("/api/auth/allegro/authorize");
    setAuthCodeInfo(info);
  };

  const startDeviceFlow = async () => {
    const r = await apiFetch("/api/auth/device/start", { method: "POST" });
    alert(JSON.stringify(r, null, 2));
  };

  if (initializing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  const expiresInH = authStatus?.tokenExpiresInMs != null
    ? Math.round(authStatus.tokenExpiresInMs / 3_600_000)
    : null;

  return (
    <div className="min-h-screen bg-background text-white font-mono text-sm p-6 space-y-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-1">🔧 iPremium Scan — Debug</h1>
        <p className="text-white/40 text-xs mb-8">Panel diagnostyczny API i autoryzacji Allegro</p>

        {/* ── Auth Status ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-white/50 uppercase tracking-wider">Autoryzacja</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* Client credentials token */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-white/60 text-xs font-bold uppercase">
                Client Credentials Token
              </div>
              {tokenInfo?.ok ? (
                <div className="space-y-1 text-xs">
                  <div><span className="text-white/40">Prefix: </span><span className="text-yellow-300">{tokenInfo.tokenPrefix}</span></div>
                  <div><span className="text-white/40">Wygasa za: </span><span className="text-white">{tokenInfo.expiresIn}s</span></div>
                  <div><span className="text-white/40">Scopes: </span></div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(tokenInfo.jwtScopes || []).map(s => (
                      <span key={s} className="px-1.5 py-0.5 rounded bg-white/10 text-white/60">{s.split(":").pop()}</span>
                    ))}
                  </div>
                  <div className="mt-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
                    ⚠ Brak scope katalogu — /sale/products wymaga tokenu użytkownika
                  </div>
                </div>
              ) : (
                <div className="text-red-400 text-xs">{tokenInfo?.error || "Brak tokenu"}</div>
              )}
            </div>

            {/* User token */}
            <div className="bg-white/5 border border-white/10 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-white/60 text-xs font-bold uppercase">
                Token użytkownika (Device/Auth Code Flow)
              </div>
              {authStatus?.hasUserToken ? (
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2 text-green-400">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Autoryzowany — wygasa za {expiresInH}h
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(authStatus.tokenScopes || []).map(s => (
                      <span key={s} className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-400">{s.split(":").pop()}</span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-amber-400 text-xs">
                    <ShieldX className="w-3.5 h-3.5" />
                    Brak tokenu użytkownika
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button
                      onClick={startDeviceFlow}
                      className="px-3 py-1.5 rounded-lg bg-primary/20 border border-primary/30 text-primary hover:bg-primary/30 transition-colors text-xs"
                    >
                      Device Flow
                    </button>
                    <button
                      onClick={getAuthUrl}
                      className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-colors text-xs"
                    >
                      Auth Code URL
                    </button>
                  </div>
                  {authCodeInfo && (
                    <div className="space-y-2 p-3 rounded-lg bg-black/40 border border-white/10">
                      <div>
                        <div className="text-white/40 text-xs mb-1">Redirect URI (zarejestruj w Allegro):</div>
                        <code className="text-primary text-xs break-all">{authCodeInfo.redirectUri}</code>
                      </div>
                      <a
                        href={authCodeInfo.authUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-xs text-green-400 hover:underline"
                      >
                        Otwórz stronę autoryzacji Allegro <ExternalLink className="w-3 h-3" />
                      </a>
                      <div className="text-white/30 text-xs">
                        Twój redirect URI: <span className="text-white/60">https://7ca93ad8-0902-4ff5-8df3-eeb74459b009-00-37fuz7huq6v9c.kirk.replit.dev/auth/allegro/callback</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Search Test ─────────────────────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-sm font-bold text-white/50 uppercase tracking-wider">Test wyszukiwania EAN</h2>
          <div className="flex gap-2">
            <input
              value={ean}
              onChange={e => setEan(e.target.value)}
              placeholder="Wpisz EAN..."
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-2.5 text-white placeholder-white/30 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
            />
            <button
              onClick={runSearch}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-white font-semibold hover:bg-primary/80 disabled:opacity-50 transition-colors"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Test
            </button>
          </div>

          {searchResult && (
            <div className="space-y-4">

              {/* Summary */}
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 rounded bg-white/5 border border-white/10">
                  Token: <span className="text-yellow-300">{searchResult.tokenSource}</span>
                </span>
                <span className={`px-2 py-1 rounded border ${searchResult.userTokenAvailable ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-amber-500/10 border-amber-500/20 text-amber-400"}`}>
                  User token: {searchResult.userTokenAvailable ? "✓ TAK" : "✗ NIE"}
                </span>
                {searchResult.foundWithMethod && (
                  <span className="px-2 py-1 rounded bg-green-500/10 border border-green-500/20 text-green-400">
                    Znaleziono: {searchResult.foundWithMethod}
                  </span>
                )}
              </div>

              {searchResult.note && (
                <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
                  ⚠ {searchResult.note}
                </div>
              )}

              {/* Attempts */}
              <div className="space-y-2">
                <div className="text-xs text-white/40 font-bold">Próby wyszukiwania w katalogu Allegro:</div>
                {(searchResult.attempts || []).map((a, i) => (
                  <div key={i} className={`border rounded-xl overflow-hidden ${a.success && (a.productsFound ?? 0) > 0 ? "border-green-500/30" : "border-white/10"}`}>
                    <div className={`flex items-center justify-between px-4 py-2 ${a.success && (a.productsFound ?? 0) > 0 ? "bg-green-500/10" : "bg-white/5"}`}>
                      <span className="font-bold text-xs">{a.label}</span>
                      <div className="flex items-center gap-2 text-xs">
                        <span className={`px-2 py-0.5 rounded ${a.httpStatus === 200 ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
                          HTTP {a.httpStatus}
                        </span>
                        {(a.productsFound ?? 0) > 0 && (
                          <span className="text-green-400">✓ {a.productsFound} produktów</span>
                        )}
                      </div>
                    </div>
                    <div className="px-4 py-2 space-y-1">
                      <div className="text-white/30 text-xs break-all">URL: <span className="text-white/60">{a.url}</span></div>
                      <details className="text-xs">
                        <summary className="text-white/30 cursor-pointer hover:text-white/50">Odpowiedź JSON</summary>
                        <pre className="mt-2 text-xs text-white/60 overflow-auto max-h-48 bg-black/40 rounded p-3">
                          {JSON.stringify(a.responseData, null, 2)}
                        </pre>
                      </details>
                    </div>
                  </div>
                ))}
              </div>

              {/* External lookup result */}
              {lookupResult && (
                <div className="border border-white/10 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-white/5">
                    <span className="font-bold text-xs">Wynik zewnętrznego lookup (Open Food Facts / Google)</span>
                    <span className={`px-2 py-0.5 rounded text-xs ${(lookupResult as { found?: boolean }).found ? "bg-green-500/20 text-green-400" : "bg-white/10 text-white/40"}`}>
                      {(lookupResult as { found?: boolean }).found ? "✓ Znaleziono" : "✗ Nie znaleziono"}
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-1 text-xs">
                    {(lookupResult as Record<string, unknown>).name && (
                      <div><span className="text-white/40">Nazwa: </span><span className="text-white">{String((lookupResult as Record<string, unknown>).name)}</span></div>
                    )}
                    {(lookupResult as Record<string, unknown>).brand && (
                      <div><span className="text-white/40">Marka: </span><span className="text-white">{String((lookupResult as Record<string, unknown>).brand)}</span></div>
                    )}
                    {(lookupResult as Record<string, unknown>).source && (
                      <div><span className="text-white/40">Źródło: </span><span className="text-primary">{String((lookupResult as Record<string, unknown>).source)}</span></div>
                    )}
                    <details className="mt-2">
                      <summary className="text-white/30 cursor-pointer hover:text-white/50">Pełna odpowiedź JSON</summary>
                      <pre className="mt-2 text-xs text-white/60 overflow-auto max-h-48 bg-black/40 rounded p-3">
                        {JSON.stringify(lookupResult, null, 2)}
                      </pre>
                    </details>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Direct API links ─────────────────────────────────── */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-white/50 uppercase tracking-wider">Bezpośrednie endpointy</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {[
              ["/api/debug/allegro-token", "Token CC info"],
              [`/api/debug/allegro-search/${ean || "5449000000996"}`, "Allegro search (wszystkie warianty)"],
              [`/api/lookup?ean=${ean || "5449000000996"}`, "Zewnętrzny lookup"],
              ["/api/auth/status", "Status autoryzacji"],
              [`/api/test/${ean || "5449000000996"}`, "Test Open Food Facts"],
            ].map(([url, label]) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
              >
                <div>
                  <div className="text-white/70 font-semibold">{label}</div>
                  <div className="text-white/30 mt-0.5 break-all">{url}</div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-white/30 shrink-0 ml-2" />
              </a>
            ))}
          </div>
        </section>

        <div className="pt-4 border-t border-white/10">
          <a href="/" className="text-primary text-xs hover:underline">← Wróć do aplikacji</a>
        </div>
      </div>
    </div>
  );
}
