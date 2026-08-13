// TEMP: shared helpers for the audit-verification harnesses.
// Rebuilds the exact merged CSV table lib/points.ts#mergeCsvs would produce, so we can
// pin it into the module cache (__setPointsCacheForTest) instead of refetching 12 gviz
// tabs every 45s.
import { readFileSync, existsSync } from "fs";

const TAB_COL = "__tab";

function parseLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) { result.push(current); current = ""; }
    else current += c;
  }
  result.push(current);
  return result;
}
export function parseCsv(text: string): string[][] {
  return text.split(/\r?\n/).filter((l) => l.trim()).map(parseLine);
}
export function mergeCsvs(tables: string[][][]): string[][] | null {
  const nonEmpty = tables.filter((t) => t.length >= 1);
  if (nonEmpty.length === 0) return null;
  const master: string[] = [
    ...nonEmpty.reduce((a, t) => (t[0].length > a.length ? t[0] : a), nonEmpty[0][0]),
  ];
  for (const t of nonEmpty) for (const c of t[0]) if (!master.includes(c)) master.push(c);
  if (!master.includes(TAB_COL)) master.push(TAB_COL);
  const tabPos = master.indexOf(TAB_COL);
  const merged: string[][] = [master];
  nonEmpty.forEach((t, ti) => {
    const idx = new Map(t[0].map((c, i) => [c, i]));
    for (const row of t.slice(1)) {
      const out = master.map((c) => {
        const i = idx.get(c);
        return i != null && i < row.length ? row[i] : "";
      });
      out[tabPos] = String(ti);
      merged.push(out);
    }
  });
  return merged;
}

const DIR = "/private/tmp/claude-501/-Users-nishant-singodia/f36700e2-70e2-4403-9da5-40a03f07ecbc/scratchpad/tabs";
// Order MUST mirror csvUrls(): env POINTS_CSV_URLS first, then data/points-tabs.json.
export const TAB_ORDER = [
  "WWC T20 POINTS", "MLC 2026 POINTS", "AUS v BAN T20 POINTS", "IND v IRE T20 POINTS",
  "IND v ENG T20 POINTS", "IRE v WI W ODI POINTS", "NZ v WI M ODI POINTS", "LPL 2026 POINTS",
  "THE HUNDRED MENS 2026 POINTS", "THE HUNDRED WOMENS 2026 POINTS", "ZIM V IND T20I POINTS",
  "CARIBBEAN PREMIER LEAGUE 2026 POINTS",
];

export function mergedRows(skipTabs: string[] = []): string[][] {
  const tables: string[][][] = [];
  for (const t of TAB_ORDER) {
    if (skipTabs.includes(t)) continue;
    const p = `${DIR}/${t}.csv`;
    if (!existsSync(p)) continue;
    tables.push(parseCsv(readFileSync(p, "utf8")));
  }
  return mergeCsvs(tables)!;
}
export function settlementRows(): string[][] {
  return parseCsv(readFileSync(`${DIR}/SETTLEMENT AUDIT.csv`, "utf8"));
}
