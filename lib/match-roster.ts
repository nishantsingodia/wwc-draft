// "Everyone who is playing THIS match" — the single list behind the lineup-amendment
// screen.
//
// Why this exists: three different places know part of the answer and none knows all of
// it. The seeded pool (players-raw.json) is hand-maintained and therefore always one step
// behind a late signing. getSheetRoster() self-heals, but only AFTER the bot has scored a
// player at least once — useless during the match you needed it for. ESPN's match roster is
// the only source that carries a LATE SQUAD ADDITION on the day, and it carries the ESPN
// athlete id, which resolves to the same stable registry pid the points sheet is keyed by.
//
// So: merge all three, dedupe on IDENTITY first (registry pid) and fuzzy name second, and
// hand every entry back with a resolvable draft player key. A player who isn't in the seed
// comes back as an `x|<pid>|…` key when we know their pid (points join exactly like a
// seeded player) or an `s|…` key when we don't (points join by fuzzy name — flagged so the
// UI can say so out loud rather than letting it fail silently later).

import { type Match } from "./matches";
import {
  getFullSquadByTeams,
  getByTeamCode,
  getPlayerPhoto,
  makeExternalKey,
  makeSyntheticKey,
  matchPlayerInXI,
} from "./players";
import { getEspnMatchRoster } from "./espn";
import { getSheetRoster } from "./points";
import { getOfficialLineup } from "./official-lineup";
import { fuzzyMatchName } from "./fuzzy-name-match";

export type RosterSource = "seed" | "espn" | "sheet";

export type MatchRosterEntry = {
  /** Draft player key — resolvable by getPlayerByKey on every surface. */
  key: string;
  /** Stable registry pid, or null when this player has no identity we can key on. */
  pid: string | null;
  name: string;
  role: string;
  team: string;
  /** In the official XI for this match (ESPN roster flag, else the sheet's per-match XI). */
  inXI: boolean;
  /** Scorecard batting position when known (0 = unknown); orders the XI. */
  batOrder: number;
  /** Where we first learned about this player. */
  source: RosterSource;
  /**
   * How points will join for them. "pid" = exact identity match (safe).
   * "name" = fuzzy Full Name only — works, but drifts if a feed respells them, so the
   * screen warns and the real fix is a registry entry in wwc-points-bot.
   */
  identity: "pid" | "name";
  photo: string | null;
  /** True when they're NOT in players-raw.json (added from a live feed). */
  offSeed: boolean;
};

export type MatchRoster = {
  byTeam: { team: string; players: MatchRosterEntry[] }[];
  /** ESPN answered with a roster for this match (false ⇒ seed + sheet only). */
  espnAvailable: boolean;
};

/** Order a team's roster: XI first, then by scorecard batting position, then by name. */
function sortRoster(a: MatchRosterEntry, b: MatchRosterEntry): number {
  if (a.inXI !== b.inXI) return a.inXI ? -1 : 1;
  const ao = a.batOrder > 0 ? a.batOrder : 999;
  const bo = b.batOrder > 0 ? b.batOrder : 999;
  if (ao !== bo) return ao - bo;
  return a.name.localeCompare(b.name);
}

export async function getMatchRoster(match: Match): Promise<MatchRoster> {
  const [espn, sheetRoster, { lastXI }] = await Promise.all([
    getEspnMatchRoster(match),
    getSheetRoster(),
    getOfficialLineup(match),
  ]);

  const byTeam: { team: string; players: MatchRosterEntry[] }[] = [];

  for (const team of [match.team1, match.team2]) {
    const teamXI = getByTeamCode(lastXI, team);
    const entries: MatchRosterEntry[] = [];
    // Dedupe ledgers. `pids` is authoritative; `names` is the last-resort fallback for
    // anyone the registry doesn't know yet (fuzzyMatchName is null-on-ambiguity, so it
    // never gambles a namesake into a merge).
    const pids = new Set<string>();
    const names: string[] = [];

    // `role` is a plain string here (the sheet's Role column is free text, already
    // normalized to WK/BAT/AR/BOWL by getSheetRoster) — this list is for display and
    // picking, not scoring, so it doesn't need the narrowed Player["role"] union.
    const push = (
      p: { pid?: string; displayName: string; role: string; teamCode: string },
      key: string,
      source: RosterSource,
      opts: { inXI?: boolean; photo?: string | null } = {}
    ) => {
      const m = matchPlayerInXI({ pid: p.pid, displayName: p.displayName }, teamXI);
      entries.push({
        key,
        pid: p.pid ?? null,
        name: p.displayName,
        role: p.role,
        team: p.teamCode,
        // A source that explicitly says "starting" (ESPN's roster flag) wins over the
        // sheet lookup, which is empty until the bot has written this match.
        inXI: opts.inXI ?? m.inXI,
        batOrder: m.batOrder,
        source,
        identity: p.pid ? "pid" : "name",
        photo: opts.photo ?? getPlayerPhoto(p.pid) ?? null,
        offSeed: source !== "seed",
      });
      if (p.pid) pids.add(p.pid);
      names.push(p.displayName);
    };

    const isNew = (pid: string | null, name: string): boolean => {
      if (pid && pids.has(pid)) return false;
      return fuzzyMatchName(name, names) === null;
    };

    // 1 — the hand-maintained seed. Real player keys; always listed even when benched.
    for (const p of getFullSquadByTeams(match.team1, match.team2)) {
      if (p.teamCode !== team) continue;
      push(p, p.key, "seed");
    }

    // 2 — ESPN's match roster. The only source that carries a same-day squad addition.
    for (const e of getByTeamCode(espn ?? undefined, team) ?? []) {
      // ESPN's athlete id IS the ESPNcricinfo id — verified 679/679 against the registry
      // mirror (every ci: player's espn_id equals its cricinfo id, none missing). So when
      // the registry hasn't been built for a player yet, `ci:<athleteId>` is still their
      // CORRECT stable pid, not a guess. Minting it means every player ESPN knows about
      // arrives identity-carrying instead of falling back to a name join.
      const pid = e.pid ?? (e.espnId ? `ci:${e.espnId}` : null);
      if (!isNew(pid, e.name)) {
        // Already listed from the seed — but ESPN may be the only thing that knows
        // they're actually starting today, so let its flag upgrade the existing row.
        if (e.starter) {
          const hit =
            (pid ? entries.find((x) => x.pid === pid) : undefined) ??
            entries.find((x) => fuzzyMatchName(e.name, [x.name]) !== null);
          if (hit) {
            hit.inXI = true;
            hit.photo = hit.photo ?? e.photo;
          }
        }
        continue;
      }
      push(
        { pid: pid ?? undefined, displayName: e.name, role: e.role, teamCode: team },
        pid ? makeExternalKey(pid, team, e.role, e.name) : makeSyntheticKey(team, e.role, e.name),
        "espn",
        { inXI: e.starter, photo: e.photo }
      );
    }

    // 3 — the points sheet's self-healing roster (anyone the bot has already scored on
    // this tour). Catches a player ESPN's roster missed, and back-fills once the bot runs.
    for (const [name, { role, pid }] of getByTeamCode(sheetRoster, team) ?? []) {
      if (!isNew(pid || null, name)) continue;
      push(
        { pid: pid || undefined, displayName: name, role, teamCode: team },
        pid ? makeExternalKey(pid, team, role, name) : makeSyntheticKey(team, role, name),
        "sheet"
      );
    }

    byTeam.push({ team, players: entries.sort(sortRoster) });
  }

  return { byTeam, espnAvailable: !!espn };
}
