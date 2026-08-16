#!/usr/bin/env npx tsx
/**
 * The LIVE points map must be self-describing — lib/live-map.ts + lookupPlayerPoints + the
 * getMatchPointsMap gate.
 *
 * WHY THIS FILE EXISTS. `lookupPlayerPoints` takes a `liveFallback` flag: on the provisional
 * ESPN map a pid miss may fall back to the shared fuzzy name matcher (the map is keyed by name
 * too); on the bot's settled sheet it must NOT, because a namesake would steal settled points.
 * The results route passed the flag. `calcSelectionPoints` — the one scorer behind the lobby
 * cards, the match-hub H2H, /audit and every amendment preview — never did, so the same map at
 * the same second produced two different totals and the LOWER one was on the lobby.
 * Replayed over 170 cached ESPN summaries that cost 46 players / 2384 FP (14.0 FP per match);
 * against the prod DB it moved 15 real selections, e.g. IND v NED contest ZLHXQJ 674 → 1007
 * (Shafali Verma 222 as vice, pool pid ci:597821 vs ESPN athlete id 1182523).
 *
 * The flag now defaults from the MAP, so these tests pin the two things that must never regress:
 * a live map allows the fallback with NOBODY passing anything, and a sheet map still refuses it.
 *
 *   npx tsx scripts/test-live-map.ts
 */
import { markLivePointsMap, isLivePointsMap } from "../lib/live-map";
import { lookupPlayerPoints } from "../lib/points";
import { calcSelectionPoints } from "../lib/contest-scoring";
import { liveScoreFromSummary } from "../lib/espn";
import type { Match } from "../lib/matches";
import type { TeamSelection } from "../lib/db";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${extra}`}`);
}

console.log("\nlive-map — tagging");
{
  const live = markLivePointsMap(new Map<string, number>([["ci:1", 10]]));
  const sheet = new Map<string, number>([["ci:1", 10]]);
  check("a marked map reads as live", isLivePointsMap(live));
  check("an unmarked map reads as settled", !isLivePointsMap(sheet));
  check("markLivePointsMap returns the same object", markLivePointsMap(sheet) === sheet);
}

// The exact failure the fix targets: the pool's pid and the live map's pid are DIFFERENT ids for
// the same person (bot registry vs ESPN athlete id), so only the name key can join them.
// Real fork, still open at 6ac9b40 — the individual ids get corrected upstream over time (five
// were, mid-measurement), so this test is about the MECHANISM, not about these two numbers.
const POOL_PID = "ci:597821"; // what players-raw.json carries for Shafali Verma
const ESPN_PID = "ci:1182523"; // what ESPN's athlete.id makes lib/registry.ts construct
function forkedMap(live: boolean) {
  const m = new Map<string, number>([
    [ESPN_PID, 117],
    ["espn:1182523", 117],
    ["Shafali Verma", 117],
    ["ci:308967", 10],
    ["Jos Buttler", 10],
  ]);
  return live ? markLivePointsMap(m) : m;
}

console.log("\nlookupPlayerPoints — the flag now defaults from the map");
{
  const live = forkedMap(true);
  const sheet = forkedMap(false);
  check(
    "LIVE map + pid miss + NO flag passed -> name fallback recovers the join",
    lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, live) === 117,
    String(lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, live))
  );
  check(
    "SHEET map + pid miss + NO flag passed -> still strict (a namesake must not steal points)",
    lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, sheet) === null
  );
  check(
    "explicit false forces strict even on a LIVE map",
    lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, live, false) === null
  );
  check(
    "explicit true still works on an unmarked map (the results route's old call)",
    lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, sheet, true) === 117
  );
  check(
    "a pid that IS in the map never touches the fallback",
    lookupPlayerPoints("ci:308967", "Shafali Verma", undefined, live) === 10
  );
  check(
    "no pid -> fuzzy on name, unchanged on both map kinds",
    lookupPlayerPoints(undefined, "Jos Buttler", undefined, sheet) === 10 &&
      lookupPlayerPoints(undefined, "Jos Buttler", undefined, live) === 10
  );
}

