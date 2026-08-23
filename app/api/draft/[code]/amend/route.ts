import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import {
  getDb,
  draftPicks,
  teamSelections,
  contestParticipants,
  lineupAmendments,
  AMENDMENT_TTL_SECONDS,
  type DraftContest,
  type LineupAmendment,
  type TeamSelection,
} from "@/lib/db";
import { and, eq } from "drizzle-orm";
import { getMatchByKey } from "@/lib/matches";
import { getByTeamCode, getPlayerByKey, matchPlayerInXI } from "@/lib/players";
import { getMatchDelay } from "@/lib/match-delay";
import {
  getMatchPointsForMatch,
  getMatchXI,
  isMatchCompleted,
  lookupPlayerPoints,
} from "@/lib/points";
import { getLiveMatchPoints } from "@/lib/espn";
import { getMatchRoster } from "@/lib/match-roster";
import { isKnownUser } from "@/lib/users";
import {
  applyAmendment,
  approversFor,
  currentRanking,
  diffAmendment,
  getContestByCode,
  identityWarning,
  isNoOp,
  currentPoints,
  previewPoints,
  validateAmendment,
  type Replacement,
  type ScoreCtx,
} from "@/lib/amendments";

/**
 * Post-lock lineup amendments for a LIVE or COMPLETED match.
 *
 * GET  — everything the amend screen needs in one call: every player actually playing
 *        this match (seed ∪ ESPN match roster ∪ the sheet's self-healing roster, so a
 *        late squad addition is present even though nobody could draft them), each
 *        squad's current ranking, and any pending amendment with its full diff.
 *
 * POST — `request` (file one), `approve`, `reject`, `cancel`. A request applies the
 *        moment every other stakeholder has approved; if there is no one else, it
 *        applies immediately. Nothing is ever changed by one person alone while
 *        somebody else has a stake in the result.
 */

