// Direct ESPN lineup fetch — the in-app replacement for the points-bot's
// every-5-min "live lineup" tick (GitHub throttled that schedule, so we pull the
// announced XI ourselves on demand). ~30 min before play ESPN's summary endpoint
// posts each side's playing XI in `rosters`, plus the toss in `notes`.
//
// This mirrors espn_event_id / espn_xi / espn_toss in the wwc-points-bot
// (wc_fps_to_csv.py). It returns the official XI in the SAME shape as
// getLastPlayedXI (Map<teamCode, Map<key, batOrder>>, keyed by BOTH name and the
// stable `espn:<id>` pid) and the same announced/toss shape as getLineupMeta — so
// both drop straight into the existing effective-lineup engine and In-XI display.
// Points still come from the sheet; ESPN only supplies WHO is in the XI.

import { type Match } from "./matches";
import { TEAM_NAMES } from "./players";
import { normName } from "./fuzzy-name-match";
import { resolveEspnPid } from "./registry";
import espnSeries from "@/data/espn-series.json";
import { scoreD11, type Perf, type Role, type ScoreFormat } from "./d11-score";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/cricket";

// ESPN series ids per gender. KEEP IN SYNC with the bot's tours.json `espn_series`.
// W = Women's T20 World Cup 2026; M = the two men's tours running alongside.
// ESPN series ids per gender — now in data/espn-series.json (machine-writable for
// the tour-sync job). KEEP IN SYNC with the bot's tours.json `espn_series`.
const SERIES_BY_GENDER = espnSeries as Record<"W" | "M", string[]>;

type EspnLineup = {
  // teamCode -> (name|pid) -> batOrder (0 = unknown, falls back to squad_number)
  xiByTeam: Map<string, Map<string, number>>;
  // teamCode -> announced/toss, same shape as getLineupMeta()
  lineupMeta: Map<string, { announced: boolean; toss: string | null }>;
};

// Team identity that survives "England" vs "England Women" and feed spelling drift.
function teamKey(name: string): string {
  return normName(name.replace(/women/gi, ""));
}

function dateVariants(iso: string): string[] {
  // match.date is ISO with IST offset; the date portion is the IST calendar day.
  const day = iso.slice(0, 10); // YYYY-MM-DD
  const base = new Date(day + "T00:00:00Z");
  if (isNaN(base.getTime())) return [day.replace(/-/g, "")];
  const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const prev = new Date(base.getTime() - 86400000);
  const next = new Date(base.getTime() + 86400000);
  return [fmt(base), fmt(prev), fmt(next)];
}

