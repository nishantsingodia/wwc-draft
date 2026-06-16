import { readFileSync } from "fs";

const CSV_PATH =
  process.env.POINTS_CSV_PATH ??
  "/Users/nishant-singodia/wwc-points-bot/out.csv";

function readCsv(): string[][] | null {
  try {
    const raw = readFileSync(CSV_PATH, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines.map((l) => l.split(","));
  } catch {
    return null;
  }
}

let _cache: string[][] | null | undefined = undefined;
function getCsv(): string[][] | null {
  if (_cache === undefined) _cache = readCsv();
  return _cache;
}

function headerIdx(header: string[], col: string): number {
  return header.indexOf(col);
}

/**
 * Returns a map of teamCode → Set<playerDisplayName> for the last played XI.
 * Teams with no CSV data return an empty Set (caller should fall back to squadNumber).
 */
export function getLastPlayedXI(): Map<string, Set<string>> {
  const rows = getCsv();
  if (!rows || rows.length < 2) return new Map();

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const teamIdx = headerIdx(header, "Team");
  const nameIdx = headerIdx(header, "Full Name");
  const playedIdx = headerIdx(header, "Played");

  // Find last match number per team
  const lastMatchPerTeam = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const team = row[teamIdx];
    const match = row[matchIdx];
    if (!team || !match) continue;
    lastMatchPerTeam.set(team, match);
  }

  // Collect XI for each team's last match
  const result = new Map<string, Set<string>>();
  for (const row of rows.slice(1)) {
    const team = row[teamIdx];
    const match = row[matchIdx];
    const name = row[nameIdx];
    const played = row[playedIdx];
    if (!team || !match || !name) continue;
    if (match !== lastMatchPerTeam.get(team)) continue;
    if (played?.trim() !== "Y") continue;
    if (!result.has(team)) result.set(team, new Set());
    result.get(team)!.add(name.trim());
  }

  return result;
}

/**
 * Returns Map<playerDisplayName, fantasyPoints> for a given match label.
 * Match label format: "Match N — TEAM1 v TEAM2"
 */
export function getMatchPoints(matchLabel: string): Map<string, number> {
  const rows = getCsv();
  if (!rows || rows.length < 2) return new Map();

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const nameIdx = headerIdx(header, "Full Name");
  const ptsIdx = headerIdx(header, "Fantasy Points");

  const result = new Map<string, number>();
  for (const row of rows.slice(1)) {
    if (row[matchIdx]?.trim() !== matchLabel) continue;
    const name = row[nameIdx]?.trim();
    const pts = parseFloat(row[ptsIdx]);
    if (name && !isNaN(pts)) result.set(name, pts);
  }
  return result;
}

/**
 * Convert matches.json label ("Match N: TEAM1 v TEAM2") to out.csv format ("Match N — TEAM1 v TEAM2").
 */
export function toCsvMatchLabel(label: string): string {
  return label.replace(":", " —");
}
