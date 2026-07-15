import { readFileSync } from "fs";
import { fuzzyMatchName, normName } from "./fuzzy-name-match";
import { TEAM_NAMES, isPidKey, type SheetPlayer } from "./players";
// gviz CSV URLs for auto-ingested tours — the tour-sync job appends here so a new
// tour's points tab self-registers WITHOUT editing the POINTS_CSV_URLS env var.
import pointsTabs from "@/data/points-tabs.json";

const CSV_PATH = process.env.POINTS_CSV_PATH;
// Synthetic column injected by mergeCsvs to remember which tab (=tour) each row came
// from. Consumed by the tour-cumulative reads to scope to a single tour (team codes
// are reused across bilateral tours, so team-code scoping alone leaks across tours).
const TAB_COL = "__tab";
// Multiple Google-Sheet tabs (one per tour) are merged into a single pool.
// POINTS_CSV_URLS = comma-separated list; falls back to the single POINTS_CSV_URL.
// All tabs MUST share the same column schema (Match | Team | Full Name | Played | Fantasy Points | ...).
// Tabs added via the gviz endpoint MUST include &headers=1 so the header row parses cleanly.
function csvUrls(): string[] {
  const multi = process.env.POINTS_CSV_URLS;
  const fromEnv = multi
    ? multi.split(",").map((u) => u.trim()).filter(Boolean)
    : process.env.POINTS_CSV_URL
      ? [process.env.POINTS_CSV_URL]
      : [];
  // Merge the committed manifest (auto-ingested tours) with the env list, dedup so a
  // tab listed in both is fetched once (double-fetch would double-count nothing, but
  // wastes a request). Env stays the source for hand-added tours; manifest for auto ones.
  const fromManifest = (pointsTabs as string[]).map((u) => u.trim()).filter(Boolean);
  return [...new Set([...fromEnv, ...fromManifest])];
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

// Points for a player. A stable pid is AUTHORITATIVE: the points sheet is keyed by the same
// registry pid, so if a pid'd player isn't in this match's map they simply didn't feature →
// null. We must NOT fuzzy-fall-back for a pid'd player — that's how "Smit Patel" (who didn't
// play) wrongly grabbed "Sunny Patel" (same surname + first initial) in the same match.
// Fuzzy name is only for legacy / un-pid'd rows (no stable identity to key on).
export function lookupPlayerPoints(
  pid: string | undefined,
  displayName: string,
  name: string | undefined,
  pointsMap: Map<string, number>
): number | null {
  if (pid) return pointsMap.has(pid) ? (pointsMap.get(pid) ?? null) : null;
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
  // Tag every row with its source tab index. Tour-cumulative reads (getTourPoints,
  // getLastPlayedXI) MUST be able to isolate one tour: team codes are NOT globally
  // unique across tabs — India is "MIND" in BOTH the Ireland and England bilateral
  // tours — so scoping by team code alone bleeds one tour's points/XI into another.
  // The per-match reads (getMatchXI/getMatchPointsForMatch) are already opponent-aware
  // via the label, so this column is only consumed by the cumulative reads.
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

// Test-only: inject parsed CSV rows so the lookup/gate logic can be exercised offline (no
// network/file/cache). CSV_PATH is captured at module load, so swapping env wouldn't work —
// this seam sets the cache directly. Never called in production.
export function __setPointsCacheForTest(rows: string[][] | null): void {
  _cache = rows ? { at: Date.now(), rows } : null;
  _inflight = null;
}

export type MatchStatus = "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED";

// The bot's per-match "Match Status" column (+ human "Recon Flag" reason), as label -> {status,
// flag}. Returns an EMPTY map when the column is absent (legacy sheets / tabs without recon) —
// which makes every caller fall back to the legacy numeric-points completion rule (no regression).
// A match stays LIVE (results hidden) until its L1 recon discrepancies are approved.
function statusByLabel(rows: string[][]): Map<string, { status: MatchStatus; flag: string }> {
  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const si = headerIdx(header, "Match Status");
  const fi = headerIdx(header, "Recon Flag");
  const out = new Map<string, { status: MatchStatus; flag: string }>();
  if (si < 0) return out; // column absent -> legacy fallback everywhere
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    if (!lbl || out.has(lbl)) continue;
    const raw = (row[si] ?? "").trim().toUpperCase();
    if (!raw || raw === "SCHEDULED") continue; // not-yet-completed rows carry no completion signal
    const status: MatchStatus =
      raw === "LIVE" ? "LIVE" : raw === "COMPLETED_FLAGGED" ? "COMPLETED_FLAGGED" : "COMPLETED";
    out.set(lbl, { status, flag: fi >= 0 ? (row[fi] ?? "").trim() : "" });
  }
  return out;
}

// "Show results" gate: COMPLETED and COMPLETED_FLAGGED count as done (with a badge for FLAGGED);
// LIVE never does — a scored-but-unreconciled match keeps showing as live.
function showsResults(s: MatchStatus): boolean {
  return s !== "LIVE";
}

// Per team, the most-recent match's XI as a map of playerName -> batting order.
// Batting order comes from the bot's "Bat Order" column (scorecard position). If
// that column is absent (older sheets) the order is 0 and callers fall back to
// the hand-set squad_number. The map's KEYS are the XI membership; the VALUES
// are the live batting positions — so order self-corrects after each match.
export async function getLastPlayedXI(
  match?: MatchLike
): Promise<Map<string, Map<string, number>>> {
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
  const tabIdx = headerIdx(header, TAB_COL);
  // Scope to the match's own tour tab when known. Without it a team's "last match"
  // is picked across ALL tabs by row order — so India's ("MIND") last IND-v-ENG XI
  // could resolve to a later India-v-Ireland row and show the wrong tour's lineup.
  const wantTab = match ? tabOfMatch(rows, match) : null;
  const inScope = (row: string[]) =>
    wantTab == null || (tabIdx >= 0 && row[tabIdx]?.trim() === wantTab);

  const lastMatchPerTeam = new Map<string, string>();
  for (const row of rows.slice(1)) {
    if (!inScope(row)) continue;
    const team = row[teamIdx];
    const match_ = row[matchIdx];
    if (!team || !match_) continue;
    lastMatchPerTeam.set(team, match_);
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
    if (!inScope(row)) continue;
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

// The XI for ONE specific match (the contest's match), from the sheet's Played=Y rows for
// that match block, keyed by BOTH canonical name and stable pid. This is the DEFINITIVE XI
// for any match the sheet already covers — the bot resolved each player to their registry pid
// (toss-announced rows AND completed rows carry Player ID). Preferred over ESPN's announced XI,
// which is keyed by espn:<id> and so can't match a player whose registry pid is a cricsheet
// hash or slug (e.g. slug:kaushini-nuthyangana) — the bug that wrongly benched a player who
// actually featured. Empty when the sheet has no rows for this match yet (genuinely upcoming).
export async function getMatchXI(
  match: MatchLike
): Promise<Map<string, Map<string, number>>> {
  const rows = await getCsv();
  const result = new Map<string, Map<string, number>>();
  if (!rows || rows.length < 2) return result;
  const target = resolveLabel(rows, match);
  if (!target) return result;

  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const teamIdx = headerIdx(header, "Team");
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID");
  const playedIdx = headerIdx(header, "Played");
  const batIdx = headerIdx(header, "Bat Order");

  const setBat = (m: Map<string, number>, k: string, bat: number) => {
    if (!k) return;
    const cur = m.get(k);
    if (cur === undefined || (cur === 0 && bat > 0)) m.set(k, bat);
  };
  for (const row of rows.slice(1)) {
    if (row[matchIdx]?.trim() !== target) continue;
    if (row[playedIdx]?.trim() !== "Y") continue;
    const team = row[teamIdx]?.trim();
    const name = row[nameIdx]?.trim();
    const pid = pidIdx >= 0 ? row[pidIdx]?.trim() : "";
    if (!team || !name) continue;
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

// A scored label is only THIS match if its date is CLOSE. The same team pair meets again
// through the tournament — and in a bilateral series (IND v ENG, etc.) they play every ~2
// days — so without a tight date cap a not-yet-played match resolves to the PREVIOUS
// meeting's completed scorecard and shows its points / "live"/"completed" before it has even
// begun. 36h is wide enough to absorb the US-local ↔ IST date skew on the sheet's Date column
// (≤ ~a day) but narrower than the ≥48h gap between two meetings of the same pair.
const MATCH_DATE_GUARD_MS = 36 * 60 * 60 * 1000;

// Resolve our match to the single best sheet label (teams match, date closest + within guard).
function resolveLabel(rows: string[][], match: MatchLike): string | null {
  const matchTs = new Date(match.date).getTime();
  // A match whose scheduled start (its `date` = toss/lock time) is still in the future has no
  // data of its own yet and must NEVER borrow a prior meeting's block — that's how an unplayed
  // bilateral match wrongly showed the previous game's points with a "live" label. Once the
  // match has begun, the tightened guard above keeps it from grabbing the earlier meeting until
  // the bot writes this match's own rows.
  if (matchTs > Date.now()) return null;
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

// Which merged tab (= tour) a match belongs to, as the tab-index string mergeCsvs
// stamped into TAB_COL. Team codes repeat across bilateral tours (India is "MIND" in
// both the Ireland and England series), so the cumulative reads can't scope by team
// code — they scope to this tab instead. Found by the tab whose labels include this
// match's TEAM PAIR (opponent-aware, so India-v-Ireland rows are never counted for an
// India-v-England contest), nearest by date — which resolves the tour even for an
// upcoming, unplayed match via its already-played siblings in the same tab.
// Returns null when the tab column is absent (single-tab / legacy / test-injected
// rows) so callers cleanly fall back to their team-code behaviour.
function tabOfMatch(rows: string[][], match: MatchLike): string | null {
  const header = rows[0];
  const tabIdx = headerIdx(header, TAB_COL);
  if (tabIdx < 0) return null;
  const mi = headerIdx(header, "Match");
  const di = headerIdx(header, "Date");
  const matchTs = new Date(match.date).getTime();
  const seen = new Set<string>();
  let bestTab: string | null = null;
  let bestDist = Infinity;
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    const tab = row[tabIdx]?.trim();
    if (!lbl || !tab) continue;
    const key = tab + " " + lbl;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!teamsMatch(labelTeams(lbl), match.team1, match.team2)) continue;
    const dstr = di >= 0 ? row[di]?.trim() : "";
    const d = dstr ? new Date(dstr + "T00:00:00Z").getTime() : NaN;
    const dist = isNaN(d) ? Number.MAX_SAFE_INTEGER : Math.abs(d - matchTs);
    if (dist < bestDist) {
      bestDist = dist;
      bestTab = tab;
    }
  }
  return bestTab;
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

// Accumulated TOUR points per player, keyed by both stable Player ID and canonical name.
// The merged sheet holds EVERY tour's tab (Women's WC + men's bilateral + MLC) and a
// player can feature in more than one, so a player's points must be scoped to ONE tour
// or the draft/selection board shows an inflated cross-tour total.
//
// Preferred scope: the match's own tab (tour), resolved via tabOfMatch. This is the ONLY
// correct scope when the same team code is reused across two bilateral tours — India is
// "MIND" in BOTH the Ireland and the England series, so team-code scoping alone would add
// a player's Ireland points onto the England board. Within one tab a player's pid is
// unique, so summing that tab captures their full tour total (across all opponents) and
// nothing from any other tour.
//
// Fallback (no tab column, e.g. single-tab/legacy/test-injected rows, or no match passed):
// scope by the two team codes. Correct whenever a player's code differs per tour, which is
// the case for every tour EXCEPT reused-code back-to-back bilaterals.
// `Team` may be a code (women's, MLC) or a full name (men's tab) — tokenMatchesCode handles both.
export async function getTourPoints(
  team1: string,
  team2: string,
  match?: MatchLike
): Promise<Map<string, number>> {
  const rows = await getCsv();
  const result = new Map<string, number>();
  if (!rows || rows.length < 2) return result;
  const header = rows[0];
  const teamIdx = headerIdx(header, "Team"); // -1 on legacy tabs without a Team column
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID"); // -1 on older sheets
  const ptsIdx = headerIdx(header, "Fantasy Points");
  const tabIdx = headerIdx(header, TAB_COL);
  const wantTab = match ? tabOfMatch(rows, match) : null;
  const add = (k: string, v: number) => k && result.set(k, (result.get(k) ?? 0) + v);
  for (const row of rows.slice(1)) {
    // Tour scope: prefer the match's own tab; else fall back to team-code scoping.
    if (wantTab != null) {
      if (row[tabIdx]?.trim() !== wantTab) continue;
    } else if (teamIdx >= 0) {
      const team = row[teamIdx]?.trim() ?? "";
      if (!(tokenMatchesCode(team, team1) || tokenMatchesCode(team, team2))) continue;
    }
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
  // pid is authoritative (sheet is pid-keyed) — no name fallback for a pid'd player, so two
  // same-surname players (e.g. Sunny/Smit Patel) can never borrow each other's tour total.
  if (pid) return tourPoints.has(pid) ? (tourPoints.get(pid) ?? null) : null;
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
  const statusMap = statusByLabel(rows);

  // labels that actually have a scored row
  const scored = new Set<string>();
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    if (lbl && !isNaN(parseFloat(row[pi]))) scored.add(lbl);
  }

  for (const m of matches) {
    const matchTs = new Date(m.date).getTime();
    // Same future-start gate as resolveLabel: a match that hasn't begun can't be "completed",
    // even though a ≤guard-away prior meeting of the same pair is already scored.
    if (matchTs > Date.now()) continue;
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
    if (best && !(bestDated && bestDist > MATCH_DATE_GUARD_MS)) {
      // LIVE-until-L1-recon gate: a scored match whose feeds still disagree stays LIVE
      // (excluded here) until approved. No status row -> legacy (scored => completed).
      const st = statusMap.get(best);
      if (!st || showsResults(st.status)) done.add(m.key);
    }
  }
  return done;
}

// Single-match convenience for the match overview page. Honors the same LIVE-until-L1 gate.
export async function isMatchCompleted(match: MatchLike): Promise<boolean> {
  const rows = await getCsv();
  if (!rows || rows.length < 2) return false;
  const target = resolveLabel(rows, match);
  if (!target) return false;
  const st = statusByLabel(rows).get(target);
  if (st) return showsResults(st.status); // LIVE => not completed even though it's scored
  return (await getMatchPointsForMatch(match)).size > 0; // legacy: scored => completed
}

// The bot's per-match status + human flag for one match — drives the results/match-page badges
// ("⏳ provisional — awaiting recon", "⚠ official revision pending", "⚠ unverified — single
// feed"). null when the sheet carries no "Match Status" column (legacy).
export async function getMatchStatusFor(
  match: MatchLike
): Promise<{ status: MatchStatus; flag: string } | null> {
  const rows = await getCsv();
  if (!rows || rows.length < 2) return null;
  const target = resolveLabel(rows, match);
  if (!target) return null;
  return statusByLabel(rows).get(target) ?? null;
}

// Per-player recon marker for a match (pid/name -> "⏳ unreconciled" / "⚠ official revision"),
// so the results screen can flag exactly WHICH players' numbers aren't settled. Clean players
// are omitted; an empty map means nothing to flag (or a legacy sheet without the column).
export async function getMatchPlayerRecon(match: MatchLike): Promise<Map<string, string>> {
  const rows = await getCsv();
  const out = new Map<string, string>();
  if (!rows || rows.length < 2) return out;
  const target = resolveLabel(rows, match);
  if (!target) return out;
  const header = rows[0];
  const matchIdx = headerIdx(header, "Match");
  const nameIdx = headerIdx(header, "Full Name");
  const pidIdx = headerIdx(header, "Player ID");
  const reconIdx = headerIdx(header, "Player Recon");
  if (reconIdx < 0) return out; // column absent (legacy) -> nothing to flag
  for (const row of rows.slice(1)) {
    if (row[matchIdx]?.trim() !== target) continue;
    const marker = (row[reconIdx] ?? "").trim();
    if (!marker) continue;
    const name = row[nameIdx]?.trim();
    const pid = pidIdx >= 0 ? row[pidIdx]?.trim() : "";
    if (pid) out.set(pid, marker);
    if (name) out.set(name, marker);
  }
  return out;
}

// pid-first, then exact name (mirrors lookupPlayerPoints). null when the player is clean/absent.
export function lookupPlayerRecon(
  pid: string | undefined,
  displayName: string,
  name: string | undefined,
  reconMap: Map<string, string>
): string | null {
  if (reconMap.size === 0) return null;
  if (pid) return reconMap.get(pid) ?? null;
  return reconMap.get(displayName) ?? (name ? reconMap.get(name) ?? null : null) ?? null;
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
