// Post-lock lineup amendments — validation, the human-readable diff, and the points
// preview that makes approving an informed act.
//
// The rules a locked team is protected by are not relaxed here. An amendment NEVER
// changes squad SIZE and never adds a player somebody else drafted; it can only
// (a) re-order the priority ranking you already own — which is what moves C/VC, since
// the ranking IS the armband — and (b) swap a stand-in you drafted for the real player
// they were standing in for. Everything else is out of scope on purpose.
//
// The pure half of this module (validate / diff / applyReplacements) has no DB, no
// fetch and no clock, so scripts/test-amendments.ts exercises it directly.

import { and, eq } from "drizzle-orm";
import {
  getDb,
  draftContests,
  draftPicks,
  teamSelections,
  lineupAmendments,
  type DraftContest,
  type LineupAmendment,
  type TeamSelection,
} from "./db";
import { getPlayerByKey, isOffSeedKey } from "./players";
import { calcSelectionPoints } from "./contest-scoring";
import {
  rankingFromSelection,
  type Change,
  type PlayerRef,
} from "./effective-lineup";

export type Replacement = {
  /** The stand-in currently in the squad. */
  outKey: string;
  /** The real player replacing them (a seed key, or an `x|`/`s|` key off the match roster). */
  inKey: string;
};

export type Amendment = {
  ranking: string[];
  replacements: Replacement[];
  reason: string;
};

// ── validation ────────────────────────────────────────────────────────────────

export type ValidateArgs = {
  /** The squad as stored today (priority order). */
  current: string[];
  proposed: string[];
  replacements: Replacement[];
  /** The two teams in this match — nobody outside them can enter a squad. */
  matchTeams: readonly [string, string];
  /** Every player key already spoken for in this contest (all squads + all picks). */
  taken: Set<string>;
  resolve?: (key: string) => { teamCode: string } | undefined;
};

export function validateAmendment(args: ValidateArgs): { ok: true } | { ok: false; error: string } {
  const { current, proposed, replacements, matchTeams, taken } = args;
  const resolve = args.resolve ?? getPlayerByKey;

  if (!Array.isArray(proposed) || proposed.length === 0) {
    return { ok: false, error: "No ranking supplied" };
  }
  if (new Set(proposed).size !== proposed.length) {
    return { ok: false, error: "The ranking has a duplicate player" };
  }
  if (proposed.length !== current.length) {
    return {
      ok: false,
      error: `An amendment can't change squad size (${current.length} → ${proposed.length})`,
    };
  }

  const currentSet = new Set(current);
  const outKeys = new Set<string>();
  const inKeys = new Set<string>();
  for (const r of replacements) {
    if (!r || typeof r.outKey !== "string" || typeof r.inKey !== "string") {
      return { ok: false, error: "Malformed replacement" };
    }
    if (!currentSet.has(r.outKey)) {
      return { ok: false, error: `${label(r.outKey, resolve)} isn't in this squad` };
    }
    if (outKeys.has(r.outKey)) {
      return { ok: false, error: `${label(r.outKey, resolve)} is replaced twice` };
    }
    if (inKeys.has(r.inKey)) {
      return { ok: false, error: `${label(r.inKey, resolve)} is added twice` };
    }
    if (currentSet.has(r.inKey)) {
      return { ok: false, error: `${label(r.inKey, resolve)} is already in this squad` };
    }
    // `taken` holds every key spoken for in the contest — including this squad's own,
    // so exclude the ones we're removing before testing it.
    if (taken.has(r.inKey)) {
      return { ok: false, error: `${label(r.inKey, resolve)} is already drafted in this contest` };
    }
    outKeys.add(r.outKey);
    inKeys.add(r.inKey);
  }

  // The proposed ranking must be exactly the current squad with the replacements applied
  // — same people, possibly re-ordered. Anything else is an add/drop, which needs a redraft.
  const expected = new Set([...current.filter((k) => !outKeys.has(k)), ...inKeys]);
  for (const k of proposed) {
    if (!expected.has(k)) return { ok: false, error: `${label(k, resolve)} isn't part of this squad` };
  }
  for (const k of expected) {
    if (!proposed.includes(k)) return { ok: false, error: `${label(k, resolve)} is missing from the ranking` };
  }

  for (const k of proposed) {
    const p = resolve(k);
    if (!p) return { ok: false, error: `Unknown player "${k}"` };
    // Only enforced for players being ADDED: an existing squad member whose team code
    // drifted (a re-namespaced franchise code) must not make their own squad unfixable.
    if (inKeys.has(k) && p.teamCode !== matchTeams[0] && p.teamCode !== matchTeams[1]) {
      return { ok: false, error: `${label(k, resolve)} isn't playing in this match` };
    }
  }

  return { ok: true };
}

