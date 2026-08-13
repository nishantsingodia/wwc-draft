#!/usr/bin/env npx tsx
// TEMP — claims 3/4/5/6 against real sheet data.
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });

import { getAllMatches, getMatchByKey } from "../lib/matches";
import {
  __setPointsCacheForTest, __setSettlementCacheForTest,
  getMatchPointsForMatch, isMatchCompleted, getMatchStatusFor, getSettledRowsForMatch,
} from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";
import { mergedRows, settlementRows } from "./_vlib";

const FULL = mergedRows();
const SROWS = settlementRows();

async function main() {
  const mode = process.argv[2];

  if (mode === "cpl") {
    __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
    for (const k of ["CPL_M1_MTANT_MTJAM_Aug07", "CPL_M2_MTSTK_MTTRI_Aug08", "CPL_M3_MTANT_MTSTL_Aug09"]) {
      const m = getMatchByKey(k)!;
      __setPointsCacheForTest(FULL);
      const pts = await getMatchPointsForMatch(m);
      __setPointsCacheForTest(FULL);
      const done = await isMatchCompleted(m);
      console.log(`${k}: sheet points keys=${pts.size} isMatchCompleted=${done}`);
    }
    return;
  }

  if (mode === "claim5") {
    __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
    const m = getAllMatches().find((x) => x.key.includes("IREWI_ODI") || (x.team1 === "OIRE" || x.team2 === "OIRE"));
    console.log("candidate matches:", getAllMatches().filter((x) => /OIRE|OWI/.test(x.team1 + x.team2)).map((x) => `${x.key} ${x.team1}v${x.team2} ${x.date}`).join("\n"));
    if (!m) return;
    return;
  }

  if (mode === "claim456") {
    const keys = process.argv.slice(3);
    for (const k of keys) {
      const m = getMatchByKey(k);
      if (!m) { console.log(k, "NO MATCH IN matches.json"); continue; }
      __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
      const a = await auditMatch(m);
      __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
      const st = await getMatchStatusFor(m);
      __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
      const settled = await getSettledRowsForMatch(m);
      __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
      const pts = await getMatchPointsForMatch(m);
      console.log(`\n### ${k} (${a.label})`);
      console.log(`  sheet: status=${st?.status} recon=${st?.recon} delta=${st?.delta} flag=${JSON.stringify(st?.flag)}`);
      console.log(`  settlement rows=${settled.length} settledSource=${JSON.stringify(settled[0]?.source ?? "")} settledStatus=${JSON.stringify(settled[0]?.status ?? "")}`);
      console.log(`  AUDIT => pending=${a.pending.length} changedRows=${a.changedRows.length} changed=${a.changed} noBaseline=${a.noBaseline} pendingAbsDelta=${a.pendingAbsDelta} totalAbsDelta=${a.totalAbsDelta} orphans=${a.orphans.length}`);
      const nb = a.players.filter((p) => p.group === "NO_BASELINE" && p.marker);
      if (nb.length) console.log(`  NO_BASELINE rows carrying a bot recon marker (dropped from pending): ${nb.length}, pts=${nb.reduce((s, p) => s + (p.now ?? 0), 0)}\n    ` + nb.map((p) => `${p.name} now=${p.now} marker=${p.marker}`).join("\n    "));
      console.log(`  points map size=${pts.size}`);
    }
    return;
  }

  if (mode === "droptab") {
    const drop = process.argv[3];
    const keys = process.argv.slice(4);
    const PARTIAL = mergedRows([drop]);
    for (const k of keys) {
      const m = getMatchByKey(k)!;
      __setPointsCacheForTest(PARTIAL); __setSettlementCacheForTest(SROWS);
      const done = await isMatchCompleted(m);
      __setPointsCacheForTest(PARTIAL); __setSettlementCacheForTest(SROWS);
      const a = await auditMatch(m);
      console.log(`${k}: with "${drop}" dropped -> isMatchCompleted=${done} changed=${a.changed} changedRows=${a.changedRows.length} totalAbsDelta=${a.totalAbsDelta} noBaseline=${a.noBaseline} pending=${a.pending.length}`);
      console.log("   top rows: " + a.changedRows.slice(0, 4).map((p) => `${p.name} ${p.settled}->${p.now} (${p.reason})`).join(", "));
    }
    return;
  }
  console.log("usage: mode");
}
main().then(() => process.exit(0));
