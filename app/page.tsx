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
    <main className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <div className="text-5xl">🏏</div>
          <h1 className="text-2xl font-bold text-white">WWC Draft</h1>
          <p className="text-zinc-400 text-sm">Women&apos;s T20 WC 2026</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm text-zinc-400 uppercase tracking-wider">
              Enter your player code
            </label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Enter code"
className="bg-zinc-900 border-zinc-700 text-white text-center text-lg tracking-widest font-mono h-12"
              autoComplete="off"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <Button
            type="submit"
            className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
            disabled={loading || !code.trim()}
          >
            {loading ? "Checking…" : "Enter"}
          </Button>
        </form>
      </div>
    </main>
  );
}
