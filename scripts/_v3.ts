#!/usr/bin/env npx tsx
// TEMP: per-contest H2H under both scorers, for the 6 contests that diverge.
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });

import { getDb, draftContests, teamSelections } from "../lib/db";
import { inArray } from "drizzle-orm";
import { LOCK_BUFFER, getMatchByKey } from "../lib/matches";
import { getMatchPointsForMatch, lookupPlayerPoints, __setPointsCacheForTest, __setSettlementCacheForTest } from "../lib/points";
import { getOfficialLineup } from "../lib/official-lineup";
import { calcSelectionPoints } from "../lib/contest-scoring";
import { computeEffectiveLineup, rankingFromSelection } from "../lib/effective-lineup";
import { getPlayerByKey, getByTeamCode } from "../lib/players";
import { tourRulesFor } from "../lib/tour-rules";
import { mergedRows, settlementRows } from "./_vlib";

const ROWS = mergedRows();
const SROWS = settlementRows();
const pin = () => { __setPointsCacheForTest(ROWS); __setSettlementCacheForTest(SROWS); };

const CODES = ["HJHTEU", "6ARSS3", "7QNGS7", "T6B2UB", "SME9U3", "724454"];

async function main() {
  const db = getDb();
  const contests = (await db.select().from(draftContests)).filter((c) => CODES.includes(c.code));
  const sels = await db.select().from(teamSelections).where(inArray(teamSelections.contestId, contests.map((c) => c.id)));
  for (const c of contests) {
    pin();
    const match = getMatchByKey(c.matchKey)!;
    const pointsMap = await getMatchPointsForMatch(match);
    pin();
    const { lastXI, lineupMeta } = await getOfficialLineup(match);
    pin();
    const announced = !!(getByTeamCode(lineupMeta, match.team1)?.announced && getByTeamCode(lineupMeta, match.team2)?.announced);
    const nowSec = Math.floor(Date.now() / 1000);
    const eligible = c.mode === "live" && nowSec >= c.matchDeadline + LOCK_BUFFER && announced;
    const bi = tourRulesFor(match).backupIntelligence;
    const res: string[] = [];
    for (const sel of sels.filter((s) => s.contestId === c.id)) {
      const lobby = calcSelectionPoints(sel, c.picksPerUser, pointsMap);
      const keys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
      const ranking = rankingFromSelection(keys, sel.captainKey, sel.viceCaptainKey);
      const eff = (eligible && sel.effectiveComputedAt && sel.effectiveLineup)
        ? JSON.parse(sel.effectiveLineup)
        : computeEffectiveLineup({ ranking, picksPerUser: c.picksPerUser, teamXIByTeam: lastXI, resolve: getPlayerByKey, inMatchTeams: [match.team1, match.team2], announced: eligible, backupIntelligence: bi });
      let t = 0, any = false;
      for (const k of eff.xi) {
        const p = getPlayerByKey(k); if (!p) continue;
        const r = lookupPlayerPoints(p.pid, p.displayName, p.name, pointsMap, false);
        if (r !== null) { any = true; t += r * (k === eff.captainKey ? 2 : k === eff.viceCaptainKey ? 1.5 : 1); }
      }
      res.push(`${sel.user}: lobby=${lobby} results=${any ? t : null}`);
    }
    console.log(`${c.code} [${c.matchKey}] ${res.join("  |  ")}`);
  }
}
main().then(() => process.exit(0));
