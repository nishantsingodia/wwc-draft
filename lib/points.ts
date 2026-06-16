import { readFileSync } from "fs";

const CSV_PATH = process.env.POINTS_CSV_PATH;
const CSV_URL = process.env.POINTS_CSV_URL;

async function fetchCsvText(): Promise<string | null> {
  // Local file first (dev)
  if (CSV_PATH) {
    try {
      return readFileSync(CSV_PATH, "utf-8");
    } catch {
      // fall through to URL
    }
  }

  // Remote URL (production — Google Sheet CSV export)
  if (CSV_URL) {
    try {
      const res = await fetch(CSV_URL, { next: { revalidate: 300 } });
      if (res.ok) return await res.text();
    } catch {
      // fall through
    }
  }

  return null;
}

function parseLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map(parseLine);
}

let _cachePromise: Promise<string[][] | null> | null = null;

async function getCsv(): Promise<string[][] | null> {
  if (!_cachePromise) {
    _cachePromise = fetchCsvText().then((text) => (text ? parseCsv(text) : null));
  }
  return _cachePromise;
}

function headerIdx(header: string[], col: string): number {
  return header.indexOf(col);
}

export async function getLastPlayedXI(): Promise<Map<string, Set<string>>> {
  const rows = await getCsv();
  if (!rows || rows.length < 2) return new Map();

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const teamIdx = headerIdx(header, "Team");
  const nameIdx = headerIdx(header, "Full Name");
  const playedIdx = headerIdx(header, "Played");

  const lastMatchPerTeam = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const team = row[teamIdx];
    const match = row[matchIdx];
    if (!team || !match) continue;
    lastMatchPerTeam.set(team, match);
  }

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

export async function getMatchPoints(matchLabel: string): Promise<Map<string, number>> {
  const rows = await getCsv();
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

export function toCsvMatchLabel(label: string): string {
  return label.replace(":", " —");
}
