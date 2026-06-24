"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        router.push("/lobby");
      } else {
        setError("Invalid code. Try again.");
      }
    } catch {
      setError("Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="relative min-h-screen flex items-center justify-center bg-ink floodlight px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="text-5xl drop-shadow-[0_0_20px_rgba(212,175,55,0.35)]">🏏</div>
          <h1 className="text-3xl font-bold uppercase tracking-tight text-cloud">WWC Draft</h1>
          <p className="text-mist text-xs font-mono tracking-[0.18em] uppercase">
            Women&apos;s T20 WC 2026
          </p>
        </div>

        <form onSubmit={handleSubmit} className="card-stadium rounded-2xl p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-[11px] text-mist font-mono uppercase tracking-[0.18em]">
              Enter your player code
            </label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="••••••"
              className="bg-ink2 border-hair2 text-cloud text-center text-xl tracking-[0.4em] font-mono h-12 placeholder:text-mist2 focus-visible:ring-gold/60 focus-visible:border-gold/60"
              autoComplete="off"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-live text-sm text-center">{error}</p>
          )}

          <Button
            type="submit"
            className="w-full h-12 bg-gold hover:brightness-110 text-ink font-bold uppercase tracking-wide glow-gold transition disabled:opacity-40 disabled:shadow-none"
            disabled={loading || !code.trim()}
          >
            {loading ? "Checking…" : "Enter →"}
          </Button>
        </form>
      </div>
    </main>
  );
}
