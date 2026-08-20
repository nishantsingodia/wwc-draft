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
import { markLivePointsMap } from "./live-map";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/cricket";

// ESPN's WAF 403s browser-impersonating User-Agents on this host: a bare "Mozilla/5.0" is
// rejected while curl's, a runtime default and an honest bot UA all pass. espnGet returns null
// on !res.ok, so the 403 presented as "ESPN has no data" — no announced XI (lineups silently
// fell back to the sheet) and no live H2H points. Do NOT put "Mozilla" back.
const ESPN_UA = "wwc-draft/1.0 (+https://github.com/nishantsingodia/wwc-draft)";

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

// Team identity that survives gender qualifiers (ESPN suffixes "Southern Brave (Men)" /
// "(Women)" for the Hundred's parallel comps) and feed spelling drift. Strip BOTH "men"
// and "women" as whole words — stripping only "women" left every men's match unmatched
// (the men's Hundred showed 0). Mirrors the bot's team_key `_GENDER_QUAL`.
function teamKey(name: string): string {
  return normName(name.replace(/\b(?:wo)?men\b/gi, ""));
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
      headers: { "User-Agent": ESPN_UA },
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
  match: Match,
  dates: string[] = dateVariants(match.date)
): Promise<string | null> {
  const want = [teamKey(TEAM_NAMES[match.team1] ?? match.team1), teamKey(TEAM_NAMES[match.team2] ?? match.team2)]
    .sort()
    .join("|");
  for (const d of dates) {
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

// ── resolving a match to its ESPN event: the app's slowest single operation ───────
//
// Every ESPN read (announced XI, full roster, live scorecard) first has to answer "which
// ESPN event is this match?" — and the honest way to ask is to scan the gender's series
// list. That list is now 9 ids for men, and the old scan was SEQUENTIAL over series × 3
// date variants: up to 27 round-trips, measured at ~15s cold, on the critical path of the
// results page, the match hub and the lobby. It also ran three times per request, once per
// consumer, because nothing remembered the answer.
//
// Two changes, no behaviour difference:
//   1. Try the EXACT date across every series CONCURRENTLY, and only fall back to ±1 day
//      (the US/IST calendar skew) if nothing hits. The exact date is right almost always,
//      so the common case is one parallel round of fetches instead of up to 27 serial ones.
//   2. Remember the resolved (series, eventId) per match key for the life of the process.
//      An event id never changes once assigned, so this is a permanent fact, and all three
//      consumers now share one resolution instead of racing to recompute it.
type EspnEvent = { series: string; eventId: string };
const _eventCache = new Map<string, EspnEvent | null>();
const _eventInflight = new Map<string, Promise<EspnEvent | null>>();

async function resolveEvent(match: Match): Promise<EspnEvent | null> {
  const hit = _eventCache.get(match.key);
  // A cached MISS is not cached permanently — a fixture ESPN hasn't posted yet must
  // still resolve later — so only a positive hit short-circuits.
  if (hit) return hit;
  const inflight = _eventInflight.get(match.key);
  if (inflight) return inflight;

  const run = (async (): Promise<EspnEvent | null> => {
    const series = SERIES_BY_GENDER[match.gender] ?? [];
    const [exact, ...nearby] = dateVariants(match.date);
    for (const dates of [[exact], nearby]) {
      if (dates.length === 0) continue;
      const found = await Promise.all(
        series.map(async (s) => {
          const eventId = await findEventId(s, match, dates);
          return eventId ? { series: s, eventId } : null;
        })
      );
      // Keep the series list's own priority order rather than whichever fetch won the race.
      const first = found.find(Boolean) ?? null;
      if (first) {
        _eventCache.set(match.key, first);
        return first;
      }
    }
    _eventCache.set(match.key, null);
    return null;
  })();

  _eventInflight.set(match.key, run);
  try {
    return await run;
  } finally {
    _eventInflight.delete(match.key);
  }
}

/** The ESPN summary payload for a match — one resolution, one fetch, shared by all readers. */
async function matchSummary(match: Match): Promise<Record<string, unknown> | null> {
  const ev = await resolveEvent(match);
  if (!ev) return null;
  return espnGet(ev.series, "summary", { event: ev.eventId });
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
  const summary = await matchSummary(match);
  if (!summary) return null;
  {

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
        // ESPN's `fullName` is the full LEGAL name the registry doesn't carry; the common
        // `displayName` is what matches. Key by both so the identity join is robust.
        const nm = ((a.displayName as string) || (a.fullName as string) || "").trim();
        if (!nm) continue;
        const full = ((a.fullName as string) || "").trim();
        // Key by THREE things so isPlayerInOfficialXI matches by identity, not a name gamble:
        //   1. the player's stable REGISTRY pid (resolved from ESPN's id, else ESPN's name via
        //      the registry's alias spellings) — matches a slug:/cricsheet_id player whose pid
        //      isn't an espn id and whose ESPN romanization differs from our display name;
        //   2. `espn:<id>` (a player whose registry pid IS the espn id);
        //   3. the raw name (legacy fuzzy fallback for anyone the registry doesn't know yet).
        const regPid = resolveAthletePid(a);
        if (regPid) xi.set(regPid, 0);
        if (a.id) xi.set(`espn:${a.id}`, 0);
        xi.set(nm, 0);
        if (full && full !== nm) xi.set(full, 0);
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

// ── public: the FULL match roster (XI + named subs/bench) ─────────────────────────
// getEspnLineup answers "who is in the XI" as an identity-keyed membership map, which is
// all the substitution engine needs. The lineup-amendment screen needs the other half:
// the actual ROSTER as a list of people — name, role, team, whether they're starting, and
// each one's stable registry pid — so a LATE SQUAD ADDITION who was never in
// players-raw.json (and has no sheet row yet, so the self-heal roster can't see them
// either) can be picked and scored properly instead of being stood in for by a dummy.
export type EspnRosterEntry = {
  espnId: string | null;
  /** Stable registry pid (ci:<cricinfoId> / slug: / cricsheet hash), null if unknown. */
  pid: string | null;
  name: string;
  role: Role;
  starter: boolean;
  photo: string | null;
};
export type EspnMatchRoster = Map<string, EspnRosterEntry[]>; // teamCode -> roster

const ROSTER_TTL_MS = 60_000;
const _rosterCache = new Map<string, { at: number; val: EspnMatchRoster | null }>();

export async function getEspnMatchRoster(
  match: Match,
  opts?: { fresh?: boolean }
): Promise<EspnMatchRoster | null> {
  const cached = _rosterCache.get(match.key);
  if (!opts?.fresh && cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached.val;
  let val: EspnMatchRoster | null = null;
  try {
    val = await fetchEspnMatchRoster(match);
  } catch {
    // Best-effort like every other ESPN path: a parse hiccup must not break the screen.
    val = null;
  }
  _rosterCache.set(match.key, { at: Date.now(), val });
  return val;
}

async function fetchEspnMatchRoster(match: Match): Promise<EspnMatchRoster | null> {
  const summary = await matchSummary(match);
  if (!summary) return null;
  {
    const codeByKey = new Map<string, string>([
      [teamKey(TEAM_NAMES[match.team1] ?? match.team1), match.team1],
      [teamKey(TEAM_NAMES[match.team2] ?? match.team2), match.team2],
    ]);

    const out: EspnMatchRoster = new Map();
    for (const team of (summary.rosters as Array<Record<string, unknown>>) ?? []) {
      const tname = ((team.team as Record<string, unknown>)?.displayName as string) ?? "";
      const code = codeByKey.get(teamKey(tname));
      if (!code) continue;

      const entries: EspnRosterEntry[] = [];
      const seen = new Set<string>();
      for (const p of (team.roster as Array<Record<string, unknown>>) ?? []) {
        const a = (p.athlete as Record<string, unknown>) ?? {};
        const name = ((a.displayName as string) || (a.fullName as string) || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const href = (a.headshot as Record<string, unknown>)?.href as string | undefined;
        entries.push({
          espnId: a.id ? String(a.id) : null,
          pid: resolveAthletePid(a),
          name,
          role: roleFromPosition(
            ((p.position as Record<string, unknown>)?.abbreviation as string) ?? ""
          ),
          // `subbedIn` players came on later but did feature — count them as starting so
          // the screen shows them under "playing", exactly as getEspnLineup's XI does.
          starter: !!(p.starter || p.subbedIn),
          // ESPN serves a generic silhouette for players with no photo; keep it — the UI
          // falls back to the flag on a 404 either way, and this is a picker not a scorer.
          photo: href ? espnThumb(href) : null,
        });
      }
      if (entries.length > 0) out.set(code, entries);
    }

    if (out.size > 0) return out;
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

// Three D11 rulesets: ODI, T20, and The Hundred (HUN — no SR/econ/maiden; see d11-score.ts).
// Prefer the explicit match.format (auto-ingest writes it) — authoritative and robust for
// multi-team ODI events whose keys omit "ODI". Fall back to a key-regex for older rows that
// predate the format field (Hundred keys are THMSC/THWSC).
function scoreFormatOf(match: Match): ScoreFormat {
  const f = (match.format || "").toUpperCase();
  if (f === "ODI") return "ODI";
  if (f === "HUN") return "HUN";
  if (f === "TEST") return "TEST";
  if (f === "T20") return "T20";
  if (/odi/i.test(match.key)) return "ODI";
  if (/^THM|^THW/i.test(match.key)) return "HUN";
  // Red ball must be recognised by key too, because the fall-through below is T20 — an unrecognised
  // Test would be scored with T20 rules (wicket +25, dot balls, SR/econ bands) and nothing would say so.
  if (/_TEST\d*$/i.test(match.key)) return "TEST";
  return "T20";
}

// Resolve an ESPN athlete to our registry pid, trying its name forms in the order that
// matches the registry's aliases. CRUCIAL: ESPN's `fullName` is the FULL LEGAL name
// ("Jamie Luke Smith", "Joseph Edward Root") which the registry does NOT carry — the
// common `displayName` ("Jamie Smith", "Joe Root") is what the aliases hold. Try id first
// (exact), then displayName, then fullName/shortName as fallbacks.
function resolveAthletePid(a: Record<string, unknown>): string | null {
  const id = a.id as string | number | undefined;
  for (const nm of [a.displayName, a.fullName, a.shortName]) {
    if (typeof nm === "string" && nm.trim()) {
      const pid = resolveEspnPid(id, nm.trim());
      if (pid) return pid;
    }
  }
  return null;
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

// A super over is period 3+, and Dream11 awards NO points for it — the bot drops those
// deliveries in parse_espn and in espn_batting_card. Measured over the 139 cached summary
// payloads on disk: 4603 roster linescores, ALL of them period 1 or 2, so this is worth 0 FP
// today and exists so the two readers below cannot disagree about which balls count. A missing
// `period` stays IN (Number(undefined)||0 = 0), because dropping a line we can't date would be
// this file's own bug class — an absence deciding a value.
const SCORING_PERIODS = 2;
// RED BALL: periods 3 and 4 are the SECOND innings of each side, not a super over, so a Test must
// read up to 4. Keeping the white-ball cap at 2 is what still excludes super-overs there (D11 awards
// no super-over points). Both readers below take this from the same helper so they cannot disagree.
const TEST_SCORING_PERIODS = 4;
const scoringPeriodsFor = (fmt: ScoreFormat) =>
  fmt === "TEST" ? TEST_SCORING_PERIODS : SCORING_PERIODS;

/**
 * PER-INNINGS stats for red ball: period number → that innings' stat map.
 *
 * flattenStats SUMS across periods on the stated assumption that "a player bats once and bowls in
 * the other" — true in white ball, FALSE in a Test, where he bats twice and bowls twice. Summing
 * destroys exactly the distribution Dream11's Test milestone and haul tiers are evaluated on, so
 * red ball needs the periods kept apart.
 */
function statsByPeriod(
  linescores: unknown,
  maxPeriod: number
): Map<number, Map<string, number>> {
  const out = new Map<number, Map<string, number>>();
  for (const period of (linescores as Array<Record<string, unknown>>) ?? []) {
    const per = Number(period.period) || 0;
    if (per > maxPeriod) continue;
    const m = out.get(per) ?? new Map<string, number>();
    for (const sub of (period.linescores as Array<Record<string, unknown>>) ?? []) {
      const cats =
        ((sub.statistics as Record<string, unknown>)?.categories as Array<Record<string, unknown>>) ??
        [];
      for (const c of cats) {
        for (const st of (c.stats as Array<Record<string, unknown>>) ?? []) {
          const name = st.name as string;
          const v = typeof st.value === "number" ? st.value : Number(st.value);
          if (name && Number.isFinite(v)) m.set(name, (m.get(name) ?? 0) + v);
        }
      }
    }
    out.set(per, m);
  }
  return out;
}

// Flatten one player's stat lines across both innings periods into name → summed value.
// Each concrete stat we read (runs, balls, wickets, …) is non-zero in only ONE period
// (a player bats once, bowls/fields in the other), so summing is the correct total.
function flattenStats(linescores: unknown, maxPeriod = SCORING_PERIODS): Map<string, number> {
  const out = new Map<string, number>();
  for (const period of (linescores as Array<Record<string, unknown>>) ?? []) {
    if ((Number(period.period) || 0) > maxPeriod) continue;
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

// ── DISMISSAL CREDITS: the +8 lbw/bowled bonus and run-out fielding ──────────────────────
//
// WHAT WENT WRONG. Until 14 Aug 2026 this file hard-coded `bowlLbwBowled: 0` and `runOuts: 0`
// with the comment "live feed doesn't expose" / "doesn't reliably attribute". That was false,
// and it cost the live H2H **41.3 FP per match** — measured bot-minus-app over 38 cached ESPN
// events, 857 rows joined on athlete id: +1096 FP lbw/bowled, +492 FP run-outs, ≈20 per SIDE,
// doubled on a captain. Friends were forming expectations on a number ~20 points light.
//
// Both facts are RIGHT HERE, structured and id-anchored, in the `summary` payload this file
// already downloads for the XI and the scorecard:
//   rosters[].roster[].linescores[].statistics.batting.outDetails
//     { "bowler": {"id": "677081"}, "dismissalCard": "bowled", "fielders": [] }
//     { "dismissalCard": "run out", "fielders": [{"athlete": {"id": "670031"}, …}] }
// So this costs ZERO extra requests — no new endpoint, no new round-trip.
//
// ⛔ THE ONE THING THAT IS GENUINELY UNAVAILABLE is the same fact from `playbyplay`: its
// `dismissal.fielder` is ALWAYS EMPTY on a run out (bot-measured 0/19 over 24 LPL events) and
// neither shortText nor text names the fielders. That is exactly why the bot reads run-outs
// from `summary` too (espn_runouts, wc_fps_to_csv.py:1055 — re-verified 16 Aug 2026, the old
// ":1014" anchor had drifted). And `playbyplay` must NEVER be fetched from this app anyway —
// paginated commentary is the known 15-hour-hang hazard.
//
// MEASURED on the 139 cached summaries (1656 batting lines): dismissalCard vocabulary is
// c 836 / not out 350 / bowled 240 / run out 99 / lbw 84 / st 39 / retired out 4 /
// retired not out 4 — ESPN's SCORECARD abbreviations ("c", "st"), NOT playbyplay's spelled-out
// "caught"/"stumped"; do not reuse that vocabulary here. 324/324 lbw+bowled lines carry
// `bowler.id`, and 324/324 of those ids are in the scored XI. All 99 run-outs carry a non-empty
// `fielders[]` (42 with one fielder = direct hit, 54 with two, 3 with three); 157/159 fielder
// ids are in the scored XI, the other 2 being substitute fielders we cannot score.
//
// Catches and stumpings are NOT taken from here — they already come from the per-player
// `caught`/`stumped` counters and those were verified correct.
type DismissalCredits = { lbwBowled: number; runOuts: number; directRunOuts: number };
const NO_CREDITS: DismissalCredits = { lbwBowled: 0, runOuts: 0, directRunOuts: 0 };

export function collectDismissalCredits(
  summary: Record<string, unknown>
): Map<string, DismissalCredits> {
  const out = new Map<string, DismissalCredits>();
  const credit = (id: string): DismissalCredits => {
    let c = out.get(id);
    if (!c) {
      c = { lbwBowled: 0, runOuts: 0, directRunOuts: 0 };
      out.set(id, c);
    }
    return c;
  };
  for (const team of (summary.rosters as Array<Record<string, unknown>>) ?? []) {
    for (const p of (team.roster as Array<Record<string, unknown>>) ?? []) {
      // Each batter's OWN scorecard line — no striker/non-striker ambiguity, which is the trap
      // in the ball-by-ball (there a run-out is attached to whoever was on strike).
      for (const ls of (p.linescores as Array<Record<string, unknown>>) ?? []) {
        if ((Number(ls.period) || 0) > SCORING_PERIODS) continue;
        const bat = (ls.statistics as Record<string, unknown>)?.batting as
          | Record<string, unknown>
          | undefined;
        const det = bat?.outDetails as Record<string, unknown> | undefined;
        if (!det) continue;
        const card = ((det.dismissalCard as string) ?? "").trim().toLowerCase();
        // "leg before wicket" has never been observed on THIS field (84/84 lbw lines say "lbw");
        // it is the spelling the *playbyplay* uses, and it is accepted here only so a feed that
        // switched vocabulary would lose no points silently. Everything else — "c", "st",
        // "retired out" — must NOT land here: those are scored from the fielding counters.
        if (card === "bowled" || card === "lbw" || card === "leg before wicket") {
          const bowlerId = String(((det.bowler as Record<string, unknown>)?.id as string) ?? "");
          if (bowlerId) credit(bowlerId).lbwBowled += 1;
        } else if (card === "run out") {
          const ids: string[] = [];
          for (const f of (det.fielders as Array<Record<string, unknown>>) ?? []) {
            const id = String((((f.athlete as Record<string, unknown>) ?? {}).id as string) ?? "");
            if (id) ids.push(id);
          }
          // Bot's rule (wc_fps_to_csv.py:1492-1500 — re-verified 16 Aug 2026, the old
          // ":1451-1460" anchor had drifted), mirrored exactly: EVERY listed fielder gets
          // a run-out credit, and a lone fielder additionally gets the direct-hit flag. So a
          // two-man run-out pays 6+6, a direct hit pays 12 to one player.
          for (const id of ids) {
            const c = credit(id);
            c.runOuts += 1;
            if (ids.length === 1) c.directRunOuts += 1;
          }
        }
      }
    }
  }
  return out;
}

// Small square headshot via ESPN's image combiner (~10KB vs ~280KB for the full PNG); it
// 404s for a missing id exactly like the original, so the <img> onError→flag fallback still
// fires. Leaves any non-espncdn href untouched.
function espnThumb(href: string, size = 96): string {
  const m = href.match(/^https?:\/\/a\.espncdn\.com(\/.+)$/);
  return m ? `https://a.espncdn.com/combiner/i?img=${m[1]}&w=${size}&h=${size}` : href;
}

// Pull a named numeric stat (e.g. "balls") from a linescore's nested statistics blocks.
function statValue(ls: Record<string, unknown>, name: string): number | null {
  const cats = ((ls.statistics as Record<string, unknown>)?.categories as Array<Record<string, unknown>>) ?? [];
  for (const c of cats) {
    for (const s of (c.stats as Array<Record<string, unknown>>) ?? []) {
      if ((s.name as string) === name) {
        const v = Number((s.value ?? s.displayValue) as string);
        return Number.isFinite(v) ? v : null;
      }
    }
  }
  return null;
}

// Freshness line for the live surfaces: how far the match had progressed when these
// provisional points were computed, read from the SAME ESPN summary the points come from.
// → "Points updated till 14.3 overs (138/4)". `overs` is ESPN's cricket-notation figure
// (14.3 = 14 overs 3 balls); The Hundred's "overs" are 5-ball units so we show balls there.
// Score-only fallback when overs aren't posted yet — a score is a fine freshness signal too
// (per Nishant). Null before the first ball (no innings started).
function buildFreshness(summary: Record<string, unknown>, format: ScoreFormat): string | null {
  const comp = ((summary.header as Record<string, unknown>)?.competitions as Array<Record<string, unknown>>)?.[0];
  const competitors = (comp?.competitors as Array<Record<string, unknown>>) ?? [];
  type Inn = { period: number; runs: number; wickets: number; overs: number; balls: number | null; isCurrent: number };
  let cur: Inn | null = null;
  for (const c of competitors) {
    for (const ls of (c.linescores as Array<Record<string, unknown>>) ?? []) {
      const runs = Number(ls.runs) || 0;
      const overs = Number(ls.overs) || 0;
      const balls = statValue(ls, "balls");
      if (overs <= 0 && runs <= 0 && (balls ?? 0) <= 0) continue; // innings not started
      const inn: Inn = {
        period: Number(ls.period) || 0,
        runs,
        wickets: Number(ls.wickets) || 0,
        overs,
        balls,
        isCurrent: ls.isCurrent ? 1 : 0,
      };
      // Prefer the current innings, then the later period, then the batting side (max runs
      // — the non-batting side carries a same-period 0-run linescore for that innings).
      if (
        !cur ||
        inn.isCurrent > cur.isCurrent ||
        (inn.isCurrent === cur.isCurrent &&
          (inn.period > cur.period || (inn.period === cur.period && inn.runs > cur.runs)))
      ) {
        cur = inn;
      }
    }
  }
  if (!cur) return null;
  const score = `${cur.runs}/${cur.wickets}`;
  if (format === "HUN") {
    const balls = cur.balls ?? Math.round(cur.overs * 5); // Hundred "overs" = 5-ball units
    return balls > 0 ? `Points updated · ${score} (${balls} balls)` : `Points updated · ${score}`;
  }
  if (cur.overs > 0) return `Points updated till ${cur.overs} overs (${score})`;
  return `Points updated · ${score}`;
}

// Per-player LIVE status derived from the ESPN scorecard + the two teams' innings states.
// Powers the results-page "cheer" chips (yet-to-bat / yet-to-bowl) and live bat/bowl lines.
export type LiveStatus = {
  batting: "OUT" | "NOW" | "NOTOUT" | "YET" | "DNB" | null;
  bowling: "NOW" | "DONE" | "YET" | "NA" | null;
  batLine?: string; // "44* (30)" or "30 (22)"
  bowlLine?: string; // "2/24 (3.2)"
};

// One row in the live Scorecard tab.
export type ScorecardBatter = {
  name: string;
  team: string;
  pid: string | null; // stable ci:<id> → joins auction/draft ownership; null if unresolved
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  sr: number;
  out: boolean;
  notOut: boolean;
};
export type ScorecardBowler = {
  name: string;
  team: string;
  pid: string | null;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
  econ: number;
};
export type Innings = {
  teamCode: string;
  teamName: string;
  runs: number;
  wickets: number;
  overs: string;
  batting: ScorecardBatter[];
  bowling: ScorecardBowler[];
};

// Per-team innings state from the header competitors' linescores.
// CRUCIAL: `isCurrent` marks the current PERIOD, and BOTH sides carry a linescore for it — the
// fielding side as a same-period 0-run line (verified against a live ESPN feed). So "has an
// isCurrent line" is NOT "is batting" — it flags both teams. Instead we identify the batting
// side of each period as the competitor with the most runs in it (the fielder's line is 0), and:
//   • the batting side of the CURRENT period → 'batting'
//   • a team that was the batting side of an EARLIER period → 'batted' (now fielding/done)
//   • everyone else → 'yet'
// Teams that don't resolve to one of our two codes are skipped. Best-effort — inside try/catch.
function inningsStateByTeam(
  summary: Record<string, unknown>,
  codeByKey: Map<string, string>
): Map<string, "batting" | "batted" | "yet"> {
  const out = new Map<string, "batting" | "batted" | "yet">();
  const comp = ((summary.header as Record<string, unknown>)?.competitions as Array<Record<string, unknown>>)?.[0];
  const competitors = (comp?.competitors as Array<Record<string, unknown>>) ?? [];

  type Row = { code: string; period: number; runs: number; overs: number; isCurrent: boolean };
  const rows: Row[] = [];
  for (const c of competitors) {
    const name = ((c.team as Record<string, unknown>)?.displayName as string) ?? "";
    const code = codeByKey.get(teamKey(name));
    if (!code) continue;
    for (const l of (c.linescores as Array<Record<string, unknown>>) ?? []) {
      rows.push({
        code,
        period: Number(l.period) || 0,
        runs: Number(l.runs) || 0,
        overs: Number(l.overs) || 0,
        isCurrent: !!l.isCurrent,
      });
    }
  }
  if (rows.length === 0) return out;
  for (const code of new Set(rows.map((r) => r.code))) out.set(code, "yet");

  // Current period = the latest period with any play (runs/overs) or an isCurrent flag.
  const active = rows.filter((r) => r.isCurrent || r.runs > 0 || r.overs > 0);
  const curPeriod = Math.max(...(active.length ? active : rows).map((r) => r.period));

  // Batting side of a period = competitor with the most runs (fielder's same-period line is 0).
  // At an innings' first ball everything is 0 → prefer the isCurrent line; null if truly no play.
  const battingOf = (period: number): string | null => {
    const inP = rows.filter((r) => r.period === period);
    if (inP.length === 0) return null;
    let best = inP[0];
    for (const r of inP) {
      if (r.runs > best.runs || (r.runs === best.runs && r.isCurrent && !best.isCurrent)) best = r;
    }
    return best.runs > 0 || best.overs > 0 || best.isCurrent ? best.code : null;
  };

  for (let p = 1; p < curPeriod; p++) {
    const b = battingOf(p);
    if (b) out.set(b, "batted");
  }
  const curBat = battingOf(curPeriod);
  if (curBat) out.set(curBat, "batting"); // overrides 'batted' if the same side bats again
  return out;
}

export type LiveScore = {
  points: Map<string, number>; // (pid | espn:<id> | name) → provisional D11 points
  anyStats: boolean; // true once at least one player has real bat/bowl figures (play has begun)
  freshness: string | null; // "Points updated till 14.3 overs (138/4)" — null pre-first-ball
  photos: Map<string, string>; // (pid | espn:<id> | name) → ESPN headshot URL (real photos only)
  status: Map<string, LiveStatus>; // (pid | espn:<id> | name) → per-player live status (live only)
  scorecard: Innings[]; // full innings breakdown for the live Scorecard tab
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
  const summary = await matchSummary(match);
  if (!summary) return null;
  return liveScoreFromSummary(summary, match);
}

/**
 * The whole live scorer as a PURE function of an ESPN `summary` payload.
 *
 * Split out from the fetch on 14 Aug 2026 so it can be replayed offline against cached
 * payloads — the 41.3 FP/match shortfall this file carried for weeks was invisible precisely
 * because nothing could exercise the scorer without the network. scripts/test-espn-dismissals.ts
 * drives it from checked-in fixtures.
 */
export function liveScoreFromSummary(
  summary: Record<string, unknown>,
  match: Match
): LiveScore | null {
  const fmt = scoreFormatOf(match);
  {

    // Tagged AT CONSTRUCTION, not on the way out: every `return` path below hands this same
    // object to a caller, and a tag applied at one of them is a tag the other paths lose.
    // The tag is what tells lookupPlayerPoints it may use the name fallback (lib/live-map.ts).
    const points = markLivePointsMap(new Map<string, number>());
    const photos = new Map<string, string>();
    const status = new Map<string, LiveStatus>();
    let anyStats = false;

    // Team identity for THIS match (mirrors fetchEspnLineup's codeByKey) + each side's innings
    // state — both feed the per-player live status chips and the Scorecard tab. Best-effort.
    const codeByKey = new Map<string, string>([
      [teamKey(TEAM_NAMES[match.team1] ?? match.team1), match.team1],
      [teamKey(TEAM_NAMES[match.team2] ?? match.team2), match.team2],
    ]);
    const stateByTeam = inningsStateByTeam(summary, codeByKey);
    // ONE pass over every batter's scorecard line, before scoring anyone: a bowler's lbw/bowled
    // bonus and a fielder's run-out credit are both facts about SOMEONE ELSE'S dismissal, so
    // they cannot be read from the credited player's own stat line. Keyed by ESPN athlete id,
    // which IS the cricinfo id — never by name.
    const credits = collectDismissalCredits(summary);
    // Per-player parsed lines, collected in the roster loop, for the Scorecard tab.
    type PlayerLine = {
      teamCode: string | undefined;
      pid: string | null;
      order: number;
      name: string;
      runs: number;
      balls: number;
      fours: number;
      sixes: number;
      outs: number;
      bowlBalls: number;
      conceded: number;
      wickets: number;
      maidens: number;
    };
    const lines: PlayerLine[] = [];

    const rosters = (summary.rosters as Array<Record<string, unknown>>) ?? [];
    for (const team of rosters) {
      const tname = ((team.team as Record<string, unknown>)?.displayName as string) ?? "";
      const teamCode = codeByKey.get(teamKey(tname));
      const myState = teamCode ? stateByTeam.get(teamCode) : undefined;
      const oppCode =
        teamCode === match.team1 ? match.team2 : teamCode === match.team2 ? match.team1 : undefined;
      const oppState = oppCode ? stateByTeam.get(oppCode) : undefined;
      const roster = (team.roster as Array<Record<string, unknown>>) ?? [];
      for (let ri = 0; ri < roster.length; ri++) {
        const p = roster[ri];
        // Only players actually in the XI (starter, or a sub who came on) are scored.
        if (!(p.starter || p.subbedIn)) continue;
        const a = (p.athlete as Record<string, unknown>) ?? {};
        const disp = ((a.displayName as string) || (a.fullName as string) || "").trim();
        if (!disp) continue;
        const maxPer = scoringPeriodsFor(fmt);
        const g = flattenStats(p.linescores, maxPer);
        const get = (k: string) => g.get(k) ?? 0;
        // BOWLING wickets ONLY. `dismissals` is a FIELDING stat (catches + stumpings the
        // player took, e.g. a keeper's 3 catches) — NOT their bowling wickets. Counting it
        // credited a catcher a phantom wicket (verified: Shedge b=18 w=0 dism=1). Catches
        // are scored separately via `caught`; never fold `dismissals` into bowling wickets.
        const bowlWkts = get("wickets");
        // A player with no dismissal credit is genuinely a zero here (nobody he bowled was lbw
        // or bowled, he was in no run-out) — unlike the hard-coded 0s this replaced, which said
        // the same thing about players who had five of them.
        const cred = credits.get(String(a.id ?? "")) ?? NO_CREDITS;
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
          bowlLbwBowled: cred.lbwBowled,
          catches: get("caught"),
          stumpings: get("stumped"),
          runOuts: cred.runOuts,
          directRunOuts: cred.directRunOuts,
        };
        // RED BALL: attach the per-innings split so scoreTest can evaluate the milestone and haul
        // tiers inside each innings. Batting/bowling counters come from that innings' own stat map;
        // fielding and the lbw/bowled credit stay on the match line, which is where scoreTest reads
        // them (fielding is untiered in Test, and ESPN reports dismissal credits per dismissal, not
        // per innings). Only innings the player actually appeared in are kept.
        if (fmt === "TEST") {
          const byPer = statsByPeriod(p.linescores, maxPer);
          const splits: Perf[] = [];
          for (const per of [...byPer.keys()].sort((a, b) => a - b)) {
            const m = byPer.get(per)!;
            const gv = (k: string) => m.get(k) ?? 0;
            const appeared =
              gv("runs") > 0 || gv("ballsFaced") > 0 || gv("balls") > 0 ||
              gv("wickets") > 0 || gv("outs") > 0;
            if (!appeared) continue;
            splits.push({
              ...perf,
              batRuns: gv("runs"),
              batBalls: gv("ballsFaced"),
              bat4s: gv("fours"),
              bat6s: gv("sixes"),
              batDismissed: gv("outs") > 0,
              bowlBalls: gv("balls"),
              bowlRuns: gv("conceded"),
              bowlWickets: gv("wickets"),
              bowlDots: gv("dots"),
              bowlMaidens: gv("maidens"),
              // Zeroed inside the split: these are added once at match level by scoreTest, so
              // leaving them populated here would multiply them by the number of innings.
              bowlLbwBowled: 0,
              catches: 0,
              stumpings: 0,
              runOuts: 0,
              directRunOuts: 0,
              innings: undefined,
            });
          }
          if (splits.length) perf.innings = splits;
        }
        // Run-outs count as "play has begun" too: Lizelle Lee (Hundred W ev1521201) finished
        // with two direct hits and NOTHING with bat or ball — 24 FP that the old test would
        // have called no stats at all.
        if (perf.batBalls || perf.bowlBalls || perf.catches || perf.stumpings || perf.runOuts)
          anyStats = true;
        const role = roleFromPosition(
          ((p.position as Record<string, unknown>)?.abbreviation as string) ?? ""
        );
        const pts = scoreD11(perf, role, fmt);
        const regPid = resolveAthletePid(a);
        if (regPid) points.set(regPid, pts);
        if (a.id) points.set(`espn:${a.id}`, pts);
        points.set(disp, pts);
        const full = ((a.fullName as string) || "").trim();
        if (full && full !== disp) points.set(full, pts);

        // ── Per-player LIVE STATUS (best-effort) — batting/bowling facet + one-line summary,
        // relative to this player's team state and the opponent's. Keyed the SAME three ways.
        const outs = get("outs");
        const ballsFaced = get("ballsFaced");
        const batRuns = get("runs");
        const bowlBalls = get("balls");
        const conceded = get("conceded");
        let batting: LiveStatus["batting"];
        if (outs > 0) batting = "OUT";
        else if (ballsFaced > 0) batting = myState === "batting" ? "NOW" : "NOTOUT";
        else batting = myState === "batting" || myState === "yet" ? "YET" : "DNB";
        let bowling: LiveStatus["bowling"];
        if (bowlBalls > 0) bowling = oppState === "batting" ? "NOW" : "DONE";
        else if (oppState === "batting" || oppState === "yet") bowling = "YET";
        else bowling = "NA";
        const batted = outs > 0 || ballsFaced > 0;
        const st: LiveStatus = {
          batting,
          bowling,
          batLine: batted
            ? `${batRuns}${outs === 0 && ballsFaced > 0 ? "*" : ""} (${ballsFaced})`
            : undefined,
          bowlLine:
            bowlBalls > 0
              ? `${bowlWkts}/${conceded} (${Math.floor(bowlBalls / 6)}.${bowlBalls % 6})`
              : undefined,
        };
        if (regPid) status.set(regPid, st);
        if (a.id) status.set(`espn:${a.id}`, st);
        status.set(disp, st);
        if (full && full !== disp) status.set(full, st);

        // Line for the Scorecard tab (roster order preserved via ri).
        lines.push({
          teamCode,
          pid: regPid ?? null,
          order: ri,
          name: disp,
          runs: batRuns,
          balls: ballsFaced,
          fours: get("fours"),
          sixes: get("sixes"),
          outs,
          bowlBalls,
          conceded,
          wickets: bowlWkts,
          maidens: get("maidens"),
        });

        // ESPN headshot, keyed the SAME way as points (pid | espn:<id> | name). Skip the
        // generic silhouette (default-player-logo) so the UI falls back cleanly to the team
        // flag instead of showing a grey placeholder. Best-effort + additive.
        const shot = ((a.headshot as Record<string, unknown>)?.href as string) || "";
        if (shot && !shot.includes("default-player-logo")) {
          const thumb = espnThumb(shot);
          if (regPid) photos.set(regPid, thumb);
          if (a.id) photos.set(`espn:${a.id}`, thumb);
          photos.set(disp, thumb);
          if (full && full !== disp) photos.set(full, thumb);
        }
      }
    }

    // ── SCORECARD (best-effort) — innings totals from the competitor linescores (each team's
    // batting side's current/last line), batting/bowling rows from the per-player lines above.
    // If an innings can't be confidently attributed we include what we can; any parse hiccup is
    // caught by the outer try/catch → sheet fallback.
    const compS = ((summary.header as Record<string, unknown>)?.competitions as Array<Record<string, unknown>>)?.[0];
    const competitorsS = (compS?.competitors as Array<Record<string, unknown>>) ?? [];
    type TeamInn = {
      teamCode: string;
      teamName: string;
      runs: number;
      wickets: number;
      overs: string;
      period: number;
    };
    const teamInns = new Map<string, TeamInn>();
    for (const c of competitorsS) {
      const nm = ((c.team as Record<string, unknown>)?.displayName as string) ?? "";
      const code = codeByKey.get(teamKey(nm));
      if (!code) continue;
      let best: { runs: number; wickets: number; overs: number; period: number } | null = null;
      for (const ls of (c.linescores as Array<Record<string, unknown>>) ?? []) {
        const runs = Number(ls.runs) || 0;
        const overs = Number(ls.overs) || 0;
        const wickets = Number(ls.wickets) || 0;
        const period = Number(ls.period) || 0;
        if (runs <= 0 && overs <= 0) continue;
        if (!best || runs > best.runs) best = { runs, wickets, overs, period };
      }
      if (best) {
        teamInns.set(code, {
          teamCode: code,
          teamName: TEAM_NAMES[code] ?? nm,
          runs: best.runs,
          wickets: best.wickets,
          overs: String(best.overs),
          period: best.period,
        });
      }
    }
    const scorecard: Innings[] = [];
    for (const ti of [...teamInns.values()].sort((a, b) => a.period - b.period)) {
      const oppCode = ti.teamCode === match.team1 ? match.team2 : match.team1;
      const batting: ScorecardBatter[] = lines
        .filter((l) => l.teamCode === ti.teamCode && (l.balls > 0 || l.outs > 0))
        .sort((a, b) => a.order - b.order)
        .map((l) => ({
          name: l.name,
          team: ti.teamCode,
          pid: l.pid,
          runs: l.runs,
          balls: l.balls,
          fours: l.fours,
          sixes: l.sixes,
          sr: l.balls > 0 ? (l.runs / l.balls) * 100 : 0,
          out: l.outs > 0,
          notOut: l.outs === 0 && l.balls > 0,
        }));
      const bowling: ScorecardBowler[] = lines
        .filter((l) => l.teamCode === oppCode && l.bowlBalls > 0)
        .sort((a, b) => b.bowlBalls - a.bowlBalls)
        .map((l) => ({
          name: l.name,
          team: oppCode,
          pid: l.pid,
          overs: `${Math.floor(l.bowlBalls / 6)}.${l.bowlBalls % 6}`,
          maidens: l.maidens,
          runs: l.conceded,
          wickets: l.wickets,
          econ: l.bowlBalls > 0 ? l.conceded / (l.bowlBalls / 6) : 0,
        }));
      scorecard.push({
        teamCode: ti.teamCode,
        teamName: ti.teamName,
        runs: ti.runs,
        wickets: ti.wickets,
        overs: ti.overs,
        batting,
        bowling,
      });
    }

    if (points.size > 0)
      return { points, anyStats, photos, freshness: buildFreshness(summary, fmt), status, scorecard };
  }
  return null;
}
