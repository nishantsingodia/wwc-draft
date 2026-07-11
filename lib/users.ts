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
