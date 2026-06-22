import { readFileSync } from "fs";
import { fuzzyMatchName, normName } from "./fuzzy-name-match";
import { TEAM_NAMES, isPidKey, type SheetPlayer } from "./players";

const CSV_PATH = process.env.POINTS_CSV_PATH;
// Multiple Google-Sheet tabs (one per tour) are merged into a single pool.
// POINTS_CSV_URLS = comma-separated list; falls back to the single POINTS_CSV_URL.
// All tabs MUST share the same column schema (Match | Team | Full Name | Played | Fantasy Points | ...).
// Tabs added via the gviz endpoint MUST include &headers=1 so the header row parses cleanly.
function csvUrls(): string[] {
  const multi = process.env.POINTS_CSV_URLS;
  if (multi) return multi.split(",").map((u) => u.trim()).filter(Boolean);
  const single = process.env.POINTS_CSV_URL;
  return single ? [single] : [];
}

export function fuzzyLookupPoints(
  playerName: string,
  pointsMap: Map<string, number>
): number | null {
  // Exclude pid keys (cricsheet hashes / "espn:" / "slug:") from fuzzy NAME matching —
  // they're identity keys, not names, and must only be hit by an exact pid lookup.
  const match = fuzzyMatchName(playerName, [...pointsMap.keys()].filter((k) => !isPidKey(k)));
  return match !== null ? (pointsMap.get(match) ?? null) : null;
}

// Points for a player: stable pid first (exact identity), then fuzzy name fallback.
export function lookupPlayerPoints(
  pid: string | undefined,
  displayName: string,
  name: string | undefined,
  pointsMap: Map<string, number>
): number | null {
  if (pid && pointsMap.has(pid)) return pointsMap.get(pid) ?? null;
  return (
    fuzzyLookupPoints(displayName, pointsMap) ??
    (name && name !== displayName ? fuzzyLookupPoints(name, pointsMap) : null)
  );
}

async function fetchOne(url: string): Promise<string | null> {
  try {
    // no-store so we always read the current sheet; freshness is bounded by the
    // in-process TTL in getCsv (not by Next's fetch cache, which would mask updates).
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) return await res.text();
  } catch {
    // ignore — one failing tab shouldn't kill the others
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
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map(parseLine);
}

// Short-TTL cache: dedupes the multi-tab fetch within a burst of requests, but
// expires quickly so sheet updates (live points, post-toss announced XI) show up
// within ~CACHE_TTL_MS instead of being pinned for the whole server-instance life.
const CACHE_TTL_MS = 45_000;
let _cache: { at: number; rows: string[][] } | null = null;
let _inflight: Promise<string[][] | null> | null = null;

// Merge multiple parsed CSVs (one per tour tab) into a single table, realigning each tab
// to a canonical header BY COLUMN NAME. Tabs usually share a schema, but if one lags (e.g.
// the bot added "Player ID" to some tabs first), blindly reusing the first header would read
// every later tab's rows shifted (wrong Full Name / Fantasy Points). Mapping by name is robust.
function mergeCsvs(tables: string[][][]): string[][] | null {
  const nonEmpty = tables.filter((t) => t.length >= 1);
  if (nonEmpty.length === 0) return null;
  // Master columns = union of every tab's header (base order = the widest header).
  const master: string[] = [
    ...nonEmpty.reduce((a, t) => (t[0].length > a.length ? t[0] : a), nonEmpty[0][0]),
  ];
  for (const t of nonEmpty) for (const c of t[0]) if (!master.includes(c)) master.push(c);
  const merged: string[][] = [master];
  for (const t of nonEmpty) {
    const idx = new Map(t[0].map((c, i) => [c, i]));
    for (const row of t.slice(1)) {
      merged.push(master.map((c) => {
        const i = idx.get(c);
        return i != null && i < row.length ? row[i] : "";
      }));
    }
  }
  return merged;
}

async function loadAll(): Promise<string[][] | null> {
  // Local file (dev) takes precedence as a single source if present.
  if (CSV_PATH) {
    try {
      return parseCsv(readFileSync(CSV_PATH, "utf-8"));
    } catch {
      // fall through to URLs
    }
  }

  const urls = csvUrls();
  if (urls.length === 0) return null;

  const texts = await Promise.all(urls.map(fetchOne));
  const tables = texts.filter((t): t is string => !!t).map(parseCsv);
  if (tables.length === 0) return null; // every tab failed — treat as no data
  return mergeCsvs(tables);
}

