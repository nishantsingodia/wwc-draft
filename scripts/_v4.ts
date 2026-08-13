#!/usr/bin/env npx tsx
// TEMP — claim 2: liveFallback asymmetry. Same ESPN live map, same XI; only the 5th arg
// of lookupPlayerPoints differs (results route passes useLive=true, calcSelectionPoints never does).
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });

import { getDb, draftContests, teamSelections } from "../lib/db";
import { getMatchByKey, getAllMatches } from "../lib/matches";
import { lookupPlayerPoints, __setPointsCacheForTest, __setSettlementCacheForTest } from "../lib/points";
import { getLiveMatchPoints } from "../lib/espn";
import { getPlayerByKey, getPlayersByTeams } from "../lib/players";
import { rankingFromSelection } from "../lib/effective-lineup";
import { mergedRows, settlementRows } from "./_vlib";

__setPointsCacheForTest(mergedRows());
__setSettlementCacheForTest(settlementRows());

const KEYS = process.argv.slice(2);

async function main() {
  const db = getDb();
  const contests = await db.select().from(draftContests);
  const sels = await db.select().from(teamSelections);
  for (const key of KEYS) {
    const match = getMatchByKey(key);
    if (!match) { console.log(key, "NO MATCH"); continue; }
    const live = await getLiveMatchPoints(match, { fresh: true });
    if (!live) { console.log(key, "ESPN: no live scorecard"); continue; }
    const map = live.points;
    const pidKeys = [...map.keys()].filter((k) => k.startsWith("ci:") || k.startsWith("espn:") || k.startsWith("slug:") || k.startsWith("cs:"));
    console.log(`\n=== ${key} — ESPN live map: ${map.size} keys (${pidKeys.length} pid-shaped), anyStats=${live.anyStats}`);
    // Pool players for this match
    const pool = getPlayersByTeams(match.team1, match.team2);
    let nameOnly = 0, nameOnlyPts = 0;
    const detail: string[] = [];
    for (const p of pool) {
      const strict = lookupPlayerPoints(p.pid, p.displayName, p.name, map, false);
      const loose = lookupPlayerPoints(p.pid, p.displayName, p.name, map, true);
      if (strict === null && loose !== null) { nameOnly++; nameOnlyPts += loose; detail.push(`${p.displayName} (pid=${p.pid}) ${loose}`); }
    }
    console.log(`pool=${pool.length}  resolve-ONLY-by-name=${nameOnly}  points invisible to lobby/hub=${nameOnlyPts}`);
    console.log(detail.join("\n"));
    // Contest-level
    for (const c of contests.filter((x) => x.matchKey === key)) {
      for (const sel of sels.filter((s) => s.contestId === c.id)) {
        const keysSel: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
        const ranking = rankingFromSelection(keysSel, sel.captainKey, sel.viceCaptainKey);
        const xi = (sel.effectiveComputedAt && sel.effectiveLineup) ? JSON.parse(sel.effectiveLineup).xi : ranking.slice(0, c.picksPerUser);
        const cap = (sel.effectiveComputedAt && sel.effectiveLineup) ? JSON.parse(sel.effectiveLineup).captainKey : ranking[0];
        const vc = (sel.effectiveComputedAt && sel.effectiveLineup) ? JSON.parse(sel.effectiveLineup).viceCaptainKey : ranking[1];
        const score = (fb: boolean) => {
          let t = 0, any = false;
          for (const k of xi) {
            const p = getPlayerByKey(k); if (!p) continue;
            const r = lookupPlayerPoints(p.pid, p.displayName, p.name, map, fb);
            if (r !== null) { any = true; t += r * (k === cap ? 2 : k === vc ? 1.5 : 1); }
          }
          return any ? t : null;
        };
        console.log(`  ${c.code} ${sel.user}: lobby/hub(strict)=${score(false)}  results(liveFallback)=${score(true)}`);
      }
    }
  }
}
main().then(() => process.exit(0));
