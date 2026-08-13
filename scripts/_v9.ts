#!/usr/bin/env npx tsx
import * as dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve("/Users/nishant-singodia/wwc-draft", ".env.local") });
import { getMatchByKey } from "../lib/matches";
import { __setPointsCacheForTest, __setSettlementCacheForTest, getMatchPointsForMatch, getLiveAuditRows } from "../lib/points";
import { auditMatch } from "../lib/settlement-audit";
import { mergedRows, settlementRows } from "./_vlib";
const FULL = mergedRows(); const SROWS = settlementRows();
async function main() {
  const m = getMatchByKey("WODI_IREWI_ODI1_Jul10")!;
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const pts = await getMatchPointsForMatch(m);
  console.log("getMatchPointsForMatch['ci:1229018'] =", pts.get("ci:1229018"), " ['espn:1229018'] =", pts.get("espn:1229018"), " ['Jane Maguire'] =", pts.get("Jane Maguire"));
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const live = await getLiveAuditRows(m);
  console.log("live rows for that pid:", live.filter((r) => r.pid.includes("1229018")).map((r) => `${r.name} pid=${r.pid} pts=${r.points}`));
  __setPointsCacheForTest(FULL); __setSettlementCacheForTest(SROWS);
  const a = await auditMatch(m);
  const row = a.players.find((p) => p.pid.includes("1229018"));
  console.log("auditMatch row:", row);
}
main().then(() => process.exit(0));
