import matchesData from "@/data/matches.json";
import { LOCK_BUFFER } from "@/lib/lock-buffer";

// Re-export so existing `import { LOCK_BUFFER } from "@/lib/matches"` callers keep
// working; the constant itself now lives in lib/lock-buffer.ts (client-safe).
export { LOCK_BUFFER };

export type Match = {
  key: string;
  matchNum: number;
  gender: "W" | "M";
  team1: string;
  team2: string;
  label: string;
  date: string;
  deadlineTs: number;
};

export function getAllMatches(): Match[] {
  // Sorted chronologically so lists (lobby, schedule) interleave all tours by
  // date — file order groups by tour, which buries later-added tours (MLC) at
  // the end and hides them behind the lobby's top-5 cap.
  return (matchesData as typeof matchesData)
    .map((m) => ({
      ...m,
      gender: m.gender as "W" | "M",
      deadlineTs: Math.floor(new Date(m.date).getTime() / 1000),
    }))
    .sort((a, b) => a.deadlineTs - b.deadlineTs);
}

export function getUpcomingMatches(): Match[] {
  const now = Math.floor(Date.now() / 1000);
  return getAllMatches().filter((m) => m.deadlineTs + LOCK_BUFFER > now);
}

export function getMatchByKey(key: string): Match | undefined {
  return getAllMatches().find((m) => m.key === key);
}

export function formatMatchDate(isoDate: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(isoDate));
}