async function getCsv(): Promise<string[][] | null> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.rows;
  if (_inflight) return _inflight; // coalesce concurrent refreshes
  _inflight = loadAll().then((rows) => {
    if (rows) _cache = { at: Date.now(), rows }; // cache successes only
    _inflight = null;
    return rows;
  });
  return _inflight;
}

function headerIdx(header: string[], col: string): number {
  return header.indexOf(col);
}

// Per team, the most-recent match's XI as a map of playerName -> batting order.
// Batting order comes from the bot's "Bat Order" column (scorecard position). If
// that column is absent (older sheets) the order is 0 and callers fall back to
// the hand-set squad_number. The map's KEYS are the XI membership; the VALUES
// are the live batting positions — so order self-corrects after each match.
export async function getLastPlayedXI(): Promise<Map<string, Map<string, number>>> {
  const rows = await getCsv();
  const result = new Map<string, Map<string, number>>();
  if (!rows || rows.length < 2) return result;

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const teamIdx = headerIdx(header, "Team");
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID"); // -1 on older sheets
  const playedIdx = headerIdx(header, "Played");
  const batIdx = headerIdx(header, "Bat Order"); // -1 on older sheets

  const lastMatchPerTeam = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const team = row[teamIdx];
    const match = row[matchIdx];
    if (!team || !match) continue;
    lastMatchPerTeam.set(team, match);
  }

  // Membership = rows with Played=Y for the team's last match. Keyed by BOTH the
  // canonical name AND the stable Player ID, so a player whose stats the feed split
  // across two spellings collapses to one XI entry (no "last row wins" bat-order bug),
  // and consumers can match by pid. Keep the first real (>0) bat order seen.
  const setBat = (m: Map<string, number>, k: string, bat: number) => {
    if (!k) return;
    const cur = m.get(k);
    if (cur === undefined || (cur === 0 && bat > 0)) m.set(k, bat);
  };
  for (const row of rows.slice(1)) {
    const team = row[teamIdx]?.trim();
    const match = row[matchIdx]?.trim();
    const name = row[nameIdx]?.trim();
    const pid = pidIdx >= 0 ? row[pidIdx]?.trim() : "";
    const played = row[playedIdx]?.trim();
    if (!team || !match || !name) continue;
    if (match !== lastMatchPerTeam.get(team)) continue;
    if (played !== "Y") continue;
    const batOrder = batIdx >= 0 ? parseInt(row[batIdx], 10) || 0 : 0;
    if (!result.has(team)) result.set(team, new Map());
    const m = result.get(team)!;
    setBat(m, name, batOrder);
    if (pid) setBat(m, pid, batOrder);
  }

  return result;
}

// ── Match identification (teams + date, NOT the "Match N" label) ──────────────
//
// The points bot numbers matches by its own (cricapi/espn) scheme, which does
// NOT match our hand-entered matches.json numbering — and our research dates can
// be a day off and same-day games can be ordered differently. So NEVER match on
// the "Match N — A v B" string. Instead match on the TEAM PAIR (order- and
// format-independent) and disambiguate the double round-robin (a pair meets
// twice, weeks apart) by picking the sheet match with the closest date.

type MatchLike = { team1: string; team2: string; date: string };

// "Match 3 — LAKR v SFU" → ["LAKR","SFU"]; "MLC Final" / knockouts → [] (no " v ")
function labelTeams(label: string): string[] {
  const sep = " — ";
  const i = label.indexOf(sep);
  const part = i === -1 ? "" : label.slice(i + sep.length);
  const vi = part.indexOf(" v ");
  if (vi === -1) return [];
  return [part.slice(0, vi).trim(), part.slice(vi + 3).trim()];
}

// A sheet label token matches our team code if it equals the code (women's, MLC)
// or the full team name (men's tab uses "Bangladesh"/"Australia" for MAUS/MBAN).
function tokenMatchesCode(token: string, code: string): boolean {
  const t = normName(token);
  if (!t) return false;
  if (t === normName(code)) return true;
  const full = TEAM_NAMES[code];
  return !!full && t === normName(full);
}

function teamsMatch(toks: string[], c1: string, c2: string): boolean {
  if (toks.length !== 2) return false;
  const [a, b] = toks;
  return (
    (tokenMatchesCode(a, c1) && tokenMatchesCode(b, c2)) ||
    (tokenMatchesCode(a, c2) && tokenMatchesCode(b, c1))
  );
}