function label(key: string, resolve: (k: string) => { teamCode: string } | undefined): string {
  const p = resolve(key) as { displayName?: string } | undefined;
  return p?.displayName ?? key;
}

// ── diff ──────────────────────────────────────────────────────────────────────

export type AmendmentDiff = {
  replacements: { out: PlayerRef; in: PlayerRef; identity: "pid" | "name" }[];
  /** Rank changes, 1-based, excluding movement caused purely by a replacement. */
  moves: { key: string; name: string; from: number; to: number }[];
  captain: { from: PlayerRef | null; to: PlayerRef | null } | null;
  vice: { from: PlayerRef | null; to: PlayerRef | null } | null;
  /** Players crossing the XI line (top `ppu` of the ranking) in either direction. */
  intoXI: PlayerRef[];
  outOfXI: PlayerRef[];
};

function refOf(key: string, resolve = getPlayerByKey): PlayerRef {
  const p = resolve(key);
  return p
    ? { key, name: p.displayName, team: p.teamCode, role: p.role }
    : { key, name: key, team: "", role: "BAT" };
}

export function diffAmendment(
  current: string[],
  proposed: string[],
  replacements: Replacement[],
  ppu: number,
  resolve = getPlayerByKey
): AmendmentDiff {
  // Substitute out→in in the CURRENT ranking first, so a straight swap in place reads as
  // a replacement only — not as a replacement plus a phantom "moved from 7 to 7".
  const subst = new Map(replacements.map((r) => [r.outKey, r.inKey]));
  const mapped = current.map((k) => subst.get(k) ?? k);
  const posBefore = new Map(mapped.map((k, i) => [k, i]));

  const moves: AmendmentDiff["moves"] = [];
  proposed.forEach((k, i) => {
    const before = posBefore.get(k);
    if (before !== undefined && before !== i) {
      moves.push({ key: k, name: refOf(k, resolve).name, from: before + 1, to: i + 1 });
    }
  });

  const beforeXI = new Set(mapped.slice(0, ppu));
  const afterXI = new Set(proposed.slice(0, ppu));

  const capBefore = mapped[0] ?? null;
  const capAfter = proposed[0] ?? null;
  const viceBefore = mapped[1] ?? null;
  const viceAfter = proposed[1] ?? null;

  return {
    replacements: replacements.map((r) => {
      const p = resolve(r.inKey);
      return {
        out: refOf(r.outKey, resolve),
        in: refOf(r.inKey, resolve),
        identity: p?.pid ? "pid" : "name",
      };
    }),
    moves,
    captain:
      capBefore !== capAfter
        ? { from: capBefore ? refOf(capBefore, resolve) : null, to: capAfter ? refOf(capAfter, resolve) : null }
        : null,
    vice:
      viceBefore !== viceAfter
        ? { from: viceBefore ? refOf(viceBefore, resolve) : null, to: viceAfter ? refOf(viceAfter, resolve) : null }
        : null,
    intoXI: [...afterXI].filter((k) => !beforeXI.has(k)).map((k) => refOf(k, resolve)),
    outOfXI: [...beforeXI].filter((k) => !afterXI.has(k)).map((k) => refOf(k, resolve)),
  };
}

