// The draft roster — the SINGLE source of truth for who can play.
// USERS (login), ALL_USERS, USER_LABELS (display) and USER_COLORS (identity dot)
// all derive from this one list. To add a friend for N-player drafts, add ONE row:
// a unique login `code`, a stable `username`, a display `label`, and a DISTINCT
// `color` (Tailwind bg-* class). The `code` is what a player types on the home
// screen; `username` is the internal id stored in draft rows — NEVER change it
// once that person has joined a draft.
export type RosterMember = {
  code: string;
  username: string;
  label: string;
  color: string;
};

export const ROSTER: RosterMember[] = [
  { code: "NISH2026", username: "nishant", label: "Nishant", color: "bg-blue-500" },
  { code: "PUSH2026", username: "pushap", label: "Pushap", color: "bg-emerald-500" },
  // Friends added 2026-07-11 for 6-player drafts. `username` + `color` are stable
  // ids now — don't change them once someone's joined a draft (draft rows reference
  // the username). Colours stay distinct from the two above and each other.
  { code: "PRAD2026", username: "pradeep", label: "Pradeep", color: "bg-amber-500" },
  { code: "ARIF2026", username: "arif", label: "Arif", color: "bg-purple-500" },
  { code: "SHAR2026", username: "sharan", label: "Sharan", color: "bg-cyan-500" },
  { code: "MIHI2026", username: "mihir", label: "Mihir", color: "bg-pink-500" },
];

// The hard ceiling on drafters per contest — bounded by the roster size.
export const MAX_ROSTER = ROSTER.length;

export const USERS: Record<string, string> = Object.fromEntries(
  ROSTER.map((m) => [m.code, m.username])
);

// Every known username. In manual mode one person can enter several friends' teams,
// so surfaces sometimes need the roster rather than a contest's joined participants.
export const ALL_USERS: string[] = ROSTER.map((m) => m.username);

export function isKnownUser(u: string): boolean {
  return ALL_USERS.includes(u);
}

/**
 * Who a contest's team-entry surfaces should offer a slot for.
 *
 * MANUAL mode: one person enters every friend's team, so the list is the ROSTER up to
 * `maxPlayers` — never the seated participants. Entering someone's team now seats them
 * (see app/api/draft/[code]/team/route.ts), so keying off participants would SHRINK the
 * list as teams get filled in: seat 2 of 6 and friends 3–6 become unreachable. Anyone
 * already seated is unioned in first, so a participant can never be dropped even if the
 * roster order or `maxPlayers` changes under a live contest.
 *
 * LIVE mode: everyone joins, so participants are authoritative — with the pre-join
 * roster fallback kept for a contest whose seats aren't all taken yet.
 */
export function draftersFor(
  mode: "live" | "manual",
  participants: string[],
  maxPlayers: number | null | undefined
): string[] {
  const seats = maxPlayers ?? 2;
  if (mode === "manual") {
    const union = [...new Set([...participants, ...ALL_USERS])];
    return union.slice(0, Math.max(seats, participants.length));
  }
  return participants.length >= 2 ? participants : ALL_USERS.slice(0, seats);
}

export const USER_COLORS: Record<string, string> = Object.fromEntries(
  ROSTER.map((m) => [m.username, m.color])
);

export const USER_LABELS: Record<string, string> = Object.fromEntries(
  ROSTER.map((m) => [m.username, m.label])
);

export function getUserLabel(username: string): string {
  return USER_LABELS[username] ?? username;
}

export function getUserColor(username: string): string {
  return USER_COLORS[username] ?? "bg-gray-500";
}

// Real hex colour per member, matching each roster `color` Tailwind class. Used where an
// inline style / gradient needs an actual colour value (a Tailwind bg-* class can't feed a
// CSS `background`). Keyed by username and kept explicit so an unusual/renamed Tailwind
// class can never silently break the lookup.
export const USER_HEX: Record<string, string> = {
  nishant: "#3b82f6", // bg-blue-500
  pushap: "#10b981",  // bg-emerald-500
  pradeep: "#f59e0b", // bg-amber-500
  arif: "#a855f7",    // bg-purple-500
  sharan: "#06b6d4",  // bg-cyan-500
  mihir: "#ec4899",   // bg-pink-500
};

export function getUserHex(username: string): string {
  return USER_HEX[username] ?? "#6b7280";
}
