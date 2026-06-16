import matchesData from "@/data/matches.json";

export type Match = {
  key: string;
  matchNum: number;
  team1: string;
  team2: string;
  label: string;
  date: string;
  deadlineTs: number;
};

export function getAllMatches(): Match[] {
  return (matchesData as typeof matchesData).map((m) => ({
    ...m,
    deadlineTs: Math.floor(new Date(m.date).getTime() / 1000),
  }));
}

export function getUpcomingMatches(): Match[] {
  const now = Math.floor(Date.now() / 1000);
  return getAllMatches().filter((m) => m.deadlineTs > now);
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
