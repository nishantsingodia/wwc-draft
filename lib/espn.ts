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
  for (const series of SERIES_BY_GENDER[match.gender] ?? []) {
    const eventId = await findEventId(series, match);
    if (!eventId) continue;
    const summary = await espnGet(series, "summary", { event: eventId });
    if (!summary) continue;

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
  if (f === "T20") return "T20";
  if (/odi/i.test(match.key)) return "ODI";
  if (/^THM|^THW/i.test(match.key)) return "HUN";
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
  const fmt = scoreFormatOf(match);
  for (const series of SERIES_BY_GENDER[match.gender] ?? []) {
    const eventId = await findEventId(series, match);
    if (!eventId) continue;
    const summary = await espnGet(series, "summary", { event: eventId });
    if (!summary) continue;

    const points = new Map<string, number>();
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
        const g = flattenStats(p.linescores);
        const get = (k: string) => g.get(k) ?? 0;
        // BOWLING wickets ONLY. `dismissals` is a FIELDING stat (catches + stumpings the
        // player took, e.g. a keeper's 3 catches) — NOT their bowling wickets. Counting it
        // credited a catcher a phantom wicket (verified: Shedge b=18 w=0 dism=1). Catches
        // are scored separately via `caught`; never fold `dismissals` into bowling wickets.
        const bowlWkts = get("wickets");
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