console.log("\ncalcSelectionPoints — the surface that was short (lobby, match hub, /audit, amend)");
{
  // Two real pool keys so getPlayerByKey resolves; the XI is [captain, other].
  const sel = {
    selectedPlayers: JSON.stringify([]),
    captainKey: null,
    viceCaptainKey: null,
    effectiveComputedAt: 1,
    effectiveLineup: JSON.stringify({ xi: ["A", "B"], captainKey: "A", viceCaptainKey: "B" }),
  } as unknown as TeamSelection;
  // getPlayerByKey understands the synthetic "x|<pid>|<team>|<role>|<name>" external key, which is
  // how a late squad addition is carried — perfect here: it lets the test state the pid AND the
  // name explicitly instead of depending on players-raw.json staying still.
  const key = (pid: string, name: string) => `x|${pid}|MTMSG|BAT|${name}`;
  const withKeys = (a: string, b: string) =>
    ({
      ...sel,
      effectiveLineup: JSON.stringify({ xi: [a, b], captainKey: a, viceCaptainKey: b }),
    }) as unknown as TeamSelection;
  const s = withKeys(key(POOL_PID, "Shafali Verma"), key("ci:308967", "Jos Buttler"));
  const liveTotal = calcSelectionPoints(s, 2, forkedMap(true));
  const sheetTotal = calcSelectionPoints(s, 2, forkedMap(false));
  // captain 117×2 + vice 10×1.5 = 249; strict drops the captain entirely -> 15.
  check("LIVE map: the forked-pid captain is counted (117 ×2)", liveTotal === 249, String(liveTotal));
  check("SHEET map: unchanged, still strict", sheetTotal === 15, String(sheetTotal));
  check(
    "the gap this closes is the captain's DOUBLED score",
    (liveTotal ?? 0) - (sheetTotal ?? 0) === 234
  );
}

console.log("\nliveScoreFromSummary — the real map is tagged at construction");
{
  const summary = {
    rosters: [
      {
        team: { displayName: "Manchester Super Giants (Men)" },
        roster: [
          {
            starter: true,
            athlete: { id: "1182523", displayName: "Shafali Verma", fullName: "Shafali Verma" },
            position: { abbreviation: "BL" },
            linescores: [
              {
                period: 2,
                statistics: {},
                linescores: [
                  {
                    statistics: {
                      categories: [
                        { name: "g", stats: [{ name: "balls", value: 20 }, { name: "conceded", value: 20 }, { name: "wickets", value: 2 }] },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const m = {
    key: "THMSC_TEST", matchNum: 1, gender: "M", team1: "MTMSG", team2: "MTSUNL",
    label: "t", date: "2026-08-11T19:00:00+05:30", deadlineTs: 0, format: "HUN",
  } as Match;
  const live = liveScoreFromSummary(summary as Record<string, unknown>, m);
  check("scorer produced a map", !!live);
  check("that map is tagged live", !!live && isLivePointsMap(live.points));
  check(
    "and a pool pid that forked from ESPN's id still joins by name with no flag",
    !!live && lookupPlayerPoints(POOL_PID, "Shafali Verma", undefined, live.points) !== null
  );
}

console.log("\nanyStats — the fact lib/live-points.ts now gates on");
{
  // ESPN posts the XI ~30 min before the first ball. The scorer still returns a map, in which
  // every starter carries the bare +4 in-XI point and nothing else. getMatchPointsMap used to
  // hand that to the lobby card and the match hub as a live scoreline (11 × 4 = 44 a side) while
  // the results page, applying this same gate, correctly stayed on the sheet.
  const xiOnly = {
    rosters: [
      {
        team: { displayName: "Manchester Super Giants (Men)" },
        roster: [1, 2, 3].map((i) => ({
          starter: true,
          athlete: { id: `90000${i}`, displayName: `Player ${i}`, fullName: `Player ${i}` },
          position: { abbreviation: "BAT" },
          linescores: [{ period: 1, statistics: {}, linescores: [] }],
        })),
      },
    ],
  };
  const m = {
    key: "THMSC_TEST2", matchNum: 1, gender: "M", team1: "MTMSG", team2: "MTSUNL",
    label: "t", date: "2026-08-11T19:00:00+05:30", deadlineTs: 0, format: "HUN",
  } as Match;
  const live = liveScoreFromSummary(xiOnly as Record<string, unknown>, m);
  check("XI posted but no ball bowled -> a map exists", !!live && live.points.size > 0);
  check("…and anyStats is FALSE, which is what the gate reads", !!live && live.anyStats === false);
  check(
    "…and every value in it is the bare +4, i.e. a fiction if shown as a score",
    !!live && [...live.points.values()].every((v) => v === 4)
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
