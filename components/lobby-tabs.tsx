"use client";

import { useState, type ReactNode } from "react";

type TabKey = "upcoming" | "live" | "completed";

export default function LobbyTabs({
  upcoming,
  live,
  completed,
  upcomingCount,
  liveCount,
  completedCount,
  defaultTab,
}: {
  upcoming: ReactNode;
  live: ReactNode;
  completed: ReactNode;
  upcomingCount: number;
  liveCount: number;
  completedCount: number;
  defaultTab: TabKey;
}) {
  const [tab, setTab] = useState<TabKey>(defaultTab);

  const tabs: { key: TabKey; label: string; count: number; live?: boolean }[] = [
    { key: "upcoming", label: "Upcoming", count: upcomingCount },
    { key: "live", label: "Live", count: liveCount, live: true },
    { key: "completed", label: "Completed", count: completedCount },
  ];

  return (
    <div className="space-y-5">
      {/* Tab bar (segmented control) */}
      <div className="flex gap-1 bg-zinc-900 rounded-xl p-1">
        {tabs.map((t) => {
          const active = tab === t.key;
          const showDot = t.live && t.count > 0;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-selected={active}
              role="tab"
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-colors ${
                active ? "bg-zinc-700 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {showDot && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              )}
              <span>{t.label}</span>
              {t.count > 0 && (
                <span
                  className={`text-[10px] tabular-nums px-1 rounded ${
                    active ? "bg-zinc-900/60 text-zinc-200" : "text-zinc-500"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Panels */}
      <div role="tabpanel">
        {tab === "upcoming" &&
          (upcomingCount > 0 ? upcoming : <EmptyPanel msg="No upcoming matches." />)}
        {tab === "live" &&
          (liveCount > 0 ? live : <EmptyPanel msg="No live drafts right now." />)}
        {tab === "completed" &&
          (completedCount > 0 ? completed : <EmptyPanel msg="No completed drafts yet." />)}
      </div>
    </div>
  );
}

function EmptyPanel({ msg }: { msg: string }) {
  return (
    <div className="text-center py-12">
      <p className="text-zinc-500 text-sm">{msg}</p>
    </div>
  );
}
