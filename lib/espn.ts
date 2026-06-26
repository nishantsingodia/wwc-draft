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

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/cricket";

// ESPN series ids per gender. KEEP IN SYNC with the bot's tours.json `espn_series`.
// W = Women's T20 World Cup 2026; M = the two men's tours running alongside.
const SERIES_BY_GENDER: Record<"W" | "M", string[]> = {
  W: ["1483859"],
  M: ["1532475", "1528556", "1528532"],
};

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
        // Key by name AND the stable espn pid, so isPlayerInOfficialXI matches
        // pid-first (our players carry `espn:<id>`) then fuzzy name.
        xi.set(nm, 0);
        if (a.id) xi.set(`espn:${a.id}`, 0);
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