// Build label → representative date (from the Date column) for all sheet rows.
function labelDateMap(rows: string[][]): Map<string, string> {
  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const di = headerIdx(header, "Date");
  const out = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    if (!lbl) continue;
    if (!out.has(lbl)) out.set(lbl, di >= 0 ? (row[di]?.trim() ?? "") : "");
  }
  return out;
}

// A scored label is only THIS match if its date is within a few days. The same team pair
// meets again later in the tournament (double round-robin / knockouts), so without a date cap
// a not-yet-played rematch would resolve to an earlier meeting's points and show "completed".
const MATCH_DATE_GUARD_MS = 3 * 24 * 60 * 60 * 1000;

// Resolve our match to the single best sheet label (teams match, date closest + within guard).
function resolveLabel(rows: string[][], match: MatchLike): string | null {
  const matchTs = new Date(match.date).getTime();
  let best: string | null = null;
  let bestDist = Infinity;
  let bestDated = false;
  for (const [lbl, dstr] of labelDateMap(rows)) {
    if (!teamsMatch(labelTeams(lbl), match.team1, match.team2)) continue;
    const d = dstr ? new Date(dstr + "T00:00:00Z").getTime() : NaN;
    const dated = !isNaN(d);
    // Prefer dated candidates; an undated label only wins if nothing dated matches (legacy).
    const dist = dated ? Math.abs(d - matchTs) : Number.MAX_SAFE_INTEGER;
    if (dist < bestDist) {
      bestDist = dist;
      best = lbl;
      bestDated = dated;
    }
  }
  // Reject when the closest scored meeting of this pair is far in time (a future rematch).
  if (best && bestDated && bestDist > MATCH_DATE_GUARD_MS) return null;
  return best;
}

// Points for a match, identified by teams+date (immune to the bot's numbering).
export async function getMatchPointsForMatch(
  match: MatchLike
): Promise<Map<string, number>> {
  const rows = await getCsv();
  if (!rows || rows.length < 2) return new Map();
  const target = resolveLabel(rows, match);
  if (!target) return new Map();

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID"); // -1 on older sheets
  const ptsIdx = headerIdx(header, "Fantasy Points");

  // Keyed by BOTH the stable Player ID and the canonical name. Callers look up by the
  // player's pid first (exact identity), then fall back to fuzzy name for un-pid'd rows.
  const result = new Map<string, number>();
  for (const row of rows.slice(1)) {
    if (row[matchIdx]?.trim() !== target) continue;
    const name = row[nameIdx]?.trim();
    const pid = pidIdx >= 0 ? row[pidIdx]?.trim() : "";
    const pts = parseFloat(row[ptsIdx]);
    if (isNaN(pts)) continue;
    if (name) result.set(name, pts);
    if (pid) result.set(pid, pts);
  }
  return result;
}

// Accumulated TOUR points per player: sum of Fantasy Points across every completed match
// in the sheet, keyed by both stable Player ID and canonical name. A player appears only in
// their own tour's rows, so their sum is their tour total. Used on the draft board to show
// real form ("X pts") instead of the pre-tournament projection while picking.
export async function getTourPoints(): Promise<Map<string, number>> {
  const rows = await getCsv();
  const result = new Map<string, number>();
  if (!rows || rows.length < 2) return result;
  const header = rows[0];
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID"); // -1 on older sheets
  const ptsIdx = headerIdx(header, "Fantasy Points");
  const add = (k: string, v: number) => k && result.set(k, (result.get(k) ?? 0) + v);
  for (const row of rows.slice(1)) {
    const pts = parseFloat(row[ptsIdx]);
    if (isNaN(pts)) continue;
    const pid = pidIdx >= 0 ? row[pidIdx]?.trim() : "";
    const name = row[nameIdx]?.trim();
    if (pid) add(pid, pts);
    if (name) add(normName(name), pts);
  }
  return result;
}

// Tour points for one player: stable pid first, then canonical name.
export function lookupTourPoints(
  pid: string | undefined,
  displayName: string,
  name: string | undefined,
  tourPoints: Map<string, number>
): number | null {
  if (pid && tourPoints.has(pid)) return tourPoints.get(pid) ?? null;
  return (
    tourPoints.get(normName(displayName)) ??
    (name ? tourPoints.get(normName(name)) ?? null : null)
  );
}

