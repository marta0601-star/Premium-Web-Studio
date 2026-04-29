/**
 * Single shared-password login gate for the whole app.
 *
 * On mount we GET /api/auth/me. If 200, the user is already logged in
 * (cookie still valid, 30-day TTL) and we render the wrapped app.
 * If 401, we render a centred password form. POST /api/auth/login on
 * submit; on 200 the cookie is set, we re-fetch /me and unblock.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

type Status = "checking" | "authed" | "guest";

export default function AppLogin({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    try {
      const r = await fetch("/api/auth/me", { credentials: "same-origin" });
      setStatus(r.ok ? "authed" : "guest");
    } catch {
      setStatus("guest");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password }),
      });
      if (r.status === 401) {
        setError("Nieprawidłowe hasło");
        return;
      }
      if (!r.ok) {
        setError("Coś poszło nie tak — spróbuj ponownie");
        return;
      }
      setPassword("");
      await refresh();
    } catch {
      setError("Błąd sieci — spróbuj ponownie");
    } finally {
      setSubmitting(false);
    }
  }

  if (status === "checking") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          color: "#888",
          fontSize: 14,
        }}
      >
        Sprawdzanie sesji…
      </div>
    );
  }

  if (status === "authed") {
    return <>{children}</>;
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
        fontFamily: "system-ui, sans-serif",
        padding: 16,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: "100%",
          maxWidth: 320,
          padding: 24,
          background: "#fff",
          borderRadius: 8,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>
          iPremium Scan
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: "#666" }}>Zaloguj się hasłem.</p>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Hasło"
          autoFocus
          disabled={submitting}
          style={{
            padding: "8px 10px",
            fontSize: 14,
            border: "1px solid #ddd",
            borderRadius: 6,
            outline: "none",
            color: "#111",
            background: "#fff",
          }}
        />

        {error && (
          <div style={{ color: "#c00", fontSize: 12 }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={submitting || password.length === 0}
          style={{
            padding: "8px 14px",
            fontSize: 14,
            fontWeight: 500,
            border: "none",
            borderRadius: 6,
            background: submitting ? "#888" : "#111",
            color: "#fff",
            cursor: submitting ? "default" : "pointer",
          }}
        >
          {submitting ? "Logowanie…" : "Zaloguj"}
        </button>
      </form>
    </div>
  );
}
