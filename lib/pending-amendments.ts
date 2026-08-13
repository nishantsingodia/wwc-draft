// Pending lineup amendments, summarised for the lobby card.
//
// The amend screen renders the full diff from the API; the lobby needs the same facts small
// enough to decide on in place. Both derive from the SAME diffAmendment + scorer, so the
// compact summary can never say something the full page contradicts — and when a change is
// too big to state in three lines, `more` says so rather than hiding the remainder.

import { and, eq, inArray } from "drizzle-orm";
import { getDb, lineupAmendments, teamSelections, AMENDMENT_TTL_SECONDS } from "./db";
import { approversFor, currentRanking, diffAmendment, type Replacement } from "./amendments";
import type { PendingSummary } from "@/components/amendment-actions";

const MAX_LINES = 3;

export async function getPendingAmendments(
  contests: { id: number; code: string; picksPerUser: number }[],
  participantsByContest: Map<number, string[]>,
  selectionsByContest: Map<number, { user: string; selectedPlayers: string; captainKey: string | null; viceCaptainKey: string | null }[]>,
  username: string,
  now: number
): Promise<Map<number, PendingSummary[]>> {
  const out = new Map<number, PendingSummary[]>();
  if (contests.length === 0) return out;

  const db = getDb();
  const rows = await db
    .select()
    .from(lineupAmendments)
    .where(
      and(
        inArray(lineupAmendments.contestId, contests.map((c) => c.id)),
        eq(lineupAmendments.status, "PENDING")
      )
    );
  if (rows.length === 0) return out;

  const byId = new Map(contests.map((c) => [c.id, c]));

  for (const a of rows) {
    // Expired requests are ignored everywhere else; don't offer an approval that won't apply.
    if (now - a.createdAt >= AMENDMENT_TTL_SECONDS) continue;
    const contest = byId.get(a.contestId);
    if (!contest) continue;

    const sels = selectionsByContest.get(a.contestId) ?? [];
    const sel = sels.find((s) => s.user === a.user);
    if (!sel) continue;

    const current = currentRanking(sel as never);
    const proposed: string[] = JSON.parse(a.ranking);
    const replacements: Replacement[] = JSON.parse(a.replacements ?? "[]");
    const diff = diffAmendment(current, proposed, replacements, contest.picksPerUser);

    const all: string[] = [
      ...diff.replacements.map((r) => `${r.out.name} → ${r.in.name}`),
      ...(diff.captain?.to ? [`C → ${diff.captain.to.name}`] : []),
      ...(diff.vice?.to ? [`VC → ${diff.vice.to.name}`] : []),
      ...diff.moves.filter((m) => m.to < contest.picksPerUser).map((m) => `${m.name} ${m.from}→${m.to}`),
    ];

    let approvals: string[] = [];
    try {
      const parsed = JSON.parse(a.approvals ?? "[]");
      if (Array.isArray(parsed)) approvals = parsed;
    } catch {
      /* corrupt → treat as empty */
    }
    const approvers = approversFor(
      participantsByContest.get(a.contestId) ?? [],
      sels.map((s) => s.user),
      a.requestedBy
    );

    const summary: PendingSummary = {
      id: a.id,
      code: contest.code,
      user: a.user,
      requestedBy: a.requestedBy,
      reason: a.reason,
      pointsDelta: a.pointsDelta,
      lines: all.slice(0, MAX_LINES),
      more: Math.max(0, all.length - MAX_LINES),
      canApprove: approvers.includes(username) && !approvals.includes(username),
      canCancel: a.requestedBy === username,
      waitingOn: approvers.filter((u) => !approvals.includes(u)),
    };
    const arr = out.get(a.contestId) ?? [];
    arr.push(summary);
    out.set(a.contestId, arr);
  }
  return out;
}

/** Selections for a set of contests, in the shape getPendingAmendments wants. */
export async function getSelectionsForPending(ids: number[]) {
  if (ids.length === 0) return new Map<number, { user: string; selectedPlayers: string; captainKey: string | null; viceCaptainKey: string | null }[]>();
  const db = getDb();
  const rows = await db.select().from(teamSelections).where(inArray(teamSelections.contestId, ids));
  const map = new Map<number, { user: string; selectedPlayers: string; captainKey: string | null; viceCaptainKey: string | null }[]>();
  for (const r of rows) {
    const arr = map.get(r.contestId) ?? [];
    arr.push({ user: r.user, selectedPlayers: r.selectedPlayers, captainKey: r.captainKey, viceCaptainKey: r.viceCaptainKey });
    map.set(r.contestId, arr);
  }
  return map;
}