type PendingView = {
  id: number;
  user: string;
  requestedBy: string;
  reason: string;
  createdAt: number;
  approvals: string[];
  approvers: string[];
  waitingOn: string[];
  /** Points swing measured NOW (not the value frozen at request time). */
  pointsDelta: number | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
  diff: ReturnType<typeof diffAmendment>;
  warnings: string[];
  canApprove: boolean;
  canCancel: boolean;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await params;
  const db = getDb();
  const contest = await getContestByCode(code);
  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const match = getMatchByKey(contest.matchKey);
  if (!match) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const [selections, participants, picks, pendingRows] = await Promise.all([
    db.select().from(teamSelections).where(eq(teamSelections.contestId, contest.id)),
    db
      .select()
      .from(contestParticipants)
      .where(eq(contestParticipants.contestId, contest.id)),
    db.select().from(draftPicks).where(eq(draftPicks.contestId, contest.id)),
    db
      .select()
      .from(lineupAmendments)
      .where(
        and(
          eq(lineupAmendments.contestId, contest.id),
          eq(lineupAmendments.status, "PENDING")
        )
      ),
  ]);

  const ctx = await buildScoreCtx(contest);
  if (!ctx) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const roster = await getMatchRoster(match);

  // Everything already spoken for in this contest — a replacement may never pull in a
  // player somebody else owns.
  const taken = new Set<string>([
    ...picks.map((p) => p.playerKey),
    ...selections.flatMap((s) => JSON.parse(s.selectedPlayers ?? "[]") as string[]),
  ]);
  // Who owns each drafted player, so the roster can show it inline. Keyed by pid where
  // we have one (a stand-in and the real player share neither key nor name) and by key
  // otherwise.
  const ownerByKey = new Map<string, string>();
  const ownerByPid = new Map<string, string>();
  for (const sel of selections) {
    for (const k of JSON.parse(sel.selectedPlayers ?? "[]") as string[]) {
      ownerByKey.set(k, sel.user);
      const pid = getPlayerByKey(k)?.pid;
      if (pid) ownerByPid.set(pid, sel.user);
    }
  }

  const rosterView = {
    espnAvailable: roster.espnAvailable,
    byTeam: roster.byTeam.map((t) => ({
      team: t.team,
      players: t.players.map((p) => ({
        ...p,
        points: lookupPlayerPoints(
          p.pid ?? undefined,
          p.name,
          p.name,
          ctx.pointsMap,
          ctx.pointsSource === "live-espn"
        ),
        draftedBy:
          ownerByKey.get(p.key) ?? (p.pid ? ownerByPid.get(p.pid) : undefined) ?? null,
        // Does this player resolve in the SETTLED sheet? The live preview can't tell you.
        settles: settlesFor(p.key, ctx),
      })),
    })),
  };

  const stakeholders = new Set([
    ...participants.map((p) => p.user),
    ...selections.map((s) => s.user),
  ]);

  const squads = selections.map((sel) => {
    const ranking = currentRanking(sel);
    return {
      user: sel.user,
      ranking: ranking.map((key) => playerView(key, ctx)),
      points: currentPoints(sel, ctx),
      editable: canEdit(username, stakeholders, sel.user),
      // Anyone already in this squad whose points won't settle — surfaced on the owner's
      // own screen, not just to the approver.
      warnings: ranking
        .map((key) => settlementWarning(key, ctx))
        .filter((w): w is string => !!w),
    };
  });

  return NextResponse.json({
    username,
    contest: {
      code: contest.code,
      matchKey: contest.matchKey,
      matchLabel: contest.matchLabel,
      picksPerUser: contest.picksPerUser,
      mode: contest.mode,
    },
    match: { team1: match.team1, team2: match.team2 },
    // Amendments are the POST-lock tool. Before the match starts the team page is the
    // right (and unrestricted) place to re-rank, so don't offer a handshake for it.
    open: ctx.started,
    completed: ctx.completed,
    pointsSource: ctx.pointsSource,
    roster: rosterView,
    squads,
    taken: [...taken],
    pending: pendingRows
      .filter((a) => isLive(a, ctx.now))
      .map((a) => viewPending(a, contest.picksPerUser, selections, participants.map((p) => p.user), username, ctx)),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  let username: string;
  try {
    username = await requireSession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await params;
  const body = await request.json();
  const action = body?.action as string;
  const db = getDb();

  const contest = await getContestByCode(code);
  if (!contest) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = await buildScoreCtx(contest);
  if (!ctx) return NextResponse.json({ error: "Match not found" }, { status: 404 });

  const [selections, participants] = await Promise.all([
    db.select().from(teamSelections).where(eq(teamSelections.contestId, contest.id)),
    db.select().from(contestParticipants).where(eq(contestParticipants.contestId, contest.id)),
  ]);
  const participantUsers = participants.map((p) => p.user);
  const selectionUsers = selections.map((s) => s.user);

  // ── request ────────────────────────────────────────────────────────────────
  if (action === "request") {
    if (!ctx.started) {
      return NextResponse.json(
        { error: "The match hasn't started — edit your team on the team page instead." },
        { status: 400 }
      );
    }

    const targetUser: string =
      typeof body.user === "string" && body.user ? body.user : username;
    if (!isKnownUser(targetUser)) {
      return NextResponse.json({ error: "Unknown user" }, { status: 400 });
    }
    const stakeholders = new Set([...participantUsers, ...selectionUsers]);
    if (!canEdit(username, stakeholders, targetUser)) {
      return NextResponse.json(
        { error: "You're not part of this contest" },
        { status: 403 }
      );
    }

    const sel = selections.find((s) => s.user === targetUser);
    if (!sel) return NextResponse.json({ error: "No team to amend" }, { status: 404 });

    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 5) {
      return NextResponse.json(
        { error: "Give a reason — the other players see it when they approve." },
        { status: 400 }
      );
    }

    const proposed: string[] = Array.isArray(body.ranking) ? body.ranking : [];
    const replacements: Replacement[] = Array.isArray(body.replacements)
      ? body.replacements.map((r: Replacement) => ({ outKey: r.outKey, inKey: r.inKey }))
      : [];

    const current = currentRanking(sel);
    const picks = await db
      .select()
      .from(draftPicks)
      .where(eq(draftPicks.contestId, contest.id));
    const taken = new Set<string>([
      ...picks.map((p) => p.playerKey),
      ...selections.flatMap((s) => JSON.parse(s.selectedPlayers ?? "[]") as string[]),
    ]);
    for (const k of current) taken.delete(k); // own squad isn't a conflict

    const valid = validateAmendment({
      current,
      proposed,
      replacements,
      matchTeams: ctx.inMatchTeams,
      taken,
    });
    if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });

    const diff = diffAmendment(current, proposed, replacements, contest.picksPerUser);
    if (isNoOp(diff)) {
      return NextResponse.json({ error: "Nothing would change" }, { status: 400 });
    }

    const before = currentPoints(sel, ctx);
    const after = previewPoints(sel, proposed, ctx);
    const delta = before !== null && after !== null ? Math.round(after - before) : null;

    const approvers = approversFor(participantUsers, selectionUsers, username);
    const now = ctx.now;

    // Clear a stale/expired pending request of our own first — the partial unique index
    // allows exactly one PENDING row per (contest, user).
    const [existing] = await db
      .select()
      .from(lineupAmendments)
      .where(
        and(
          eq(lineupAmendments.contestId, contest.id),
          eq(lineupAmendments.user, targetUser),
          eq(lineupAmendments.status, "PENDING")
        )
      );
    if (existing) {
      if (isLive(existing, now)) {
        return NextResponse.json(
          { error: "An amendment for this team is already awaiting approval" },
          { status: 409 }
        );
      }
      await db
        .update(lineupAmendments)
        .set({ status: "CANCELLED", resolvedAt: now, resolvedBy: "expired" })
        .where(eq(lineupAmendments.id, existing.id));
    }

    const [row] = await db
      .insert(lineupAmendments)
      .values({
        contestId: contest.id,
        user: targetUser,
        requestedBy: username,
        ranking: JSON.stringify(proposed),
        replacements: JSON.stringify(replacements),
        reason,
        pointsDelta: delta,
        status: "PENDING",
        approvals: JSON.stringify([]),
        createdAt: now,
      })
      .returning();

    // Nobody else has a stake (solo contest / manual entry by the only participant) →
    // there is no one to ask, so it takes effect at once.
    if (approvers.length === 0) {
      await applyAmendment(contest, row, now);
      return NextResponse.json({ ok: true, instant: true, applied: true, delta });
    }

    return NextResponse.json({ ok: true, id: row.id, needsApproval: approvers, delta });
  }

  // ── approve / reject / cancel ──────────────────────────────────────────────
  const id = Number(body?.id);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const [amendment] = await db
    .select()
    .from(lineupAmendments)
    .where(and(eq(lineupAmendments.id, id), eq(lineupAmendments.contestId, contest.id)));
  if (!amendment || amendment.status !== "PENDING") {
    return NextResponse.json({ error: "No pending amendment" }, { status: 409 });
  }
  if (!isLive(amendment, ctx.now)) {
    return NextResponse.json({ error: "That amendment has expired" }, { status: 409 });
  }

  const approvers = approversFor(participantUsers, selectionUsers, amendment.requestedBy);

  if (action === "cancel") {
    if (amendment.requestedBy !== username) {
      return NextResponse.json({ error: "Not your request to cancel" }, { status: 403 });
    }
    await db
      .update(lineupAmendments)
      .set({ status: "CANCELLED", resolvedAt: ctx.now, resolvedBy: username })
      .where(eq(lineupAmendments.id, amendment.id));
    return NextResponse.json({ ok: true });
  }

  if (action === "reject") {
    if (!approvers.includes(username)) {
      return NextResponse.json({ error: "You have no say in this amendment" }, { status: 403 });
    }
    await db
      .update(lineupAmendments)
      .set({ status: "REJECTED", resolvedAt: ctx.now, resolvedBy: username })
      .where(eq(lineupAmendments.id, amendment.id));
    return NextResponse.json({ ok: true });
  }

  if (action === "approve") {
    if (!approvers.includes(username)) {
      return NextResponse.json({ error: "You have no say in this amendment" }, { status: 403 });
    }
    let approvals: string[] = [];
    try {
      const parsed = JSON.parse(amendment.approvals ?? "[]");
      if (Array.isArray(parsed)) approvals = parsed;
    } catch {
      /* corrupt → treat as empty */
    }
    if (!approvals.includes(username)) approvals.push(username);

    if (approvers.every((u) => approvals.includes(u))) {
      // Persist the FINAL approver before applying. `approvals.push` above is in-memory only, and
      // the write below this branch never runs on the last approval — so applyAmendment read the
      // stale row and recorded `approvedBy: []` on every amendment this app has ever applied. The
      // disclosure banner exists to say "the friends agreed this"; without the names it says the
      // opposite of the truth.
      await db
        .update(lineupAmendments)
        .set({ approvals: JSON.stringify(approvals) })
        .where(eq(lineupAmendments.id, amendment.id));
      amendment.approvals = JSON.stringify(approvals);
      // Re-validate at APPLY time. Between request and approval another amendment may
      // have landed on this squad, so the "current" it was built against can be stale —
      // applying a ranking that no longer describes this squad would silently drop or
      // resurrect a player.
      const sel = selections.find((s) => s.user === amendment.user);
      if (!sel) return NextResponse.json({ error: "Team no longer exists" }, { status: 409 });
      const picks = await db
        .select()
        .from(draftPicks)
        .where(eq(draftPicks.contestId, contest.id));
      const taken = new Set<string>([
        ...picks.map((p) => p.playerKey),
        ...selections.flatMap((s) => JSON.parse(s.selectedPlayers ?? "[]") as string[]),
      ]);
      const current = currentRanking(sel);
      for (const k of current) taken.delete(k);
      const recheck = validateAmendment({
        current,
        proposed: JSON.parse(amendment.ranking),
        replacements: JSON.parse(amendment.replacements ?? "[]"),
        matchTeams: ctx.inMatchTeams,
        taken,
      });
      if (!recheck.ok) {
        await db
          .update(lineupAmendments)
          .set({ status: "CANCELLED", resolvedAt: ctx.now, resolvedBy: "stale" })
          .where(eq(lineupAmendments.id, amendment.id));
        return NextResponse.json(
          { error: `The squad changed since this was filed (${recheck.error}) — file it again.` },
          { status: 409 }
        );
      }
      await applyAmendment(contest, amendment, ctx.now);
      return NextResponse.json({ ok: true, applied: true });
    }

    await db
      .update(lineupAmendments)
      .set({ approvals: JSON.stringify(approvals) })
      .where(eq(lineupAmendments.id, amendment.id));
    return NextResponse.json({
      ok: true,
      waitingOn: approvers.filter((u) => !approvals.includes(u)),
    });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Who may FILE an amendment for whose team: any stakeholder in the contest, for anybody's
 * team including their own.
 *
 * That sounds permissive and isn't, because filing is not changing. An amendment for someone
 * else's team lists its owner among the approvers (approversFor excludes only the requester),
 * so it cannot apply until the owner themselves agrees to it. What this buys is the case the
 * feature exists for: you spot that your opponent drafted a stand-in for a late addition and
 * their score is wrong. Making them file it themselves helps nobody — you can see the problem,
 * they may not, and either way they still have to say yes.
 */
function canEdit(
  username: string,
  stakeholders: Set<string>,
  owner: string
): boolean {
  return stakeholders.has(username) && stakeholders.has(owner);
}

function isLive(a: LineupAmendment, now: number): boolean {
  return a.status === "PENDING" && now - a.createdAt < AMENDMENT_TTL_SECONDS;
}

type FullCtx = ScoreCtx & {
  inMatchTeams: readonly [string, string];
  now: number;
  started: boolean;
  completed: boolean;
  pointsSource: "live-espn" | "sheet";
  /** The bot's SHEET map, always — never swapped for the live ESPN one. */
  sheetPoints: Map<string, number>;
  /** teamCode -> the sheet's OWN per-match XI (empty until the bot writes this match). */
  sheetXI: Map<string, Map<string, number>>;
};

/**
 * "Will this player actually settle?" — the question the live preview cannot answer.
 *
 * While a match is live, points come from ESPN, whose map is keyed by NAME as well as by
 * id, so almost anyone resolves and the screen looks healthy. The number that survives is
 * the bot's SHEET, which is pid-authoritative: a player carrying a pid the sheet doesn't
 * emit resolves to nothing and settles at ZERO — silently, and after the fact. That is
 * precisely the failure this whole feature exists to stop, so probe for it up front
 * against the sheet and say so before anyone approves.
 */
type Settles = "ok" | "pending" | "broken";

function settlesFor(key: string, ctx: FullCtx): Settles {
  const p = getPlayerByKey(key);
  if (!p) return "broken";
  // The bot hasn't written this match yet — nothing to check against, and nothing wrong.
  if (ctx.sheetPoints.size === 0) return "pending";
  const pts = lookupPlayerPoints(p.pid, p.displayName, p.name, ctx.sheetPoints, false);
  if (pts !== null) return "ok";
  const inXI = matchPlayerInXI(
    { pid: p.pid, displayName: p.displayName },
    getByTeamCode(ctx.sheetXI, p.teamCode)
  ).inXI;
  // In the sheet's XI but no reachable score = a row exists and the join still failed.
  return inXI ? "broken" : "pending";
}

function settlementWarning(key: string, ctx: FullCtx): string | null {
  const p = getPlayerByKey(key);
  if (!p) return null;
  const st = settlesFor(key, ctx);
  if (st === "ok") return null;
  if (st === "pending") {
    return `${p.displayName} has no settled row in the points sheet yet — normal while the match is live or the bot hasn't run. Re-check once it's scored.`;
  }
  return p.pid
    ? `${p.displayName} does NOT resolve in the settled sheet under ${p.pid}, so he will score 0 once the match completes. Fix in wwc-points-bot: build_registry.py for this tour, then re-run the bot so the sheet emits his Player ID.`
    : `${p.displayName} does NOT resolve in the settled sheet by name. Add him to the registry (wwc-points-bot registry/manual_ci_bridges.json) and re-run the bot, or his points will read 0.`;
}

/**
 * Scoring context for this match — assembled exactly the way the results route does
 * (same lock buffer + rain delay, same announced gate, same live-ESPN-vs-sheet choice),
 * so the preview numbers on this screen are the numbers on the scoreboard.
 */
async function buildScoreCtx(contest: DraftContest): Promise<FullCtx | null> {
  const match = getMatchByKey(contest.matchKey);
  if (!match) return null;

  const [pointsMap, matchDelay, completed] = await Promise.all([
    getMatchPointsForMatch(match),
    getMatchDelay(contest.matchKey),
    isMatchCompleted(match),
  ]);

  const now = Math.floor(Date.now() / 1000);
  // contest.matchDeadline is the DENORMALIZED, frozen-at-creation deadline every other
  // surface gates on (team lock, "started", freeze). Use it — not matches.json — or this
  // screen would disagree with the results page about whether a match has begun.
  const effDeadline = contest.matchDeadline + matchDelay;
  const started = now >= effDeadline;

  const liveScore = started && !completed ? await getLiveMatchPoints(match) : null;
  const useLive = !!liveScore?.anyStats;

  return {
    picksPerUser: contest.picksPerUser,
    inMatchTeams: [match.team1, match.team2] as const,
    pointsMap: useLive ? liveScore!.points : pointsMap,
    now,
    started,
    completed,
    pointsSource: useLive ? "live-espn" : "sheet",
    sheetPoints: pointsMap,
    sheetXI: await getMatchXI(match),
  };
}

function playerView(key: string, ctx: FullCtx) {
  const p = getPlayerByKey(key);
  const name = p?.displayName ?? key;
  return {
    key,
    name,
    role: p?.role ?? "BAT",
    team: p?.teamCode ?? "",
    pid: p?.pid ?? null,
    points: lookupPlayerPoints(
      p?.pid,
      name,
      p?.name,
      ctx.pointsMap,
      ctx.pointsSource === "live-espn"
    ),
    settles: settlesFor(key, ctx),
  };
}

function viewPending(
  a: LineupAmendment,
  ppu: number,
  selections: TeamSelection[],
  participantUsers: string[],
  username: string,
  ctx: FullCtx
): PendingView {
  const sel = selections.find((s) => s.user === a.user);
  const current = sel ? currentRanking(sel) : [];
  const proposed: string[] = JSON.parse(a.ranking);
  const replacements: Replacement[] = JSON.parse(a.replacements ?? "[]");
  const diff = diffAmendment(current, proposed, replacements, ppu);

  let approvals: string[] = [];
  try {
    const parsed = JSON.parse(a.approvals ?? "[]");
    if (Array.isArray(parsed)) approvals = parsed;
  } catch {
    /* corrupt → treat as empty */
  }
  const approvers = approversFor(
    participantUsers,
    selections.map((s) => s.user),
    a.requestedBy
  );

  // Re-measure the delta NOW rather than trusting the value stamped at request time —
  // a live match moves under the request, and the approver deserves the current number.
  const before = sel ? currentPoints(sel, ctx) : null;
  const after = sel ? previewPoints(sel, proposed, ctx) : null;

  return {
    id: a.id,
    user: a.user,
    requestedBy: a.requestedBy,
    reason: a.reason,
    createdAt: a.createdAt,
    approvals,
    approvers,
    waitingOn: approvers.filter((u) => !approvals.includes(u)),
    pointsDelta: before !== null && after !== null ? Math.round(after - before) : a.pointsDelta,
    pointsBefore: before,
    pointsAfter: after,
    diff,
    // Two different warnings, both about the same question — will the number survive?
    // identityWarning is about the KEY (no registry id ⇒ name join); settlementWarning is
    // about the SHEET (the join measurably failing right now).
    warnings: [
      ...replacements.map((r) => settlementWarning(r.inKey, ctx)),
      ...replacements.map((r) => identityWarning(r.inKey)),
    ].filter((w): w is string => !!w),
    canApprove: approvers.includes(username) && !approvals.includes(username),
    canCancel: a.requestedBy === username,
  };
}