async function espnGet(
  series: string,
  path: string,
  params: Record<string, string>
): Promise<Record<string, unknown> | null> {
  const qs = new URLSearchParams(params).toString();
  const url = `${ESPN_BASE}/${series}/${path}?${qs}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      // ESPN data is fine to cache briefly at the platform layer.
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Find the ESPN event id for a match by team pair (date-tolerant ±1 day).
async function findEventId(
  series: string,
  match: Match
): Promise<string | null> {
  const want = [teamKey(TEAM_NAMES[match.team1] ?? match.team1), teamKey(TEAM_NAMES[match.team2] ?? match.team2)]
    .sort()
    .join("|");
  for (const d of dateVariants(match.date)) {
    const sb = await espnGet(series, "scoreboard", { dates: d });
    const events = (sb?.events as Array<Record<string, unknown>>) ?? [];
    for (const e of events) {
      const comps = (e.competitions as Array<Record<string, unknown>>)?.[0];
      const competitors = (comps?.competitors as Array<Record<string, unknown>>) ?? [];
      const names = competitors.map(
        (c) => ((c.team as Record<string, unknown>)?.displayName as string) ?? ""
      );
      if (names.length === 2) {
        const got = names.map(teamKey).sort().join("|");
        if (got === want) return (e.id as string) ?? null;
      }
    }
  }
  return null;
}

// ── public: official XI for a match, straight from ESPN (null if unavailable) ──
const CACHE_TTL_MS = 60_000;
const _cache = new Map<string, { at: number; val: EspnLineup | null }>();

export async function getEspnLineup(match: Match): Promise<EspnLineup | null> {
  const cached = _cache.get(match.key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.val;

  const val = await fetchEspnLineup(match);
  _cache.set(match.key, { at: Date.now(), val });
  return val;
}

async function fetchEspnLineup(match: Match): Promise<EspnLineup | null> {
  const seriesCandidates = SERIES_BY_GENDER[match.gender] ?? [];
  for (const series of seriesCandidates) {
    const eventId = await findEventId(series, match);
    if (!eventId) continue;

    const summary = await espnGet(series, "summary", { event: eventId });
    if (!summary) continue;

    // Toss text (single, applies to both sides).
    let toss: string | null = null;
    for (const n of (summary.notes as Array<Record<string, unknown>>) ?? []) {
      if (((n.type as string) ?? "").toLowerCase() === "toss") {
        toss = ((n.text as string) ?? "").trim().replace(/\s*,\s*/g, ", ") || null;
        break;
      }
    }

    // Our two team codes, keyed for matching against ESPN roster team names.
    const codeByKey = new Map<string, string>([
      [teamKey(TEAM_NAMES[match.team1] ?? match.team1), match.team1],
      [teamKey(TEAM_NAMES[match.team2] ?? match.team2), match.team2],
    ]);

    const xiByTeam = new Map<string, Map<string, number>>();
    const lineupMeta = new Map<string, { announced: boolean; toss: string | null }>();

    const rosters = (summary.rosters as Array<Record<string, unknown>>) ?? [];
    for (const team of rosters) {
      const tname = ((team.team as Record<string, unknown>)?.displayName as string) ?? "";
      const code = codeByKey.get(teamKey(tname));
      if (!code) continue;

      const xi = new Map<string, number>();
      for (const p of (team.roster as Array<Record<string, unknown>>) ?? []) {
        // ESPN flags the playing XI (and subs that came on) on the roster entry.
        if (!(p.starter || p.subbedIn)) continue;
        const a = (p.athlete as Record<string, unknown>) ?? {};
        const nm = ((a.fullName as string) || (a.displayName as string) || "").trim();
        if (!nm) continue;
        // Key by THREE things so isPlayerInOfficialXI matches by identity, not a name gamble:
        //   1. the player's stable REGISTRY pid (resolved from ESPN's id, else ESPN's name via
        //      the registry's alias spellings) — matches a slug:/cricsheet_id player whose pid
        //      isn't an espn id and whose ESPN romanization differs from our display name;
        //   2. `espn:<id>` (a player whose registry pid IS the espn id);
        //   3. the raw name (legacy fuzzy fallback for anyone the registry doesn't know yet).
        const regPid = resolveEspnPid(a.id as string | number | undefined, nm);
        if (regPid) xi.set(regPid, 0);
        if (a.id) xi.set(`espn:${a.id}`, 0);
        xi.set(nm, 0);
      }

      if (xi.size > 0) {
        xiByTeam.set(code, xi);
        lineupMeta.set(code, { announced: true, toss });
      }
    }

    // Only treat it as a hit if ESPN actually posted at least one side's XI.
    if (xiByTeam.size > 0) return { xiByTeam, lineupMeta };
  }
  return null;
}

// ── LIVE provisional scoring (in-app; the COMPLETED path is untouched) ────────────
// Fetch the ESPN scorecard for a match and compute a provisional D11 points map keyed
// the same way the roster joins (registry pid + espn:<id> + name). Used ONLY while a
// match is live to answer "where do I stand vs my opponent" instantly, with zero
// cricapi and no bot run. On completion the results route ignores this and reads the
// bot's reconciled sheet. Numbers here can differ from the final (fielding/dot/lbw
// detail lags in the live feed) — that's expected and surfaced as "provisional".

// ODI matches are the only non-T20 ruleset; their keys always contain "ODI"
// (WODI_…, M_NZWI_ODI1_…, M_ENG_IND_ODI1_…). Everything else — T20 AND The Hundred —
// scores on the T20 ruleset, matching the bot/auction (scoringFormatOf).
function scoreFormatOf(match: Match): ScoreFormat {
  return /odi/i.test(match.key) ? "ODI" : "T20";
}

// ESPN cricket maps a player position to a D11-ish role. Only BOWL matters to the
// scorer (SR-penalty + duck exclusions); anything unknown scores as a batter (safe).
function roleFromPosition(abbr: string): Role {
  const a = (abbr || "").toUpperCase();
  if (a === "BL" || a === "BOWL") return "BOWL";
  if (a === "WK") return "WK";
  if (a === "AR") return "AR";
  return "BAT";
}

// Flatten one player's stat lines across both innings periods into name → summed value.
// Each concrete stat we read (runs, balls, wickets, …) is non-zero in only ONE period
// (a player bats once, bowls/fields in the other), so summing is the correct total.
function flattenStats(linescores: unknown): Map<string, number> {
  const out = new Map<string, number>();
  for (const period of (linescores as Array<Record<string, unknown>>) ?? []) {
    for (const sub of (period.linescores as Array<Record<string, unknown>>) ?? []) {
      const cats =
        ((sub.statistics as Record<string, unknown>)?.categories as Array<Record<string, unknown>>) ??
        [];
      for (const c of cats) {
        for (const s of (c.stats as Array<Record<string, unknown>>) ?? []) {
          const name = s.name as string;
          const v = typeof s.value === "number" ? s.value : Number(s.value);
          if (name && Number.isFinite(v)) out.set(name, (out.get(name) ?? 0) + v);
        }
      }
    }
  }
  return out;
}

export type LiveScore = {
  points: Map<string, number>; // (pid | espn:<id> | name) → provisional D11 points
  anyStats: boolean; // true once at least one player has real bat/bowl figures (play has begun)
};

const LIVE_TTL_MS = 20_000;
const _liveCache = new Map<string, { at: number; val: LiveScore | null }>();

export async function getLiveMatchPoints(
  match: Match,
  opts?: { fresh?: boolean }
): Promise<LiveScore | null> {
  const cached = _liveCache.get(match.key);
  if (!opts?.fresh && cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.val;
  const val = await fetchLiveMatchPoints(match);
  _liveCache.set(match.key, { at: Date.now(), val });
  return val;
}

async function fetchLiveMatchPoints(match: Match): Promise<LiveScore | null> {
  try {
    return await fetchLiveMatchPointsInner(match);
  } catch {
    // The live path is best-effort and additive — never let an ESPN/parse hiccup break
    // the results page. On any error we return null → the route falls back to the sheet.
    return null;
  }
}

async function fetchLiveMatchPointsInner(match: Match): Promise<LiveScore | null> {
  const fmt = scoreFormatOf(match);
  for (const series of SERIES_BY_GENDER[match.gender] ?? []) {
    const eventId = await findEventId(series, match);
    if (!eventId) continue;
    const summary = await espnGet(series, "summary", { event: eventId });
    if (!summary) continue;

    const points = new Map<string, number>();
    let anyStats = false;
    const rosters = (summary.rosters as Array<Record<string, unknown>>) ?? [];
    for (const team of rosters) {
      for (const p of (team.roster as Array<Record<string, unknown>>) ?? []) {
        // Only players actually in the XI (starter, or a sub who came on) are scored.
        if (!(p.starter || p.subbedIn)) continue;
        const a = (p.athlete as Record<string, unknown>) ?? {};
        const nm = ((a.fullName as string) || (a.displayName as string) || "").trim();
        if (!nm) continue;
        const g = flattenStats(p.linescores);
        const get = (k: string) => g.get(k) ?? 0;
        const bowlWkts = get("wickets") || get("dismissals");
        const perf: Perf = {
          played: true,
          batRuns: get("runs"),
          batBalls: get("ballsFaced"),
          bat4s: get("fours"),
          bat6s: get("sixes"),
          batDismissed: get("outs") > 0,
          bowlBalls: get("balls"),
          bowlRuns: get("conceded"),
          bowlWickets: bowlWkts,
          bowlDots: get("dots"),
          bowlMaidens: get("maidens"),
          bowlLbwBowled: 0, // live feed doesn't expose the per-bowler lbw/bowled split
          catches: get("caught"),
          stumpings: get("stumped"),
          runOuts: 0, // live feed doesn't reliably attribute run-outs to a fielder
        };
        if (perf.batBalls || perf.bowlBalls || perf.catches || perf.stumpings) anyStats = true;
        const role = roleFromPosition(
          ((p.position as Record<string, unknown>)?.abbreviation as string) ?? ""
        );
        const pts = scoreD11(perf, role, fmt);
        const regPid = resolveEspnPid(a.id as string | number | undefined, nm);
        if (regPid) points.set(regPid, pts);
        if (a.id) points.set(`espn:${a.id}`, pts);
        points.set(nm, pts);
      }
    }
    if (points.size > 0) return { points, anyStats };
  }
  return null;
}
