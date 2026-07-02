export const USERS: Record<string, string> = {
  NISH2026: "nishant",
  PUSH2026: "pushap",
};

// The full two-person roster this app is built for. In manual mode one person can
// enter BOTH friends' teams, so we need the roster (not just a contest's participants,
// which for a manual draft is often only the creator).
export const ALL_USERS: string[] = Object.values(USERS);

export function isKnownUser(u: string): boolean {
  return ALL_USERS.includes(u);
}

export const USER_COLORS: Record<string, string> = {
  nishant: "bg-blue-500",
  pushap: "bg-emerald-500",
};

export const USER_LABELS: Record<string, string> = {
  nishant: "Nishant",
  pushap: "Pushap",
};

export function getUserLabel(username: string): string {
  return USER_LABELS[username] ?? username;
}

export function getUserColor(username: string): string {
  return USER_COLORS[username] ?? "bg-gray-500";
}