// Which of the given matches are scored (have ≥1 row with a numeric points value).
export async function getCompletedMatchKeys(
  matches: (MatchLike & { key: string })[]
): Promise<Set<string>> {
  const rows = await getCsv();
  const done = new Set<string>();
  if (!rows || rows.length < 2) return done;

  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const pi = headerIdx(header, "Fantasy Points");
  const dates = labelDateMap(rows);

  // labels that actually have a scored row
  const scored = new Set<string>();
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    if (lbl && !isNaN(parseFloat(row[pi]))) scored.add(lbl);
  }

  for (const m of matches) {
    const matchTs = new Date(m.date).getTime();
    let best: string | null = null;
    let bestDist = Infinity;
    let bestDated = false;
    for (const lbl of scored) {
      if (!teamsMatch(labelTeams(lbl), m.team1, m.team2)) continue;
      const dstr = dates.get(lbl) ?? "";
      const d = dstr ? new Date(dstr + "T00:00:00Z").getTime() : NaN;
      const dated = !isNaN(d);
      const dist = dated ? Math.abs(d - matchTs) : Number.MAX_SAFE_INTEGER;
      if (dist < bestDist) {
        bestDist = dist;
        best = lbl;
        bestDated = dated;
      }
    }
    // Same date guard as resolveLabel: a future rematch must not count an earlier meeting.
    if (best && !(bestDated && bestDist > MATCH_DATE_GUARD_MS)) done.add(m.key);
  }
  return done;
}

// Single-match convenience for the match overview page.
export async function isMatchCompleted(match: MatchLike): Promise<boolean> {
  return (await getMatchPointsForMatch(match)).size > 0;
}

// Per team, is the XI we're showing the OFFICIAL announced XI (lineups out after
// toss) vs a prediction from the last match? Plus the toss result if present.
// Detected from the Source column of the team's latest rows: the live-lineup tick
// writes Source "ESPN announced XI (toss) · <toss text>".
export async function getLineupMeta(): Promise<Map<string, { announced: boolean; toss: string | null }>> {
  const rows = await getCsv();
  const out = new Map<string, { announced: boolean; toss: string | null }>();
  if (!rows || rows.length < 2) return out;
  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const teamIdx = headerIdx(header, "Team");
  const srcIdx = headerIdx(header, "Source");
  if (srcIdx < 0) return out;

  const lastMatch = new Map<string, string>();
  for (const row of rows.slice(1)) {
    const t = row[teamIdx]?.trim();
    const m = row[matchIdx]?.trim();
    if (t && m) lastMatch.set(t, m);
  }
  for (const row of rows.slice(1)) {
    const t = row[teamIdx]?.trim();
    const m = row[matchIdx]?.trim();
    if (!t || m !== lastMatch.get(t)) continue;
    const src = (row[srcIdx] || "").trim();
    const announced = src.startsWith("ESPN announced XI (toss)");
    let toss: string | null = null;
    if (announced) {
      const dot = src.indexOf("·");
      if (dot >= 0) toss = src.slice(dot + 1).trim() || null;
    }
    out.set(t, { announced, toss });
  }
  return out;
}

// Every distinct player the live feed has seen per team (teamCode -> name -> role),
// across all that team's matches. This is the SELF-HEALING roster source: the draft
// pool merges these in so anyone who actually features is draftable, even if they
// were never in the hand-maintained players-raw.json seed. Skips junk rows and the
// "?" team (tours the bot couldn't team-label — see BUGS.md men's-tab note).
export async function getSheetRoster(): Promise<Map<string, Map<string, SheetPlayer>>> {
  const rows = await getCsv();
  const out = new Map<string, Map<string, SheetPlayer>>();
  if (!rows || rows.length < 2) return out;
  const header = rows[0];
  const teamIdx = headerIdx(header, "Team");
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID");
  const roleIdx = headerIdx(header, "Role");

  for (const row of rows.slice(1)) {
    const team = row[teamIdx]?.trim();
    const name = row[nameIdx]?.trim();
    const pid = pidIdx >= 0 ? (row[pidIdx]?.trim() ?? "") : "";
    if (!team || team === "?" || !name) continue;
    if (name.toLowerCase() === "player not found") continue;
    // Skip cricsheet-initials leftovers ("AC Jayangani", "H Madavi", "RMVD Gunaratne")
    // — these are dupes of a squad member the bot couldn't name-match, not new players.
    // Real announced names start with a proper first name, not an all-caps initial block.
    if (/^[A-Z]{1,5}$/.test(name.split(/\s+/)[0])) continue;
    let role = (roleIdx >= 0 ? row[roleIdx]?.trim() : "") || "BAT";
    if (!["WK", "BAT", "AR", "BOWL"].includes(role)) role = "BAT";
    if (!out.has(team)) out.set(team, new Map());
    const m = out.get(team)!;
    if (!m.has(name)) m.set(name, { role, pid });
  }
  return out;
}
