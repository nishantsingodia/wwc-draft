#!/usr/bin/env npx tsx
// TEMP verification harness — claim 1: two scorers (lobby/audit vs results route)
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });

import { getDb, draftContests, teamSelections } from "../lib/db";
import { LOCK_BUFFER, getMatchByKey } from "../lib/matches";
import {
  getMatchPointsForMatch, isMatchCompleted, lookupPlayerPoints,
  __setPointsCacheForTest, __setSettlementCacheForTest,
} from "../lib/points";
import { getOfficialLineup } from "../lib/official-lineup";
import { calcSelectionPoints } from "../lib/contest-scoring";
import { computeEffectiveLineup, rankingFromSelection } from "../lib/effective-lineup";
import { getPlayerByKey, getByTeamCode } from "../lib/players";
import { tourRulesFor } from "../lib/tour-rules";
import { getMatchDelay } from "../lib/match-delay";
import { mergedRows, settlementRows } from "./_vlib";

const ROWS = mergedRows();
const SROWS = settlementRows();
const pin = () => { __setPointsCacheForTest(ROWS); __setSettlementCacheForTest(SROWS); };

async function main() {
  const db = getDb();
  const contests = await db.select().from(draftContests);
  const sels = await db.select().from(teamSelections);
  const byContest = new Map<number, typeof sels>();
  for (const s of sels) byContest.set(s.contestId, [...(byContest.get(s.contestId) ?? []), s]);

  let diverged = 0, checked = 0;
  const out: string[] = [];
  for (const c of contests) {
    pin();
    const match = getMatchByKey(c.matchKey);
    if (!match) continue;
    const selections = byContest.get(c.id) ?? [];
    if (!selections.length) continue;
    const nowSec = Math.floor(Date.now() / 1000);
    const matchDelay = await getMatchDelay(c.matchKey);
    const effDeadline = c.matchDeadline + matchDelay;
    if (nowSec < effDeadline) continue;
    pin();
    const pointsMap = await getMatchPointsForMatch(match);
    if (pointsMap.size === 0) continue;
    pin();
    const { lastXI, lineupMeta } = await getOfficialLineup(match);
    pin();
    const t1 = match.team1, t2 = match.team2;
    const announced = !!(t1 && t2 && getByTeamCode(lineupMeta, t1)?.announced && getByTeamCode(lineupMeta, t2)?.announced);
    const eligible = c.mode === "live" && nowSec >= effDeadline + LOCK_BUFFER && announced;
    const backupIntelligence = tourRulesFor(match).backupIntelligence;
    const completed = await isMatchCompleted(match);
    for (const sel of selections) {
      checked++;
      const lobby = calcSelectionPoints(sel, c.picksPerUser, pointsMap);
      const playerKeys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
      const ranking = rankingFromSelection(playerKeys, sel.captainKey, sel.viceCaptainKey);
      let eff: { xi: string[]; captainKey: string | null; viceCaptainKey: string | null };
      if (eligible && sel.effectiveComputedAt && sel.effectiveLineup) {
        eff = JSON.parse(sel.effectiveLineup);
      } else {
        eff = computeEffectiveLineup({
          ranking, picksPerUser: c.picksPerUser, teamXIByTeam: lastXI,
          resolve: getPlayerByKey, inMatchTeams: [t1, t2], announced: eligible, backupIntelligence,
        });
      }
      let total = 0, any = false;
      const inNames: string[] = [];
      for (const key of eff.xi) {
        const p = getPlayerByKey(key);
        if (!p) continue;
        const raw = lookupPlayerPoints(p.pid, p.displayName, p.name, pointsMap, false);
        if (raw !== null) { any = true; total += raw * (key === eff.captainKey ? 2 : key === eff.viceCaptainKey ? 1.5 : 1); }
      }
      const route = any ? total : null;
      // Which XI the lobby scorer used, for the diff detail
      let lobbyXI: string[];
      if (sel.effectiveComputedAt && sel.effectiveLineup) lobbyXI = JSON.parse(sel.effectiveLineup).xi;
      else lobbyXI = ranking.slice(0, c.picksPerUser);
      if (lobby !== route) {
        diverged++;
        const onlyRoute = eff.xi.filter((k) => !lobbyXI.includes(k)).map((k) => {
          const p = getPlayerByKey(k); const v = p ? lookupPlayerPoints(p.pid, p.displayName, p.name, pointsMap, false) : null;
          return `${p?.displayName ?? k}=${v}`;
        });
        const onlyLobby = lobbyXI.filter((k) => !eff.xi.includes(k)).map((k) => {
          const p = getPlayerByKey(k); const v = p ? lookupPlayerPoints(p.pid, p.displayName, p.name, pointsMap, false) : null;
          return `${p?.displayName ?? k}=${v}`;
        });
        out.push(`${c.code} [${c.matchKey}] ${sel.user}: LOBBY/AUDIT=${lobby} RESULTS=${route} Δ=${(route ?? 0) - (lobby ?? 0)} | eligible=${eligible} frozen=${sel.effectiveComputedAt ?? "NULL"} announced=${announced} mode=${c.mode} bi=${backupIntelligence} completed=${completed}\n      results-only IN: ${onlyRoute.join(", ")}\n      lobby-only  IN: ${onlyLobby.join(", ")}\n      capLobby=${getPlayerByKey(inNames[0] ?? "")?.displayName ?? ""}`);
      }
    }
  }
  console.log(`DIVERGED ${diverged} / ${checked} scored selections (of ${sels.length} total)`);
  console.log(out.join("\n"));
}
main().then(() => process.exit(0));