/** True when the amendment would actually change something. */
export function isNoOp(diff: AmendmentDiff): boolean {
  return (
    diff.replacements.length === 0 &&
    diff.moves.length === 0 &&
    !diff.captain &&
    !diff.vice
  );
}

// ── points ────────────────────────────────────────────────────────────────────

export type ScoreCtx = {
  picksPerUser: number;
  pointsMap: Map<string, number>;
};

/**
 * The lineup an approved amendment fields: the ranking EXACTLY as approved.
 *
 * No substitution engine, deliberately. BACKUP_INTELLIGENCE exists to make a decision
 * nobody was around to make — the team was locked, someone didn't play, the slot had to
 * be filled by rule. An amendment is the opposite situation: a person looked at the real
 * lineup, made a call, wrote down why, and everybody else agreed to it. Re-running the
 * engine over that would let a rule quietly overrule the people, and what gets scored
 * would no longer be what anyone approved. Top `ppu` of the approved order; rank 1
 * captains; rank 2 vices. That is the whole rule.
 */
export function approvedLineup(ranking: string[], ppu: number) {
  return {
    xi: ranking.slice(0, ppu),
    captainKey: ranking[0] ?? null,
    viceCaptainKey: ranking[1] ?? null,
  };
}

/**
 * What a squad scores RIGHT NOW — straight through the one shared scorer, which already
 * prefers whatever lineup is frozen (engine-computed or amendment-approved).
 */
export function currentPoints(sel: TeamSelection, ctx: ScoreCtx): number | null {
  return calcSelectionPoints(sel, ctx.picksPerUser, ctx.pointsMap);
}

/**
 * What a proposed ranking WOULD score once approved. Scores the as-approved lineup, so
 * the delta on the approval card is exactly the delta that lands — same helper the apply
 * path freezes, same `calcSelectionPoints` every other surface totals with.
 */
export function previewPoints(
  sel: TeamSelection,
  ranking: string[],
  ctx: ScoreCtx
): number | null {
  const eff = approvedLineup(ranking, ctx.picksPerUser);
  const asIfApproved: TeamSelection = {
    ...sel,
    selectedPlayers: JSON.stringify(ranking),
    effectiveLineup: JSON.stringify(eff),
    effectiveChanges: "[]",
    // Any non-null value makes calcSelectionPoints read the lineup above rather than
    // re-deriving it; the number itself is never used.
    effectiveComputedAt: 1,
  };
  return calcSelectionPoints(asIfApproved, ctx.picksPerUser, ctx.pointsMap);
}

/** The current stored ranking for a selection (legacy C/VC floated to the head). */
export function currentRanking(sel: TeamSelection): string[] {
  const keys: string[] = JSON.parse(sel.selectedPlayers ?? "[]");
  return rankingFromSelection(keys, sel.captainKey, sel.viceCaptainKey);
}

// ── stakeholders ──────────────────────────────────────────────────────────────

/**
 * Who must approve. Everyone with skin in this contest — a joined participant OR the
 * owner of a team selection (manual-mode contests often have only the entering friend
 * in `contest_participants`, yet both teams are real) — minus the person asking.
 * An empty set means nobody else is affected, and the amendment applies immediately.
 */
export function approversFor(
  participants: string[],
  selectionUsers: string[],
  requester: string
): string[] {
  return [...new Set([...participants, ...selectionUsers])].filter((u) => u !== requester);
}

// ── apply ─────────────────────────────────────────────────────────────────────

/**
 * Disclosure for a frozen amendment — what moved, and the fact that PEOPLE moved it.
 * Same `Change[]` shape the results page and ChangesBanner already render, so an
 * amendment shows up wherever an auto-substitution would have, correctly labelled.
 */
