import { readFileSync } from "fs";
import { fuzzyMatchName, normName } from "./fuzzy-name-match";
import { TEAM_NAMES, TEAM_CODE_ALIASES, isPidKey, type SheetPlayer } from "./players";
import { isLivePointsMap } from "./live-map";
// gviz CSV URLs for auto-ingested tours — the tour-sync job appends here so a new
// tour's points tab self-registers WITHOUT editing the POINTS_CSV_URLS env var.
import pointsTabs from "@/data/points-tabs.json";
// Cricinfo-id migration shim: the sheet's "Player ID" column may still carry pre-migration pids
// (cricsheet hash / "slug:" / "espn:") until the bot re-emits every row as "ci:<cricinfoId>".
// pid-map.json maps each old pid -> its new ci: pid, so the join holds through the transition.
// A value already ci: isn't a key here -> returned unchanged. Permanent + harmless once the sheet
// is fully ci:. (Mirrors the registry's identity-redirect discipline.)
import pidMapJson from "@/lib/pid-map.json";
const PID_REDIRECT = pidMapJson as Record<string, string>;
function resolvePid(raw: string | undefined): string {
  const p = (raw ?? "").trim();
  return PID_REDIRECT[p] ?? p;
}

// ── ONE row per (match, player) — the single reduction ───────────────────────────────────────
// The bot writes one row per (match, SQUAD SLOT), so a player can hold TWO rows for one match:
// auto-add appended a slot that already existed and ONE performance got emitted twice. Measured
// on the live sheet 14 Aug 2026 — 18 such keys, 3 players, two shapes:
//   • 16 keys = a scored `Played=Y` row + a bare `Played=N` slot row with NO stat columns at all
//     (Vishva Kumara ci:784375 ×8 LPL, Ash Gardner ci:858809 ×8 Hundred W — her 181 sits beside
//     an empty partner row).
//   • 1 key  = two genuinely scored rows: Jane Maguire ci:1229018, "Match 1 — OIRE v OWI",
//     byte-identical stats (0 off 3, 6-0-62-0) scored twice — Role=BOWL → 2 and Role=AR → −1,
//     the AR row taking the ODI duck penalty (Pts Bat −3) that the BOWL role is exempt from.
//   • 1 key  = two identical scored rows (46/46, WWC "Match 27 — WI v IRE").
//
// FIVE app paths reduced that pair five different ways — last-wins (contest totals), SUM (draft
// board), max-wins (audit), first-wins (bat order), plus the summed `Points Delta` — so the
// results page printed −1 while the Audit tab beside it printed 2 for the same player, and her
// 46-point WWC match read 92 on the board.
//
// ONE rule now, everywhere, via pickDupRow: the row with the HIGHEST `Fantasy Points` wins, and a
// row with NO points ranks below every row that has any.
//   – SUM is never right: two rows are ONE performance, not two.
//   – first/last-wins are ROW-ORDER dependent — the bot rewrites the sheet in place every run, so
//     a re-run that merely reorders rows would move a settled number with no data change. Money
//     must not depend on CSV row order.
//   – MAX is the one order-independent pick that also settles the blank-slot shape with the same
//     comparison, because an ABSENCE IS NOT A VALUE: rank a pointless row −Infinity and it can
//     never beat a real score (ranking it 0 would have zeroed 16 live scores; ranking it −1, as
//     settlement-audit did, silently beat any genuinely negative row).
// A duplicate is never silently absorbed: pickDupRow logs each one once per process and
// auditMatch carries them into /audit + the results Audit tab.
const _dupWarned = new Set<string>();
function dupRank(pts: number | null): number {
  return pts === null ? -Infinity : pts;
}

/**
 * THE reduction. Given every sheet row claiming one (match, player) key, return the single row
 * that represents it. Highest Fantasy Points wins; a row with no points loses to any row that has
 * some; `tie` (default 0) breaks an exact points tie deterministically instead of falling back to
 * row order. `warn` is off for name keys — two rows sharing a NAME in one match can be two real
 * namesakes, whereas two rows sharing a PID is always a bot-side duplicate slot.
 */
