"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * AdminGate — password screen in front of admin-only pages. The real enforcement
 * lives server-side (the mutating /api/maps routes require the session cookie);
 * this gate just exchanges the password for that cookie and keeps unauthenticated
 * visitors out of the UI.
 */

type GateState = "checking" | "locked" | "unconfigured" | "open";

export function AdminGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/admin/session")
      .then((res) => res.json())
      .then((session: { configured: boolean; authorized: boolean }) => {
        if (cancelled) return;
        setState(session.authorized ? "open" : session.configured ? "locked" : "unconfigured");
      })
      .catch(() => {
        if (!cancelled) setState("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Sign-in failed (${res.status})`);
      setPassword("");
      setState("open");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await fetch("/api/admin/session", { method: "DELETE" }).catch(() => {});
    setState("locked");
  }

  if (state === "open") {
    return (
      <>
        {children}
        <button
          type="button"
          onClick={() => void signOut()}
          className="fixed bottom-4 left-4 z-50 rounded-full border border-white/15 bg-black/60 px-4 py-2 font-mono text-[11px] text-white/60 backdrop-blur transition hover:border-red-400/40 hover:text-red-300"
        >
          🔒 Lock admin
        </button>
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#070b12] px-5 text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(34,211,238,0.12),transparent_35%),radial-gradient(circle_at_90%_35%,rgba(249,115,22,0.08),transparent_30%)]" />
      <div className="game-panel relative w-full max-w-sm rounded-2xl p-6 sm:p-8">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.38em] text-cyan-300/70">
          Draw &amp; Drive / Admin
        </p>
        <h1 className="font-heading text-3xl font-bold uppercase italic">Restricted area</h1>

        {state === "checking" && (
          <p className="mt-5 animate-pulse font-mono text-sm text-white/45">Checking session…</p>
        )}

        {state === "unconfigured" && (
          <p className="mt-5 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">
            Admin access is not configured. Set <code className="font-mono">ADMIN_PASSWORD</code> in
            the server environment and restart.
          </p>
        )}

        {state === "locked" && (
          <form onSubmit={signIn} className="mt-5">
            <label className="block text-xs text-white/55">
              <span className="mb-1.5 block">Admin password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className="map-input"
              />
            </label>
            {error && (
              <div
                role="alert"
                className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200"
              >
                {error}
              </div>
            )}
            <button type="submit" disabled={busy} className="btn-race mt-5 w-full px-6 py-3 text-sm">
              {busy ? "Checking…" : "Enter map lab"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