export function changesForAmendment(
  diff: AmendmentDiff,
  amendment: LineupAmendment,
  approvals: string[]
): Change[] {
  const changes: Change[] = [
    {
      type: "amendment",
      reason: amendment.reason,
      by: amendment.requestedBy,
      approvedBy: approvals,
    },
  ];
  for (const r of diff.replacements) changes.push({ type: "sub", out: r.out, in: r.in });
  if (diff.captain?.to) changes.push({ type: "captain", out: diff.captain.from, in: diff.captain.to });
  if (diff.vice?.to) changes.push({ type: "vice", out: diff.vice.from, in: diff.vice.to });
  return changes;
}

/**
 * Commit an approved amendment, atomically.
 *
 * The approved lineup is FROZEN exactly as approved — top `ppu` of the agreed order,
 * rank 1 captains, rank 2 vices — not cleared for the substitution engine to re-derive.
 * That engine's job is to decide for people who couldn't (team locked, someone didn't
 * play); here the people already decided, in writing, and everyone signed off. Letting
 * a rule re-open that would mean the thing being scored is not the thing anyone
 * approved. It also means the result is deterministic and can't drift as feeds land.
 */
export async function applyAmendment(
  contest: DraftContest,
  amendment: LineupAmendment,
  now: number
): Promise<void> {
  const db = getDb();
  const ranking: string[] = JSON.parse(amendment.ranking);
  const replacements: Replacement[] = JSON.parse(amendment.replacements ?? "[]");
  let approvals: string[] = [];
  try {
    const parsed = JSON.parse(amendment.approvals ?? "[]");
    if (Array.isArray(parsed)) approvals = parsed;
  } catch {
    /* corrupt → treat as empty */
  }

  const [existing] = await db
    .select()
    .from(teamSelections)
    .where(
      and(eq(teamSelections.contestId, contest.id), eq(teamSelections.user, amendment.user))
    );
  const before = existing ? currentRanking(existing) : ranking;
  const diff = diffAmendment(before, ranking, replacements, contest.picksPerUser);

  const stmts = [
    db
      .update(teamSelections)
      .set({
        selectedPlayers: JSON.stringify(ranking),
        captainKey: ranking[0] ?? null,
        viceCaptainKey: ranking[1] ?? null,
        effectiveLineup: JSON.stringify(approvedLineup(ranking, contest.picksPerUser)),
        effectiveChanges: JSON.stringify(changesForAmendment(diff, amendment, approvals)),
        effectiveComputedAt: now,
      })
      .where(
        and(
          eq(teamSelections.contestId, contest.id),
          eq(teamSelections.user, amendment.user)
        )
      ),
    // Keep the draft record honest: the stand-in row WAS the real player all along, so
    // rewrite it in place. (The amendment row itself is the audit trail of the change.)
    ...replacements.map((r) => {
      const p = getPlayerByKey(r.inKey);
      return db
        .update(draftPicks)
        .set({
          playerKey: r.inKey,
          playerName: p?.displayName ?? r.inKey,
          playerRole: p?.role ?? "BAT",
          playerTeam: p?.teamCode ?? "",
        })
        .where(
          and(eq(draftPicks.contestId, contest.id), eq(draftPicks.playerKey, r.outKey))
        );
    }),
    db
      .update(lineupAmendments)
      .set({ status: "APPROVED", resolvedAt: now })
      .where(eq(lineupAmendments.id, amendment.id)),
  ];

  await db.batch(stmts as unknown as Parameters<typeof db.batch>[0]);
}

/** Contest lookup shared by the route's handlers. */
export async function getContestByCode(code: string): Promise<DraftContest | undefined> {
  const db = getDb();
  const [contest] = await db
    .select()
    .from(draftContests)
    .where(eq(draftContests.code, code.toUpperCase()));
  return contest;
}

/** Human note for a key that carries no stable identity — points join by name only. */
export function identityWarning(key: string): string | null {
  const p = getPlayerByKey(key);
  if (!p || !isOffSeedKey(key) || p.pid) return null;
  return `${p.displayName} has no entry in the player registry yet, so their points join by NAME. It will score, but add them in wwc-points-bot (registry/manual_ci_bridges.json) to make it identity-safe.`;
}