export function pickDupRow<R>(
  key: string,
  group: R[],
  ptsOf: (r: R) => number | null,
  tieOf: (r: R) => number = () => 0,
  warn = true
): R {
  let best = group[0];
  for (const r of group.slice(1)) {
    const [a, b] = [dupRank(ptsOf(r)), dupRank(ptsOf(best))];
    if (a > b || (a === b && tieOf(r) > tieOf(best))) best = r;
  }
  if (group.length > 1 && warn && !_dupWarned.has(key)) {
    _dupWarned.add(key);
    console.warn(
      `[points] DUPLICATE (match,player) ${key}: ${group.length} rows ` +
      `[${group.map((r) => ptsOf(r) ?? "—").join(" / ")}] -> keeping ${ptsOf(best) ?? "—"}. ` +
      `One performance emitted under two squad slots — fix it in the bot, not here.`
    );
  }
  return best;
}

/** Bucket rows by every identity key they claim (a row is usually in both a pid and a name group). */
function groupRows<R>(rows: R[], keysOf: (r: R) => string[]): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const r of rows) {
    for (const k of keysOf(r)) {
      const cur = out.get(k);
      if (cur) cur.push(r);
      else out.set(k, [r]);
    }
  }
  return out;
}

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
  pointsMap: Map<string, number>,
  // LIVE-map only: when a pid'd player misses the pid key, allow the shared fuzzy name matcher as
  // a fallback. The bot's reconciled SHEET must NOT do this (a namesake could steal points), but
  // the ESPN live map is keyed by name too and only PROVISIONAL — if ESPN romanizes a name so its
  // pid didn't resolve, this recovers the join (fuzzyMatchName is null-on-ambiguity; trues up on
  // completion).
  //
  // ⚠ OMITTED NOW MEANS "ASK THE MAP", NOT "false" (16 Aug 2026). The old `= false` default was
  // an ABSENCE PRESENTING AS A VALUE by another door: a caller that simply didn't know about the
  // flag got the strict behaviour applied to a LIVE map, and a live pid miss reads as "he scored
  // 0" rather than "I couldn't join him". calcSelectionPoints — lobby cards, match-hub H2H,
  // /audit, every amendment preview — was exactly that caller, and it cost 20.6 FP/match of live
  // points across 170 replayed ESPN summaries (lib/live-map.ts carries the full measurement).
  // Pass `false` explicitly to force strict on a map that IS live; that stays available and is
  // what the settled-sheet call sites do for clarity.
  liveFallback?: boolean
): number | null {
  const useFallback = liveFallback ?? isLivePointsMap(pointsMap);
  if (pid && pointsMap.has(pid)) return pointsMap.get(pid) ?? null;
  if (pid && !useFallback) return null;
  return (
    fuzzyLookupPoints(displayName, pointsMap) ??
    (name && name !== displayName ? fuzzyLookupPoints(name, pointsMap) : null)
  );
}

// A points tab MUST carry these. gviz answers an UNKNOWN sheet name with HTTP 200 and the
// spreadsheet's FIRST SHEET (verified: ?sheet=ZZZ_BOGUS returns bytes identical to a real but
// non-existent tab). Without this check a renamed, deleted or never-created tab is
// indistinguishable from a healthy one, and its rows get merged into the points pool — the CPL
// tab was silently feeding 33 rows of a WWC auction-budget board into scoring.
const REQUIRED_POINTS_COLUMNS = ["Match", "Player ID", "Full Name", "Fantasy Points"];

function looksLikePointsTab(text: string): boolean {
  const header = (text.split(/\r?\n/, 1)[0] ?? "");
  return REQUIRED_POINTS_COLUMNS.every((c) => header.includes(`"${c}"`) || header.includes(c));
}

