#!/usr/bin/env npx tsx
// TEMP — claim 6 mechanism split: which path drops a marked row out of audit.pending?
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getAllMatches } from "../lib/matches";
import {
  __setPointsCacheForTest, __setSettlementCacheForTest,
  getLiveAuditRows, getSettledRowsForMatch, getCompletedMatchKeys, getMatchStatusFor,
} from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";
import { mergedRows, settlementRows } from "./_vlib";
const FULL = mergedRows(); const SROWS = settlementRows();
const pin = () => { __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS); };

async function main() {
  pin();
  const completed = await getCompletedMatchKeys(getAllMatches());
  let A = 0, Apts = 0, B = 0, Bpts = 0;
  for (const m of getAllMatches()) {
    if (!completed.has(m.key)) continue;
    pin(); const live = await getLiveAuditRows(m);
    pin(); const settled = await getSettledRowsForMatch(m);
    pin(); const a = await auditMatch(m);
    pin(); const st = await getMatchStatusFor(m);
    const pendingPids = new Set(a.pending.map((p) => p.pid));
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const r of live) {
      if (!r.recon || !r.pid || seen.has(r.pid)) continue;
      seen.add(r.pid);
      if (pendingPids.has(r.pid)) continue;
      const s = settled.find((x) => x.pid === r.pid);
      const mech = !s
        ? "B:no-settled-row (second loop hardcodes NO_BASELINE)"
        : s.provenance === "unknown"
          ? "A:provenance=unknown (groupFor returns NO_BASELINE before the marker check)"
          : "?other";
      if (mech.startsWith("A")) { A++; Apts += r.points ?? 0; } else if (mech.startsWith("B")) { B++; Bpts += r.points ?? 0; }
      rows.push(`    ${r.name} pid=${r.pid} pts=${r.points} marker=${r.recon} -> ${mech}`);
    }
    if (rows.length) {
      console.log(`\n${m.key} | sheet: status=${st?.status} recon=${st?.recon} delta=${st?.delta} | audit: pending=${a.pending.length} changed=${a.changed} noBaseline=${a.noBaseline}`);
      console.log(rows.join("\n"));
    }
  }
  console.log(`\n== mechanism A (provenance=unknown short-circuit): ${A} rows, ${Apts} pts`);
  console.log(`== mechanism B (no settled row, second loop):        ${B} rows, ${Bpts} pts`);
}
main().then(() => process.exit(0));
