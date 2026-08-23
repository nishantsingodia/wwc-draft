/**
 * check:seed — reconcile the hand-maintained squad seed against what the FEEDS actually say,
 * for every tour with a recent match. Run it manually or on a schedule; it makes network calls,
 * so it deliberately does NOT live inside `check:tours` (which is hermetic and gates CI).
 *
 * WHY THIS EXISTS. `data/players-raw.json` is hand-maintained, so it is always one edit behind a
 * late signing, and a pid we invented (`uncapped:` / `cs:` / `slug:`) is one that no feed can ever
 * confirm. Both failures are SILENT — the app doesn't error, it just quietly answers "he didn't
 * play" or doesn't list him. CPL 2026 is the worked example: Joshua James sat on a bench with 81
 * points because the seed said `uncapped:joshua-james` while ESPN said `ci:1209191`, and nothing
 * anywhere said so. This report is what should have told us, before the contest instead of after.
 *
 * Three questions, per team, oldest-to-newest across the tour:
 *   A. who has the feed FIELDED that the seed has never heard of?     (→ add to the squads file)
 *   B. whose seeded pid DISAGREES with the id the feed carries?       (→ bridge + rebuild)
 *   C. who is still on a placeholder pid the feed can't confirm?      (→ bridge when an id appears)
 *
 * Every fix is upstream, in wwc-points-bot:
 *   registry/manual_ci_bridges.json  ->  build_registry.py "<tour>"  ->  backfill_draft_pids.py
 * Do NOT hand-edit `pid` in players-raw.json — the next backfill reverts it.
 *
 * Exit code is 0 unless --strict is passed: this is a report to act on, not a build gate.
 */
import matches from "../data/matches.json";
import roster from "../data/players-raw.json";
import espnSeries from "../data/espn-series.json";
import { TEAM_NAMES, isFeedComparablePid } from "../lib/players";
import { normName, fuzzyMatchName } from "../lib/fuzzy-name-match";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/cricket";
// Never send a browser UA — ESPN's WAF 403s "Mozilla/*" on this host and the 403 is
// indistinguishable from "no data". Same constant as lib/espn.ts.
const UA = "wwc-draft/1.0 (+https://github.com/nishantsingodia/wwc-draft)";

type M = { team1: string; team2: string; gender: string; key: string; date: string };
const ms = (matches as M[]).filter((m) => m.team1 !== "TBD" && m.team2 !== "TBD");
const players = roster as Array<{ name: string; pid?: string; team_code: string }>;

const STRICT = process.argv.includes("--strict");
// How far back to look. A tour's squad drift only matters while it is running.
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.slice(7) ?? 21);
const now = Date.now();
const since = now - DAYS * 86400_000;

async function get(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      console.error(`   ! ${res.status} from ${url}`);
      return null;
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    console.error(`   ! ${(e as Error).message}`);
    return null;
  }
}

const day = (iso: string) => iso.slice(0, 10).replace(/-/g, "");
const teamKey = (s: string) => normName(s.replace(/\b(?:wo)?men\b/gi, ""));

/** Every athlete the feed has fielded, per OUR team code, across the tour's played matches. */
async function fieldedByTeam(series: string, played: M[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const codeByKey = new Map<string, string>();
  for (const m of played)
    for (const c of [m.team1, m.team2]) codeByKey.set(teamKey(TEAM_NAMES[c] ?? c), c);

  const events = new Set<string>();
  for (const d of new Set(played.map((m) => day(m.date)))) {
    // ±1 day: match.date is IST, ESPN's scoreboard day is not.
    for (const off of [-1, 0, 1]) {
      const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() + off);
      const sb = await get(`${ESPN_BASE}/${series}/scoreboard?dates=${day(dt.toISOString())}`);
      for (const e of (sb?.events as Array<Record<string, unknown>>) ?? []) events.add(e.id as string);
    }
  }

  for (const ev of events) {
    const sum = await get(`${ESPN_BASE}/${series}/summary?event=${ev}`);
    for (const t of (sum?.rosters as Array<Record<string, unknown>>) ?? []) {
      const tname = ((t.team as Record<string, unknown>)?.displayName as string) ?? "";
      const code = codeByKey.get(teamKey(tname));
      if (!code) continue;
      const m = out.get(code) ?? new Map<string, string>();
      for (const p of (t.roster as Array<Record<string, unknown>>) ?? []) {
        const a = (p.athlete as Record<string, unknown>) ?? {};
        // ESPN's athlete.id IS the ESPNcricinfo id, so `ci:<id>` is the pid by definition.
        if (a.id) m.set(String(a.id), (a.displayName as string) ?? (a.fullName as string) ?? "");
      }
      out.set(code, m);
    }
  }
  return out;
}

