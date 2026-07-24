// Per-tour behaviour flags.
//
// There's no tour-registry object in this app — a "tour" is emergent from its
// team codes (franchise tours namespace theirs: LPL* / ...). So we identify a
// tour by its team-code prefix and hang tour-invariant rules off that. Keep this
// per-TOUR (not per-match): a rule like the Impact Player one is a property of
// the competition, and encoding it per match invites one LPL match silently
// missing the flag and behaving differently from the rest.

export type TourRules = {
  // BACKUP_INTELLIGENCE auto-substitution. Default ON. Turn OFF for tours with an
  // Impact Player rule (LPL): the ESPN lineup fetch only gives the walk-out XI, so
  // a drafted player who's the named impact sub reads as "not playing" and would be
  // swapped out for a backup — but they may still come on and score in the 2nd
  // innings, and the owner deliberately kept them betting on exactly that. So for
  // these tours we never sub: the drafted top-N is fielded as-is.
  backupIntelligence: boolean;
};

const DEFAULT_RULES: TourRules = { backupIntelligence: true };

// Team-code prefixes for tours whose competition uses the Impact Player rule.
// Add a prefix here when a new Impact Player tour is set up (IPL, SA20, ...).
const IMPACT_PLAYER_PREFIXES = ["LPL"];

export function tourRulesFor(match: { team1: string; team2: string }): TourRules {
  const impactPlayer = IMPACT_PLAYER_PREFIXES.some(
    (p) => match.team1.startsWith(p) || match.team2.startsWith(p)
  );
  return { ...DEFAULT_RULES, backupIntelligence: !impactPlayer };
}
