"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DeleteDraftButton({ code }: { code: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    const res = await fetch(`/api/draft/${code}`, { method: "DELETE" });
    if (res.ok) {
      router.refresh();
    } else {
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs px-2 py-1 rounded-lg bg-red-700 hover:bg-red-600 text-white font-medium disabled:opacity-50"
        >
          {deleting ? "…" : "Delete"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="text-xs px-2 py-1 rounded-lg bg-zinc-700 text-zinc-300"
        >
          No
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={(e) => { e.preventDefault(); setConfirming(true); }}
      className="text-zinc-600 hover:text-red-400 text-sm shrink-0 transition-colors"
      title="Delete draft"
    >
      🗑
    </button>
  );
}
