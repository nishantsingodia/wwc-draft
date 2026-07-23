// BACKUP_INTELLIGENCE — the pure substitution engine.
//
// A user's squad is a single PRIORITY RANKING (index 0 = highest = Captain,
// index 1 = Vice-Captain). Once official lineups are out, the scoring XI is the
// top `picksPerUser` ranked players who are actually PLAYING — dead players drop
// out and lower-ranked playing players slide up. Captain & Vice follow the same
// ranking and only move when the set holder isn't playing.
//
// This module is PURE: no DB, no fetch, no clock. Callers pre-fetch the official
// XI (getLastPlayedXI) + lineup-announced status (getLineupMeta) and pass them in,
// exactly as results/route.ts already pre-fetches the points map. Membership uses
// the shared central matcher isPlayerInOfficialXI (pid-first, then fuzzy name).

import { type Player, isPlayerInOfficialXI, getByTeamCode } from "./players";

export type PlayerRef = { key: string; name: string; team: string; role: string };

export type Change =
  // a not-playing starter left the XI; a playing backup slid up into it
  | { type: "sub"; out: PlayerRef; in: PlayerRef }
  // the armband moved because the set Captain / Vice isn't playing
  | { type: "captain"; out: PlayerRef | null; in: PlayerRef }
  | { type: "vice"; out: PlayerRef | null; in: PlayerRef }
  // a slot/role couldn't be filled (squad ran out of playing players)
  | { type: "warning"; subjectKey: string | null; message: string };

export type EffectiveLineup = {
  xi: string[];
  captainKey: string | null;
  viceCaptainKey: string | null;
  changes: Change[];
};

export type ComputeArgs = {
  ranking: string[]; // full squad in priority order (index 0 = highest = Captain)
  picksPerUser: number; // XI size to field (e.g. 11)
  teamXIByTeam: Map<string, Map<string, number>>; // = getLastPlayedXI()
  resolve: (key: string) => Player | undefined; // = getPlayerByKey
  inMatchTeams: readonly [string, string]; // the two teams in this match
  announced: boolean; // both teams' official XIs are out; false => pass-through
};

function refOf(key: string, resolve: (k: string) => Player | undefined): PlayerRef {
  const p = resolve(key);
  return p
    ? { key, name: p.displayName, team: p.teamCode, role: p.role }
    : { key, name: key, team: "", role: "BAT" };
}

// Build the priority ranking the engine works on. New saves already store
// selected_players with Captain at [0] and Vice at [1] (the team page + team
// route enforce it), so this is a no-op for them. For LEGACY rows saved before
// BACKUP_INTELLIGENCE — selected_players in pick order, armband in the separate
// captain_key / vice_captain_key columns — it floats the stored C/VC to the head
// so the engine treats them as ranks #1 / #2.
export function rankingFromSelection(
  selectedPlayers: string[],
  captainKey: string | null | undefined,
  viceCaptainKey: string | null | undefined
): string[] {
  const head = [captainKey, viceCaptainKey].filter(
    (k): k is string => !!k && selectedPlayers.includes(k)
  );
  if (head.length === 0) return selectedPlayers;
  const rest = selectedPlayers.filter((k) => !head.includes(k));
  return [...head, ...rest];
}

export function computeEffectiveLineup(args: ComputeArgs): EffectiveLineup {
  const { ranking, picksPerUser, teamXIByTeam, resolve, inMatchTeams, announced } =
    args;

  const intendedXi = ranking.slice(0, picksPerUser);

  // Step 0 — guard. Before lineups are out we can't know who's "dead", and
  // getLastPlayedXI() still holds the PREVIOUS match's XI, so substituting now
  // would be actively wrong. Pass through today's behaviour: top-N by rank.
  if (!announced) {
    return {
      xi: intendedXi,
      captainKey: ranking[0] ?? null,
      viceCaptainKey: ranking[1] ?? null,
      changes: [],
    };
  }

  // Step 1 — "playing" = in the official XI. A player on a team that isn't even
  // in this match (stale/cross-tour data) or an unresolvable key counts as NOT
  // playing — they can't feature, so they shouldn't be fielded.
  const playing = (key: string): boolean => {
    const p = resolve(key);
    if (!p) return false;
    if (p.teamCode !== inMatchTeams[0] && p.teamCode !== inMatchTeams[1]) return false;
    return isPlayerInOfficialXI(p, getByTeamCode(teamXIByTeam, p.teamCode));
  };

  // Step 2 — field the top `picksPerUser` PLAYING players, walking by rank. Dead
  // players are skipped; lower-ranked playing players slide up for free.
  const effectiveXi: string[] = [];
  for (const key of ranking) {
    if (effectiveXi.length >= picksPerUser) break;
    if (playing(key)) effectiveXi.push(key);
  }

  const changes: Change[] = [];

  // Step 3 — describe the substitutions vs the intended top-N.
  const intendedSet = new Set(intendedXi);
  const effectiveSet = new Set(effectiveXi);
  const droppedStarters = intendedXi.filter((k) => !effectiveSet.has(k)); // not playing
  const slidIn = effectiveXi.filter((k) => !intendedSet.has(k)); // promoted from below the line
  // Pair them in order purely for readable disclosure ("X out → Y in"); for the
  // common single-sub case this is exactly right.
  const pairCount = Math.min(droppedStarters.length, slidIn.length);
  for (let i = 0; i < pairCount; i++) {
    changes.push({
      type: "sub",
      out: refOf(droppedStarters[i], resolve),
      in: refOf(slidIn[i], resolve),
    });
  }
  // A dropped starter with no replacement left (squad ran out of playing players).
  for (let i = pairCount; i < droppedStarters.length; i++) {
    changes.push({
      type: "warning",
      subjectKey: droppedStarters[i],
      message: `${refOf(droppedStarters[i], resolve).name} isn't playing and no ranked backup is left to fill the slot — it scores 0.`,
    });
  }

  // Step 4 — Captain & Vice = the top two PLAYING players by rank (= the first two
  // of the effective XI). Emit a change ONLY when the SET holder isn't playing, so
  // the armband never moves while both C and VC are fielded. When the Captain is
  // out, the Vice naturally steps up and the next playing pick becomes Vice — the
  // pick-order cascade the feature is built around.
  const setC = ranking[0] ?? null;
  const setVC = ranking[1] ?? null;
  const effC = effectiveXi[0] ?? null;
  const effVC = effectiveXi[1] ?? null;
  if (effC !== setC) {
    if (effC) {
      changes.push({
        type: "captain",
        out: setC ? refOf(setC, resolve) : null,
        in: refOf(effC, resolve),
      });
    } else {
      changes.push({
        type: "warning",
        subjectKey: setC,
        message: `No playing player available to captain — no 2× applied.`,
      });
    }
  }
  if (effVC !== setVC && effVC) {
    changes.push({
      type: "vice",
      out: setVC ? refOf(setVC, resolve) : null,
      in: refOf(effVC, resolve),
    });
  }

  return { xi: effectiveXi, captainKey: effC, viceCaptainKey: effVC, changes };
}