async function fetchOne(url: string): Promise<string | null> {
  try {
    // no-store so we always read the current sheet; freshness is bounded by the
    // in-process TTL in getCsv (not by Next's fetch cache, which would mask updates).
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    if (!looksLikePointsTab(text)) {
      // LOUD: a 200 that isn't a points tab means the sheet is missing/renamed and gviz handed
      // back some other board. Silently merging it is how wrong numbers reach a settlement.
      const sheet = decodeURIComponent(new URL(url).searchParams.get("sheet") ?? "?");
      console.error(
        `[points] tab ${JSON.stringify(sheet)} returned 200 but is NOT a points tab ` +
        `(header lacks ${REQUIRED_POINTS_COLUMNS.join("/")}). gviz falls back to the first sheet ` +
        `for an unknown tab name — dropping it instead of merging it into the pool.`
      );
      return null;
    }
    return text;
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

// A row's Fantasy Points, or null when the cell is blank / non-numeric. null is an ABSENCE and is
// kept distinct from 0 all the way through: the bot's empty squad-slot rows carry no stat columns
// at all, and reading one as a zero is how a real score gets erased.
function rowPoints(row: string[], ptsIdx: number): number | null {
  const v = parseFloat(ptsIdx >= 0 ? row[ptsIdx] : "");
  return isNaN(v) ? null : v;
}

// Test-only: inject parsed CSV rows so the lookup/gate logic can be exercised offline (no
// network/file/cache). CSV_PATH is captured at module load, so swapping env wouldn't work —
// this seam sets the cache directly. Never called in production.
export function __setPointsCacheForTest(rows: string[][] | null): void {
  _cache = rows ? { at: Date.now(), rows } : null;
  _inflight = null;
}

export type MatchStatus = "LIVE" | "COMPLETED" | "COMPLETED_FLAGGED";

// The bot's SECOND axis, independent of MatchStatus. A match is COMPLETED the moment L1 recon is
// done and stays COMPLETED forever; L2 moves underneath it days later when cricsheet posts. One
// column can't carry two lifecycles — that's what made COMPLETED_FLAGGED mean "unverified single
// feed" OR "official revision pending" OR "identity unresolved" with no way to tell which.
export type ReconState = "L1_OPEN" | "L1_DONE" | "L2_PENDING" | "L2_DONE";

// The sheet writes a human label ("🔵 L2 recon pending"); parse back to the enum. Unknown/absent
// -> null, so a tour whose tab predates these columns renders exactly as it does today.
function parseReconState(raw: string): ReconState | null {
  const s = (raw || "").toUpperCase();
  if (!s) return null;
  if (s.includes("L1") && s.includes("OPEN")) return "L1_OPEN";
  if (s.includes("L1") && s.includes("DONE")) return "L1_DONE";
  if (s.includes("L2") && s.includes("PENDING")) return "L2_PENDING";
  if (s.includes("L2") && s.includes("DONE")) return "L2_DONE";
  return null;
}

export const RECON_STATE_UI: Record<ReconState, { label: string; tone: "amber" | "green" | "blue" }> = {
  L1_OPEN: { label: "L1 recon open", tone: "amber" },
  L1_DONE: { label: "L1 recon done", tone: "green" },
  L2_PENDING: { label: "L2 recon pending", tone: "blue" },
  L2_DONE: { label: "L2 recon done", tone: "green" },
};

// The bot's per-match "Match Status" column (+ human "Recon Flag" reason), as label -> {status,
// flag}. Returns an EMPTY map when the column is absent (legacy sheets / tabs without recon) —
// which makes every caller fall back to the legacy numeric-points completion rule (no regression).
// A match stays LIVE (results hidden) until its L1 recon discrepancies are approved.
function statusByLabel(
  rows: string[][]
): Map<string, { status: MatchStatus; flag: string; recon: ReconState | null; delta: number }> {
  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const si = headerIdx(header, "Match Status");
  const fi = headerIdx(header, "Recon Flag");
  // Both optional and read BY NAME: a tab written before these columns existed simply has no
  // recon axis and no delta, and every caller degrades to today's behaviour.
  const ri = headerIdx(header, "Recon State");
  const di = headerIdx(header, "Points Delta");
  const out = new Map<
    string,
    { status: MatchStatus; flag: string; recon: ReconState | null; delta: number }
  >();
  if (si < 0) return out; // column absent -> legacy fallback everywhere
  // Per-match net delta = the SUM of its players' signed movements, not one player's. A contest
  // is settled on the team total, so that is the number worth surfacing.
  //
  // ONE row per (match, player) here too, or the badge is a fiction: each empty duplicate slot row
  // carries the negation of its twin's score in this column (Ash Gardner's blank partner rows read
  // "Points Delta −181, −141, −62 …" while she never moved), so summing raw rows reported a
  // −181-pt revision on a match nothing had happened to. Reduced with the same pickDupRow, keyed
  // by ONE identity per row (pid, else name) — the delta is per ROW, so unlike the points maps it
  // must not be counted once under a pid key and again under a name key.
  const netByLabel = new Map<string, number>();
  const deltaOf = (row: string[]) => {
    const d = parseInt((row[di] ?? "").trim(), 10);
    return Number.isFinite(d) ? d : 0;
  };
  if (di >= 0) {
    const pi = headerIdx(header, "Player ID");
    const ni = headerIdx(header, "Full Name");
    const fp = headerIdx(header, "Fantasy Points");
    const pts = (row: string[]) => rowPoints(row, fp);
    const byKey = groupRows(
      rows.slice(1).filter((row) => row[mi]?.trim()).map((row, i) => ({ row, i })),
      ({ row, i }) => {
        const id = resolvePid(pi >= 0 ? row[pi]?.trim() : "") || (ni >= 0 ? row[ni]?.trim() : "") || `#${i}`;
        return [row[mi].trim() + "\u0000" + id];
      }
    );
    for (const [lk, group] of byKey) {
      const lbl = lk.slice(0, lk.indexOf("\u0000"));
      const row = pickDupRow(`delta ${lk.replace("\u0000", " ")}`, group.map((g) => g.row), pts, undefined, false);
      netByLabel.set(lbl, (netByLabel.get(lbl) ?? 0) + deltaOf(row));
    }
  }
  for (const row of rows.slice(1)) {
    const lbl = row[mi]?.trim();
    if (!lbl || out.has(lbl)) continue;
    const raw = (row[si] ?? "").trim().toUpperCase();
    if (!raw || raw === "SCHEDULED") continue; // not-yet-completed rows carry no completion signal
    const status: MatchStatus =
      raw === "LIVE" ? "LIVE" : raw === "COMPLETED_FLAGGED" ? "COMPLETED_FLAGGED" : "COMPLETED";
    out.set(lbl, {
      status,
      flag: fi >= 0 ? (row[fi] ?? "").trim() : "",
      recon: ri >= 0 ? parseReconState(row[ri] ?? "") : null,
      delta: netByLabel.get(lbl) ?? 0,
    });
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

  // Membership = rows with Played=Y for the team's last match.
  return xiFromRows(
    "last XI",
    rows.slice(1).filter((row) => {
      if (!inScope(row)) return false;
      const team = row[teamIdx]?.trim();
      const match_ = row[matchIdx]?.trim();
      if (!team || !match_ || match_ !== lastMatchPerTeam.get(team)) return false;
      return row[playedIdx]?.trim() === "Y";
    }),
    { team: teamIdx, name: nameIdx, pid: pidIdx, bat: batIdx, pts: headerIdx(header, "Fantasy Points") }
  );
}

/**
 * XI membership + batting order from already-filtered rows (ONE match, Played=Y), keyed per team by
 * BOTH canonical name AND stable Player ID — so a player whose stats a feed split across two
 * spellings collapses to one XI entry, and consumers can match by pid.
 *
 * A player holding two rows for the match is reduced by the SAME pickDupRow as their points, so the
 * bat order shown can't come from a different row than the score shown. (It used to be "first row
 * wins, a 0 upgradeable by a real position" — order-dependent, and a fourth reduction of the same
 * key.) The 0-upgrade survives as the tie-break: on equal points a real position beats a DNB 0.
 */
function xiFromRows(
  where: string,
  rows: string[][],
  idx: { team: number; name: number; pid: number; bat: number; pts: number }
): Map<string, Map<string, number>> {
  const batOf = (row: string[]) => (idx.bat >= 0 ? parseInt(row[idx.bat], 10) || 0 : 0);
  const pts = (row: string[]) => rowPoints(row, idx.pts);
  const byKey = groupRows(rows, (row) => {
    const team = row[idx.team]?.trim();
    const name = idx.name >= 0 ? row[idx.name]?.trim() : "";
    const pid = resolvePid(idx.pid >= 0 ? row[idx.pid]?.trim() : "");
    if (!team || !name) return [];
    return [name, pid].filter(Boolean).map((k) => team + "\u0000" + k);
  });
  const out = new Map<string, Map<string, number>>();
  for (const [tk, group] of byKey) {
    const cut = tk.indexOf("\u0000");
    const [team, key] = [tk.slice(0, cut), tk.slice(cut + 1)];
    // Warn key deliberately omits the team, so for getMatchXI it is the SAME string the points
    // path uses ("<label> <pid>") and one duplicate logs one line, not one per surface.
    const row = pickDupRow(
      `${where} ${key}`, group, pts, (r) => (batOf(r) > 0 ? 1 : 0), isPidKey(key)
    );
    if (!out.has(team)) out.set(team, new Map());
    out.get(team)!.set(key, batOf(row));
  }
  return out;
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

  return xiFromRows(
    target,
    rows.slice(1).filter(
      (row) => row[matchIdx]?.trim() === target && row[playedIdx]?.trim() === "Y"
    ),
    { team: teamIdx, name: nameIdx, pid: pidIdx, bat: batIdx, pts: headerIdx(header, "Fantasy Points") }
  );
}

// ── Match identification (teams + date, NOT the "Match N" label) ──────────────
//
// The points bot numbers matches by its own (cricapi/espn) scheme, which does
// NOT match our hand-entered matches.json numbering — and our research dates can
// be a day off and same-day games can be ordered differently. So NEVER match on
// the "Match N — A v B" string. Instead match on the TEAM PAIR (order- and
// format-independent) and disambiguate the double round-robin (a pair meets
// twice, weeks apart) by picking the sheet match with the closest date.

export type MatchLike = { team1: string; team2: string; date: string };

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
  if (full && t === normName(full)) return true;
  // Bare franchise tokens the sheet uses where the draft namespaces the code (LPL: JK→LPLJK).
  const aliases = TEAM_CODE_ALIASES[code];
  return !!aliases && aliases.some((a) => normName(a) === t);
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
    const key = tab + "\u0000" + lbl;
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
  // A key holding more than one row goes through pickDupRow — the ONE reduction (see the top of
  // this file). This map is what settles contests, so it was the one that most needed to stop
  // depending on which of the two rows the bot happened to write last.
  const pts = (row: string[]) => rowPoints(row, ptsIdx);
  const byKey = groupRows(
    rows.slice(1).filter((row) => row[matchIdx]?.trim() === target),
    (row) => [resolvePid(pidIdx >= 0 ? row[pidIdx]?.trim() : ""), nameIdx >= 0 ? row[nameIdx]?.trim() : ""]
      .filter(Boolean)
  );
  const result = new Map<string, number>();
  for (const [key, group] of byKey) {
    const v = pts(pickDupRow(`${target} ${key}`, group, pts, undefined, isPidKey(key)));
    // Every row for this player is blank => they have NO points, which is not a 0. Leaving the
    // key out keeps lookupPlayerPoints returning null so the UI renders "—", not "0.0".
    if (v !== null) result.set(key, v);
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
  const matchIdx = headerIdx(header, "Match");
  const tabIdx = headerIdx(header, TAB_COL);
  const wantTab = match ? tabOfMatch(rows, match) : null;
  const add = (k: string, v: number) => k && result.set(k, (result.get(k) ?? 0) + v);
  const inScope = (row: string[]) => {
    // Tour scope: prefer the match's own tab; else fall back to team-code scoping.
    if (wantTab != null) return row[tabIdx]?.trim() === wantTab;
    if (teamIdx >= 0) {
      const team = row[teamIdx]?.trim() ?? "";
      return tokenMatchesCode(team, team1) || tokenMatchesCode(team, team2);
    }
    return true;
  };
  // Sum ONE value PER MATCH per player, not one per row. Summing rows double-counted a duplicate
  // slot: Jane Maguire's single 46-point WWC match (two identical rows) read 92 on the draft
  // board — 100% inflation on the number a drafter picks on. The per-match reduction is the same
  // pickDupRow used for contest totals, so the board and the contest can't disagree.
  const pts = (row: string[]) => rowPoints(row, ptsIdx);
  // Group key = "<match label>\0<identity>" (a label holds spaces and " — "; \0 cannot appear).
  // No Match column, or a blank label cell (legacy / test-injected rows) => each row keys
  // uniquely, i.e. the plain SUM this function did before: nothing but a real duplicate moves.
  const byMatchKey = groupRows(
    rows.slice(1).filter(inScope).map((row, i) => ({ row, i })),
    ({ row, i }) => {
      const lbl = (matchIdx >= 0 ? row[matchIdx]?.trim() : "") || `#${i}`;
      const pid = resolvePid(pidIdx >= 0 ? row[pidIdx]?.trim() : "");
      const name = nameIdx >= 0 ? row[nameIdx]?.trim() : "";
      return [pid, name ? normName(name) : ""].filter(Boolean).map((k) => lbl + "\u0000" + k);
    }
  );
  for (const [mk, group] of byMatchKey) {
    const cut = mk.indexOf("\u0000");
    const [lbl, key] = [mk.slice(0, cut), mk.slice(cut + 1)];
    const v = pts(pickDupRow(`${lbl} ${key}`, group.map((g) => g.row), pts, undefined, isPidKey(key)));
    if (v !== null) add(key, v);
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

// The bot's per-match status + human flag + recon axis for one match — drives the results/match-
// page badges ("⏳ provisional — awaiting recon", "⚠ official revision pending", "🔵 L2 recon
// pending · −72 pts"). null when the sheet carries no "Match Status" column (legacy).
// `recon` is null and `delta` is 0 on tabs written before the Recon State / Points Delta columns.
export async function getMatchStatusFor(
  match: MatchLike
): Promise<{ status: MatchStatus; flag: string; recon: ReconState | null; delta: number } | null> {
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
    const pid = resolvePid(pidIdx >= 0 ? row[pidIdx]?.trim() : "");
    if (pid) out.set(pid, marker);
    if (name) out.set(name, marker);
  }
  return out;
}

// ── Settlement audit: the frozen "before" the live sheet is diffed against ────────────
// The points tabs are REWRITTEN in place every bot run, so the numbers a contest was settled
// on survive nowhere. The bot's WRITE-ONCE "SETTLEMENT AUDIT" tab records each player's points
// the first time their match published COMPLETED; comparing it to the live sheet is the only
// way to see that (say) Hasaranga's 114-point captain innings became a 0 when cricsheet landed.
//
// Deliberately a SEPARATE fetch, not part of the merged points pool: different schema (its
// "Settled Points" column would collide with "Fantasy Points" semantics), and it must never
// influence live scoring.
const SETTLEMENT_TAB = "SETTLEMENT AUDIT";

// Derive the settlement URL from the first configured points URL (same spreadsheet, different
// sheet) so no new env var is needed — one less thing to forget on a deploy, and Vercel's
// encrypted env is awkward to update safely. SETTLEMENT_CSV_URL overrides if ever needed.
function settlementUrl(): string | null {
  if (process.env.SETTLEMENT_CSV_URL) return process.env.SETTLEMENT_CSV_URL;
  const first = csvUrls()[0];
  if (!first) return null;
  try {
    const u = new URL(first);
    if (!u.searchParams.has("sheet")) {
      // An export?gid= style URL can't be retargeted by sheet name — rebuild the gviz form.
      const id = u.pathname.split("/")[3];
      if (!id) return null;
      return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv` +
        `&sheet=${encodeURIComponent(SETTLEMENT_TAB)}&headers=1`;
    }
    u.searchParams.set("sheet", SETTLEMENT_TAB);
    u.searchParams.set("headers", "1");
    return u.toString();
  } catch {
    return null;
  }
}

let _settleCache: { at: number; rows: string[][] } | null = null;
let _settleInflight: Promise<string[][] | null> | null = null;

async function getSettlementCsv(): Promise<string[][] | null> {
  if (_settleCache && Date.now() - _settleCache.at < CACHE_TTL_MS) return _settleCache.rows;
  if (_settleInflight) return _settleInflight;
  const url = settlementUrl();
  if (!url) return null;
  _settleInflight = fetchOne(url)
    .then((text) => {
      const rows = text ? parseCsv(text) : null;
      if (rows) _settleCache = { at: Date.now(), rows };   // cache successes only
      _settleInflight = null;
      return rows;
    })
    .catch(() => {
      _settleInflight = null;
      return null;
    });
  return _settleInflight;
}

// Test seam, mirroring __setPointsCacheForTest.
export function __setSettlementCacheForTest(rows: string[][] | null): void {
  _settleCache = rows ? { at: Date.now(), rows } : null;
  _settleInflight = null;
}

export type SettledRow = {
  pid: string;
  name: string;
  team: string;
  tour: string;
  points: number;
  status: string;
  source: string;
  frozenAt: string;
  /** 'live' = frozen by a real run at publish time (trustworthy). 'seed' = reconstructed from a
   *  pre-cricsheet run. 'unknown' = the match completed before the baseline existed and no
   *  evidence survives, so a zero delta here proves NOTHING and must be labelled as such. */
  provenance: "live" | "seed" | "unknown";
};

/** The settled baseline for one match, keyed by BOTH pid and name — the same shape
 *  getMatchPointsForMatch returns, so `calcSelectionPoints` can score the "before" side with
 *  the IDENTICAL scorer instead of spawning another scoring path (they always drift). */
export async function getSettledPointsForMatch(
  match: MatchLike
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const r of await getSettledRowsForMatch(match)) {
    if (r.pid) out.set(r.pid, r.points);
    if (r.name) out.set(r.name, r.points);
  }
  return out;
}

/** Full settled rows for one match. Matched on the settlement tab's own Match/Date columns via
 *  the SAME teams+date resolution the points tabs use, so the bot's match renumbering is
 *  irrelevant here too. */
export async function getSettledRowsForMatch(match: MatchLike): Promise<SettledRow[]> {
  const rows = await getSettlementCsv();
  if (!rows || rows.length < 2) return [];
  const target = resolveLabel(rows, match);
  if (!target) return [];
  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const pidIdx = headerIdx(header, "Player ID");
  const nameIdx = headerIdx(header, "Full Name");
  const teamIdx = headerIdx(header, "Team");
  const tourIdx = headerIdx(header, "Tour");
  const ptsIdx = headerIdx(header, "Settled Points");
  const stIdx = headerIdx(header, "Settled Status");
  const srcIdx = headerIdx(header, "Settled Source");
  const frIdx = headerIdx(header, "Frozen At");
  const prIdx = headerIdx(header, "Provenance");
  if (ptsIdx < 0) return [];
  const out: SettledRow[] = [];
  for (const row of rows.slice(1)) {
    if (row[mi]?.trim() !== target) continue;
    const pts = parseFloat(row[ptsIdx]);
    const prov = (prIdx >= 0 ? row[prIdx]?.trim() : "") || "live";
    out.push({
      pid: resolvePid(pidIdx >= 0 ? row[pidIdx]?.trim() : ""),
      name: nameIdx >= 0 ? (row[nameIdx]?.trim() ?? "") : "",
      team: teamIdx >= 0 ? (row[teamIdx]?.trim() ?? "") : "",
      tour: tourIdx >= 0 ? (row[tourIdx]?.trim() ?? "") : "",
      points: isNaN(pts) ? 0 : pts,
      status: stIdx >= 0 ? (row[stIdx]?.trim() ?? "") : "",
      source: srcIdx >= 0 ? (row[srcIdx]?.trim() ?? "") : "",
      frozenAt: frIdx >= 0 ? (row[frIdx]?.trim() ?? "") : "",
      provenance: prov === "seed" || prov === "unknown" ? prov : "live",
    });
  }
  return out;
}

export type LiveAuditRow = {
  pid: string;
  name: string;
  team: string;
  points: number | null;   // null = the row exists but has no points (Played = N)
  played: boolean;
  l2: string;              // "L2 Recon" column
  recon: string;           // "Player Recon" column
};

/** Every live sheet row for a match, INCLUDING rows whose Player ID is blank. The blank-pid
 *  rows matter most: they're the official-card lines that resolved to no player, so their
 *  points cannot reach any contest (lookupPlayerPoints refuses to fuzzy-fall-back for a pid'd
 *  player). Pairing one against a squad row that dropped to 0 is what identifies an identity
 *  break rather than a genuine benching. */
export async function getLiveAuditRows(match: MatchLike): Promise<LiveAuditRow[]> {
  const rows = await getCsv();
  if (!rows || rows.length < 2) return [];
  const target = resolveLabel(rows, match);
  if (!target) return [];
  const header = rows[0];
  const mi = headerIdx(header, "Match");
  const pidIdx = headerIdx(header, "Player ID");
  const nameIdx = headerIdx(header, "Full Name");
  const teamIdx = headerIdx(header, "Team");
  const ptsIdx = headerIdx(header, "Fantasy Points");
  const playedIdx = headerIdx(header, "Played");
  const l2Idx = headerIdx(header, "L2 Recon");
  const reconIdx = headerIdx(header, "Player Recon");
  const out: LiveAuditRow[] = [];
  for (const row of rows.slice(1)) {
    if (row[mi]?.trim() !== target) continue;
    const raw = ptsIdx >= 0 ? row[ptsIdx]?.trim() : "";
    const pts = raw ? parseFloat(raw) : NaN;
    out.push({
      pid: resolvePid(pidIdx >= 0 ? row[pidIdx]?.trim() : ""),
      name: nameIdx >= 0 ? (row[nameIdx]?.trim() ?? "") : "",
      team: teamIdx >= 0 ? (row[teamIdx]?.trim() ?? "") : "",
      points: isNaN(pts) ? null : pts,
      played: (playedIdx >= 0 ? row[playedIdx]?.trim() : "") === "Y",
      l2: l2Idx >= 0 ? (row[l2Idx]?.trim() ?? "") : "",
      recon: reconIdx >= 0 ? (row[reconIdx]?.trim() ?? "") : "",
    });
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
    const pid = resolvePid(pidIdx >= 0 ? (row[pidIdx]?.trim() ?? "") : "");
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
