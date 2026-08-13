#!/usr/bin/env npx tsx
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getMatchByKey } from "../lib/matches";
import { __setPointsCacheForTest, __setSettlementCacheForTest, getSettledRowsForMatch, getLiveAuditRows } from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";
import { mergedRows, settlementRows } from "./_vlib";
const FULL = mergedRows(); const SROWS = settlementRows();
async function main() {
  const k = process.argv[2];
  const m = getMatchByKey(k)!;
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const s = await getSettledRowsForMatch(m);
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const l = await getLiveAuditRows(m);
  console.log("settled rows", s.length, "live rows", l.length);
  console.log("settled sample:", s.slice(0, 3));
  const spids = new Set(s.map((x) => x.pid));
  console.log("\nLIVE rows with a recon marker:");
  for (const r of l) if (r.recon) console.log(`  ${r.name} pid=${r.pid} pts=${r.points} marker=${r.recon} inSettled=${spids.has(r.pid)}`);
  console.log("\nSettled pids sample:", [...spids].slice(0, 8).join(", "));
  console.log("Settled names:", s.map((x) => `${x.name}[${x.pid}]`).join(", "));
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const a = await auditMatch(m);
  console.log("\nPENDING:", a.pending.map((p) => `${p.name} ${p.settled}->${p.now} ${p.marker}`).join(" | "));
  console.log("CHANGED:", a.changedRows.map((p) => `${p.name} ${p.settled}->${p.now} ${p.reason}`).join(" | "));
}
main().then(() => process.exit(0));
