import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { CheckCircle2, XCircle, RefreshCw } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function AuthCallback() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("Wymieniam kod autoryzacyjny na token...");
  const [scopes, setScopes] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const error = params.get("error");
    const errorDesc = params.get("error_description");

    if (error) {
      setStatus("error");
      setMessage(`Allegro odrzuciło autoryzację: ${errorDesc || error}`);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("Brak kodu autoryzacyjnego w URL.");
      return;
    }

    // Exchange the code via the backend
    fetch(`${BASE}/api/auth/allegro/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          setStatus("success");
          setMessage(`Token zapisany! Wygasa za ${data.expiresInHours} godzin.`);
          setScopes(data.scopes || []);
          // Redirect to main app after 2.5s
          setTimeout(() => setLocation("/"), 2500);
        } else {
          setStatus("error");
          setMessage(data.error || "Nieznany błąd podczas wymiany kodu.");
        }
      })
      .catch(() => {
        setStatus("error");
        setMessage("Błąd połączenia z serwerem.");
      });
  }, [setLocation]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="bg-black/40 backdrop-blur-xl border border-white/10 rounded-3xl p-10 max-w-md w-full text-center shadow-2xl">
        {status === "loading" && (
          <>
            <RefreshCw className="w-12 h-12 text-primary animate-spin mx-auto mb-6" />
            <h2 className="text-xl font-display text-white mb-2">Autoryzacja Allegro</h2>
            <p className="text-white/50 text-sm">{message}</p>
          </>
        )}
        {status === "success" && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-500/10 mb-6">
              <CheckCircle2 className="w-8 h-8 text-green-400" />
            </div>
            <h2 className="text-xl font-display text-white mb-2">Autoryzacja zakończona!</h2>
            <p className="text-white/60 text-sm mb-4">{message}</p>
            {scopes.length > 0 && (
              <div className="flex flex-wrap gap-1 justify-center mb-4">
                {scopes.map((s) => (
                  <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 font-mono">
                    {s.split(":").pop()}
                  </span>
                ))}
              </div>
            )}
            <p className="text-white/30 text-xs">Przekierowuję do aplikacji...</p>
          </>
        )}
        {status === "error" && (
          <>
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-500/10 mb-6">
              <XCircle className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-xl font-display text-white mb-2">Błąd autoryzacji</h2>
            <p className="text-red-400 text-sm mb-6">{message}</p>
            <button
              onClick={() => setLocation("/")}
              className="px-6 py-2.5 rounded-xl bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 transition-colors text-sm"
            >
              Wróć do aplikacji
            </button>
          </>
        )}
      </div>
    </div>
  );
}
