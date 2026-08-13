#!/usr/bin/env npx tsx
// TEMP — global scan: for every match with sheet rows, compare what the sheet says
// (Match Status / Recon State / Recon Flag / Settled Source) against what /audit renders.
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getAllMatches } from "../lib/matches";
import {
  __setPointsCacheForTest, __setSettlementCacheForTest,
  getMatchStatusFor, getLiveAuditRows, getSettledRowsForMatch, getCompletedMatchKeys,
} from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";
import { mergedRows, settlementRows } from "./_vlib";
const FULL = mergedRows(); const SROWS = settlementRows();
const pin = () => { __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS); };

async function main() {
  pin();
  const all = getAllMatches();
  const completed = await getCompletedMatchKeys(all);
  let totDropped = 0, totDroppedPts = 0, matchesAffected = 0;
  const singleFeed: string[] = [];
  const reconOpen: string[] = [];
  for (const m of all) {
    if (!completed.has(m.key)) continue;
    pin(); const st = await getMatchStatusFor(m);
    pin(); const live = await getLiveAuditRows(m);
    pin(); const settled = await getSettledRowsForMatch(m);
    pin(); const a = await auditMatch(m);
    const marked = live.filter((r) => r.recon && r.pid);
    const pendingPids = new Set(a.pending.map((p) => p.pid));
    const dropped = marked.filter((r) => !pendingPids.has(r.pid));
    const droppedPts = dropped.reduce((s, r) => s + (r.points ?? 0), 0);
    if (dropped.length) {
      totDropped += dropped.length; totDroppedPts += droppedPts; matchesAffected++;
      console.log(`DROPPED  ${m.key} | sheetStatus=${st?.status} recon=${st?.recon} delta=${st?.delta} | audit: pending=${a.pending.length} changed=${a.changed} noBaseline=${a.noBaseline} | dropped ${dropped.length} marked rows worth ${droppedPts} pts: ` + dropped.map((r) => `${r.name}=${r.points}`).join(", "));
    }
    const src = settled[0]?.source ?? "";
    if ((st?.flag ?? "").includes("single feed") || src.includes("cricapi empty")) {
      singleFeed.push(`${m.key} | flag=${JSON.stringify(st?.flag)} | settledSource=${JSON.stringify(src)} | audit: pending=${a.pending.length} changedRows=${a.changedRows.length} changed=${a.changed} noBaseline=${a.noBaseline}`);
    }
    if (st?.recon === "L1_OPEN" || st?.recon === "L2_PENDING") {
      reconOpen.push(`${m.key} | reconState=${st.recon} sheetDelta=${st.delta} | audit: pending=${a.pending.length} changed=${a.changed} totalAbsDelta=${a.totalAbsDelta}`);
    }
  }
  console.log(`\n== TOTAL: ${totDropped} marked rows worth ${totDroppedPts} pts dropped from audit.pending across ${matchesAffected} matches ==`);
  console.log(`\n== SINGLE-FEED / cricapi-empty matches (${singleFeed.length}) ==\n` + singleFeed.join("\n"));
  console.log(`\n== Matches with an OPEN recon state on the sheet (${reconOpen.length}) ==\n` + reconOpen.join("\n"));
}
main().then(() => process.exit(0));
