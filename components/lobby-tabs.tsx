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
      <div className="flex gap-1 bg-navy border border-hair rounded-xl p-1">
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
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-bold transition-colors ${
                active ? "bg-gold text-ink shadow-[0_6px_16px_-8px_rgba(212,175,55,0.7)]" : "text-mist hover:text-cloud"
              }`}
            >
              {showDot && (
                <span className="w-1.5 h-1.5 rounded-full bg-live animate-pulse" />
              )}
              <span>{t.label}</span>
              {t.count > 0 && (
                <span
                  className={`text-[10px] font-mono tabular-nums px-1 rounded ${
                    active ? "bg-ink/30 text-ink" : "text-mist2"
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
      <p className="text-mist2 text-sm">{msg}</p>
    </div>
  );
}