async function main() {
  // Group recent matches by the ESPN series that covers their gender. A gender can list several
  // series (parallel tours), so probe each and keep whatever answers for these fixtures.
  const recent = ms.filter((m) => {
    const t = Date.parse(m.date);
    return t >= since && t <= now;
  });
  if (!recent.length) {
    console.log(`nothing played in the last ${DAYS} days — nothing to reconcile.`);
    return;
  }

  const problems: string[] = [];
  const byGender = new Map<string, M[]>();
  for (const m of recent) byGender.set(m.gender, [...(byGender.get(m.gender) ?? []), m]);

  for (const [gender, gms] of byGender) {
    for (const series of (espnSeries as Record<string, string[]>)[gender] ?? []) {
      const fielded = await fieldedByTeam(series, gms);
      if (!fielded.size) continue;

      for (const [code, athletes] of fielded) {
        const squad = players.filter((p) => p.team_code === code);
        if (!squad.length) continue;
        const pids = new Set(squad.map((p) => p.pid).filter(Boolean) as string[]);
        const names = squad.map((p) => p.name);

        // A — fielded by the feed, absent from the seed.
        const unknown = [...athletes]
          .filter(([id, nm]) => !pids.has(`ci:${id}`) && !names.some((n) => normName(n) === normName(nm)))
          .filter(([, nm]) => fuzzyMatchName(nm, names) === null);
        for (const [id, nm] of unknown)
          problems.push(`[A] ${code}: ESPN fielded "${nm}" (ci:${id}) — not in players-raw.json`);

        // B — seeded pid disagrees with the id the feed carries for that person.
        const byNorm = new Map([...athletes].map(([id, nm]) => [normName(nm), id]));
        for (const p of squad) {
          const id = byNorm.get(normName(p.name));
          if (id && p.pid !== `ci:${id}`)
            problems.push(`[B] ${code}: "${p.name}" seeded ${p.pid} but the feed says ci:${id}`);
        }

        // C — placeholder pids, split by whether the feed has already handed us a real id.
        for (const p of squad) {
          if (!p.pid || isFeedComparablePid(p.pid)) continue;
          const id = byNorm.get(normName(p.name));
          problems.push(
            id
              ? `[C] ${code}: "${p.name}" is ${p.pid} but the feed HAS an id — bridge it to ci:${id}`
              : `[C] ${code}: "${p.name}" is ${p.pid}, feed has fielded no id yet — name-matched only`
          );
        }
      }
    }
  }

  if (!problems.length) {
    console.log(`✅ seed matches the feed across ${recent.length} match(es) in the last ${DAYS} days.`);
    return;
  }
  const actionable = problems.filter((p) => !p.includes("fielded no id yet"));
  console.log(`\n${problems.length} finding(s) — ${actionable.length} actionable:\n`);
  for (const p of problems.sort()) console.log(`  ${p}`);
  console.log(
    `\nFix upstream in wwc-points-bot, never by hand-editing players-raw.json:\n` +
      `  1. add the name -> cricinfo id to registry/manual_ci_bridges.json (and the player to the tour's *_squads.json)\n` +
      `  2. python3 build_registry.py "<tour name>"\n` +
      `  3. python3 registry/backfill_draft_pids.py    # re-stamps players-raw.json + the mirrors\n` +
      `  4. redeploy this app — players-raw.json is bundled at build time`
  );
  if (STRICT && actionable.length) process.exit(1);
}

main();
