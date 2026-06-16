export const USERS: Record<string, string> = {
  NISH2026: "nishant",
  PUSH2026: "pushap",
};

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
