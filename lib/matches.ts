import matchesData from "@/data/matches.json";

export type Match = {
  key: string;
  team1: string;
  team2: string;
  label: string;
  date: string; // ISO string
  deadlineTs: number; // unix seconds
};

export function getAllMatches(): Match[] {
  return (matchesData as typeof matchesData).map((m) => ({
    ...m,
    deadlineTs: Math.floor(new Date(m.date).getTime() / 1000),
  }));
}

export function getUpcomingMatches(): Match[] {
  const now = Math.floor(Date.now() / 1000);
  // Show matches within 3 days from now or already started but not too far in past
  return getAllMatches().filter((m) => m.deadlineTs > now - 3600 * 6); // up to 6h after start
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
