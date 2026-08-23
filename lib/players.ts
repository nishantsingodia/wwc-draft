import rawPlayers from "@/data/players-raw.json";
import { fuzzyMatchName, normName } from "./fuzzy-name-match";
import { resolveEspnPid } from "./registry";
import teamCodes from "@/data/team-codes.json";
import playerPhotos from "@/data/player-photos.json";

export type Player = {
  id: number;
  key: string; // cricsheet_id as string → used as unique key
  pid?: string; // stable identity from the global registry (points sheet "Player ID")
  name: string;
  displayName: string;
  country: string;
  role: "WK" | "BAT" | "AR" | "BOWL";
  teamCode: string;
  squadNumber: number;
  efppm: number; // expected fantasy points per match (tour projection)
};

// A points-sheet key is a registry pid ("ci:N" — the ESPNcricinfo id and the primary
// scheme since the 25 Jul 2026 migration — or a legacy cricsheet hash / "espn:N" /
// "slug:..."), not a player name. Used to keep fuzzy NAME matching from ever seeing a
// pid key. `ci:` MUST be listed: without it every ci: key leaked into the fuzzy NAME
// candidate pool, which is the pool the matcher is allowed to guess from.
export function isPidKey(k: string): boolean {
  // `uncapped:` and `cs:` were MISSING. Both are pid namespaces the bot emits, so leaving them out
  // meant those keys were treated as NAMES: they leaked into the fuzzy candidate pool (where a
  // slug like "uncapped:glenn-phillips" can surname-match a real player) and they did not count
  // toward matchPlayerInXI's feedHasAnyPid test, so a feed that HAD pid'd everyone could still be
  // read as "pid'd nobody" and fall back to names. Both failure modes point the same way: an
  // identity key being mistaken for a person's name, which is the one thing this app must never do.
  return /^(ci:|espn:|slug:|uncapped:|cs:)/.test(k) || /^[0-9a-f]{8}$/.test(k);
}

// Can a LIVE FEED ever report this pid? Only the cricinfo-anchored schemes. resolveEspnPid
// (lib/registry.ts) turns an ESPN athlete into `ci:<athleteId>` — minting it from the id when
// the registry mirror doesn't know the player — and lib/espn.ts additionally keys the XI map by
// `espn:<athleteId>`. Everything else (`uncapped:`, `cs:`, `slug:`, a legacy cricsheet hash) is a
// placeholder WE invented for a player with no cricinfo id, so no feed can ever emit it.
//
// This is the difference between "the feed says he didn't play" and "we never gave him an identity
// the feed could confirm". Only the first is evidence. See matchPlayerInXI, which is what turned
// the second into a verdict and cost four CPL players their XI slots.
export function isFeedComparablePid(pid: string): boolean {
  return /^(ci:|espn:)/.test(pid);
}

// One player as seen in the points sheet's self-healing roster (getSheetRoster).
export type SheetPlayer = { role: string; pid: string };

// Team codes now live in data/team-codes.json (machine-writable, so the tour-sync
// job can append new tours without editing this file). Values must stay exact —
// TEAM_NAMES feeds points matching (sheet team tokens) and the ESPN lineup team match.
const _codes = teamCodes as Record<string, { flag: string; name: string }>;
const TEAM_FLAGS: Record<string, string> = Object.fromEntries(
  Object.entries(_codes).map(([code, v]) => [code, v.flag])
);
export const TEAM_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(_codes).map(([code, v]) => [code, v.name])
);

// Sheet team tokens that don't equal our code or its full name. The draft namespaces
// some franchise codes per-tour to avoid 2-letter collisions (LPLJK, LPLGG…), but the
// points bot emits the bare franchise short code (JK, GG…) in the LPL tab's Team column
// and match labels. Map draft code -> the bare token(s) the sheet uses so tokenMatchesCode
// resolves them. (The Hundred needs no entry — its squad file already uses MTMILO/WTMILO
// on both sides.) Add here whenever a tour's sheet token differs from the draft code.
export const TEAM_CODE_ALIASES: Record<string, string[]> = {
  LPLJK: ["JK"],
  LPLGG: ["GG"],
  LPLKR: ["KR"],
  LPLDS: ["DS"],
  LPLCK: ["CK"],
};

// Look up a SHEET-derived map (getLastPlayedXI / getMatchXI / getLineupMeta /
// getSheetRoster) by the draft's (possibly-namespaced) team code. Those maps are keyed
// by the bot's Team-column value, which is the BARE franchise code for tours that
// namespace their draft codes (LPL: sheet "JK" ↔ draft "LPLJK"). A plain Map.get on the
// namespaced code therefore MISSES for such tours, so the draft board silently falls back
// to the hand-seeded squad_number instead of the sheet's real Bat Order (and In-XI flags /
// "Lineups Out" / auto-subs go stale too). Resolve via TEAM_CODE_ALIASES: direct hit wins,
// aliases are the fallback — so every other tour (draft code == sheet code) is unaffected.
export function getByTeamCode<T>(
  map: Map<string, T> | undefined,
  code: string
): T | undefined {
  if (!map) return undefined;
  const direct = map.get(code);
  if (direct !== undefined) return direct;
  for (const alias of TEAM_CODE_ALIASES[code] ?? []) {
    const hit = map.get(alias);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// Names in players-raw.json are now canonical announced names.
// DISPLAY_NAME_MAP is kept only for any legacy stale entries in the DB that
// haven't been renamed yet; new data goes through fuzzyLookupPoints in points.ts.
const DISPLAY_NAME_MAP: Record<string, string> = {
  // NZ (kept for backward compat with any old draft data)
  "SFM Devine": "Sophie Devine",
  "AC Kerr": "Amelia Kerr",
  "BM Halliday": "Brooke Halliday",
  "ML Green": "Maddy Green",
  "JM Kerr": "Jess Kerr",
  "IG Gaze": "Isabella Gaze",
  "GR Plimmer": "Georgia Plimmer",
  "FLC Jonas": "Fran Jonas",
  "HNK Jensen": "Hannah Jensen",
  "RH Mair": "Rosemary Mair",
  "BI Illing": "Bella Illing",
  "NH Patel": "Natalie Patel",
  "IS Sharp": "Izzy Sharp",
  "SB Bates": "Suzie Bates",
  "LM Tahuhu": "Lea Tahuhu",
  // IND
  "HM Kaur": "Harmanpreet Kaur",
  "S Mandhana": "Smriti Mandhana",
  "DA Hazell": "Dani Hazell",
  "R Ghosh": "Richa Ghosh",
  "JI Rodrigues": "Jemimah Rodrigues",
  "D Hemalatha": "Dayalan Hemalatha",
  "S Verma": "Shafali Verma",
  "A Reddy": "Amanjot Kaur",
  "P Vastrakar": "Pooja Vastrakar",
  "A Sharma": "Arundhati Reddy",
  "R Yadav": "Richa Yadav",
  // ENG
  "K Brunt": "Kate Cross",
  "HC Knight": "Heather Knight",
  "NR Sciver-Brunt": "Nat Sciver-Brunt",
  "D Wyatt-Hodge": "Danni Wyatt-Hodge",
  "T Beaumont": "Tammy Beaumont",
  "AE Jones": "Amy Jones",
  "SI Ecclestone": "Sophie Ecclestone",
  "KH Brunt": "Katherine Brunt",
  "LA Winfield-Hill": "Lauren Winfield-Hill",
  "L Marsh": "Laura Marsh",
  // AUS
  "BL Mooney": "Beth Mooney",
  "EA Perry": "Ellyse Perry",
  "A Gardner": "Ashleigh Gardner",
  "ML Schutt": "Megan Schutt",
  "G Wareham": "Georgia Wareham",
  "AJ Healy": "Alyssa Healy",
  "MM Lanning": "Meg Lanning",
  "E Villani": "Elyse Villani",
  "RA Haynes": "Rachel Haynes",
  // SL
  "CA Athapaththu": "Chamari Athapaththu",
  "N de Silva": "Nilakshi de Silva",
  "IM Dulani": "Inoshi Dulani",
  "HASD Siriwardene": "Hasini Perera",
  "VH Rajapaksha": "Vishmi Rajapaksha",
  "H Karunaratne": "Harshitha Madavi",
  "K Dilhari": "Kavisha Dilhari",
  // IRE
  "A Hunter": "Amy Hunter",
  "GH Lewis": "Gaby Lewis",
  "O Prendergast": "Orla Prendergast",
  "L Paul": "Leah Paul",
  "R Stokell": "Rebecca Stokell",
  "L Delany": "Laura Delany",
  "AN Kelly": "Arlene Kelly",
  "C Murray": "Cara Murray",
  "G Dempsey": "Georgina Dempsey",
  "A Canning": "Amy Canning",
  "AK Maguire": "Amy Maguire",
  "L Little": "Lorraine Little",
  "A Dalzell": "Aoife Dalzell",
  "CE Coulter Reilly": "Clara Coulter Reilly",
  "LA McBride": "Louise McBride",
  "A Tector": "Amy Tector",
  // SCO
  "SJ Bryce": "Sarah Bryce",
  "K Fraser": "Katherine Fraser",
  "DEM Carter": "Darcey Carter",
  "KE Bryce": "Kathryn Bryce",
  "A Lister": "Abbi Lister",
  "M McColl": "Megan McColl",
  "PA Chatterji": "Priyanaz Chatterji",
  "AH Maqsood": "Abtaha Maqsood",
  "C Abel": "Caitlin Abel",
  "R Slater": "Rachel Slater",
  "O Bell": "Olivia Bell",
  "G Fontenla": "Georgia Fontenla",
  "MG Maceira": "Megan Maceira",
  "PN Sproul": "Phoebe Sproul",
  // WI
  "HK Matthews": "Hayley Matthews",
  "DJS Dottin": "Deandra Dottin",
  "Q Joseph": "Qiana Joseph",
  "SR Taylor": "Stafanie Taylor",
  "JKC Claxton": "Jannillea Claxton",
  "CA Henry": "Chinelle Henry",
  "SA Campbelle": "Shemaine Campbelle",
  "J Glasgow": "Jannillea Glasgow",
  "AA Alleyne": "Aaliyah Alleyne",
  "ASS Fletcher": "Afy Fletcher",
  "K Ramharack": "Karishma Ramharack",
  "Z James": "Zaida James",
  "S Hector": "Sheneta Hector",
  "M Mangru": "Mandy Mangru",
  "A Munisar": "Ashmini Munisar",
  // NED — multi-part surnames need explicit mapping; others handled by toDisplayName fallback
  "SL Kalis": "Sterre Kalis",
  "B de Leede": "Babette de Leede",
  "F Overdijk": "Frederique Overdijk",
  "S Khurana": "Shivani Khurana",
  "C de Lange": "Charlotte de Lange",
  "MIW van den Raad": "Melanie van den Raad",
  "I van der Woning": "Iris van der Woning",
  // BAN — only initials-format names need a mapping; full-name entries handled by fallback
  "S Mostary": "Sobhana Mostary",
};

// Players now store canonical names; this is identity for new data.
// The legacy map handles any old stale cricsheet-format names still in the DB.
function toDisplayName(name: string): string {
  return DISPLAY_NAME_MAP[name] ?? name;
}

export function getFlag(teamCode: string): string {
  return TEAM_FLAGS[teamCode] ?? "🏏";
}

// Real player headshot (ESPN / Wikimedia Commons) by stable pid — harvested offline into
// data/player-photos.json (scripts/harvest-photos.ts). Returns null when we found no photo
// anywhere, so the UI falls back to the team flag. A static pid→URL lookup, so it works for
// ANY match (live or completed) and any surface — not just the live ESPN path.
const PLAYER_PHOTOS = playerPhotos as Record<string, string>;
export function getPlayerPhoto(pid?: string | null): string | null {
  return (pid && PLAYER_PHOTOS[pid]) || null;
}

// Full team name for display (falls back to the code). Matching/DB keys still use the
// raw code — this is display-only.
export function getTeamName(teamCode: string): string {
  return TEAM_NAMES[teamCode] ?? teamCode;
}

// Display-only: rewrite a match label's team CODE tokens to full names
// ("Match 19: WTWLF v WTSBR" → "Match 19: Welsh Fire v Southern Brave"). The stored
// label and team codes are untouched (points matching, ESPN team match, and DB keys all
// rely on them) — this only changes how the title reads. Works identically on a
// matches.json label and the DB-frozen contest.matchLabel, and is idempotent (a full name
// contains no all-caps code token, so re-running it is a no-op). Unknown tokens (e.g.
// "TBD") are left as-is.
export function prettifyMatchLabel(label: string): string {
  return label.replace(/[A-Z][A-Z0-9]{1,7}/g, (tok) => TEAM_NAMES[tok] ?? tok);
}

// All 180 players
const ALL_PLAYERS: Player[] = (rawPlayers as typeof rawPlayers).map((p) => ({
  id: p.id,
  key: String(p.id),
  pid: (p as { pid?: string }).pid,
  name: p.name,
  displayName: toDisplayName(p.name),
  country: p.country,
  role: p.role as Player["role"],
  teamCode: p.team_code,
  squadNumber: p.squad_number,
  efppm: p.efppm ?? 20,
}));

export function getAllPlayers(): Player[] {
  return ALL_PLAYERS;
}

export type PlayerPool = Player & { isLikelyXI: boolean };

// ── Self-healing roster (synthetic players) ───────────────────────────────────
// Players who appear in the live feed but aren't in players-raw.json are added to
// the pool on the fly with a self-describing key, so they're draftable and resolve
// everywhere (pick/team/results) without any hand-editing. Two formats:
//   "s|TEAM|ROLE|Name"      — NAME-only. Points join by fuzzy name (the legacy
//                             self-heal path, fed by the sheet roster).
//   "x|PID|TEAM|ROLE|Name"  — IDENTITY-carrying. Used when we resolved the player
//                             to a stable REGISTRY pid (ci:<cricinfoId>) — e.g. a
//                             late squad addition picked off the live ESPN roster
//                             via the lineup-amendment flow. Points then join on
//                             the pid exactly like a seeded player.
// The key is self-describing (no DB row, no players-raw.json edit) so it resolves
// on every surface through getPlayerByKey alone.
const SYNTH_PREFIX = "s|";
const EXT_PREFIX = "x|";

export function makeSyntheticKey(team: string, role: string, name: string): string {
  return `${SYNTH_PREFIX}${team}|${role}|${name}`;
}

// Key for a player we know by stable identity but who isn't in players-raw.json.
// Pass a pid in the scheme the points sheet actually uses — `ci:<cricinfoId>`. ESPN's
// athlete id IS the cricinfo id, so `ci:<espnAthleteId>` is valid even for a player the
// registry hasn't been built for yet. NEVER pass a bare `espn:<id>` (the wrong prefix):
// lookupPlayerPoints treats any pid as authoritative and refuses to fall back to fuzzy
// name, so a key the sheet doesn't use would score a hard 0 on the completed path.
export function makeExternalKey(
  pid: string,
  team: string,
  role: string,
  name: string
): string {
  return `${EXT_PREFIX}${pid}|${team}|${role}|${name}`;
}

// True for any key that isn't a seeded players-raw.json id — i.e. a player carried
// entirely by their key. Used by the UI to badge "added from the live roster".
export function isOffSeedKey(key: string): boolean {
  return key.startsWith(SYNTH_PREFIX) || key.startsWith(EXT_PREFIX);
}

function syntheticPlayer(
  team: string,
  role: string,
  name: string,
  squadNumber = 99,
  pid?: string
): Player {
  const r = (["WK", "BAT", "AR", "BOWL"].includes(role) ? role : "BAT") as Player["role"];
  return {
    id: 0,
    key: pid ? makeExternalKey(pid, team, r, name) : makeSyntheticKey(team, r, name),
    pid,
    name,
    displayName: name,
    country: "",
    role: r,
    teamCode: team,
    squadNumber,
    efppm: 20,
  };
}

// Is this player in the given team's official XI? Identity-first: match on the
// stable pid (the sheet's "Player ID"), only then fall back to fuzzy NAME for
// players/rows without a pid — fuzzy never sees a pid key, so a hash can't be
// mistaken for a name. `teamXI` is one team's slice of getLastPlayedXI()
// (name|pid -> batOrder); its KEYS are the XI membership, its VALUES the live
// batting order. This is the single source of truth for "is this player playing",
// shared by the draft board (getPlayersByTeams) and the substitution engine
// (lib/effective-lineup.ts).
export function matchPlayerInXI(
  player: Pick<Player, "pid" | "displayName">,
  teamXI: Map<string, number> | undefined
): { inXI: boolean; batOrder: number } {
  if (!teamXI || teamXI.size === 0) return { inXI: false, batOrder: 0 };
  // pid is AUTHORITATIVE. The sheet keys the XI by the same registry pid, so a pid'd
  // player who isn't present under their pid simply didn't feature — do NOT fuzzy-fall
  // back to name for them. Otherwise a benched namesake steals an XI slot by shared
  // surname (LPL: "Nuwanidu Fernando" grabbing "Avishka Fernando", "Kusal Mendis"
  // grabbing another Mendis). Mirrors lookupPlayerPoints' pid rule. A genuine pid
  // mismatch is a registry drift to fix loud in wwc-points-bot, not to mask here.
  if (player.pid) {
    if (teamXI.has(player.pid)) return { inXI: true, batOrder: teamXI.get(player.pid) ?? 0 };
    // ...BUT ONLY WHEN THE FEED ACTUALLY CARRIES PIDS. "Absent under your pid" is evidence you
    // didn't play only if the feed pid'd ANYONE. When it pid'd nobody for this team, the absence
    // is our failure to resolve, not the player's failure to appear — and treating it as the
    // latter is what silently shrank a CPL contest's XI from 11 to 5, scoring 286 v 645 where a
    // full XI was ~604 v 791. The XI shrank rather than refilled because BACKUP_INTELLIGENCE
    // substituted the unresolvable players out and their backups were unresolvable for the same
    // reason, and that decision is FROZEN into effective_lineup, so it drives the score.
    //
    // This is permanent, not a patch for one stale mirror. A DEBUTANT is un-pid'd on the feed by
    // definition — his cricinfo id only exists once ESPN publishes him — so under the old rule
    // every debut was a potential XI dropout, in perpetuity.
    //
    // The namesake guard is fully preserved where it means something: if the feed pid'd anyone on
    // this team, a pid'd player missing from it really is out, and no name can rescue him. That is
    // what stops a benched namesake stealing a slot (LPL's two Fernandos, two Mendises).
    //
    // ...AND ONLY WHEN OUR OWN PID IS ONE A FEED CAN EVEN CARRY. An ESPN-derived XI map is keyed
    // by `ci:<athleteId>` / `espn:<athleteId>` (lib/espn.ts, via resolveEspnPid, which MINTS
    // `ci:<id>` from the athlete id) plus raw names. A `uncapped:` / `cs:` / `slug:` pid is a
    // PLACEHOLDER we invented for a player with no cricinfo anchor, so it can never appear as a
    // key in that map — by construction, not by accident. Reading its absence as "he didn't play"
    // is therefore a category error: it is our own placeholder failing to be a cricinfo id, not
    // evidence about the player.
    //
    // MEASURED, CPL 2026 (23 Aug): 4 seeded players sat on placeholder pids while ESPN carried
    // their real ids — Joshua James uncapped: vs ci:1209191, Usman Khan vs ci:1123428, Mikyle
    // Louis vs ci:1078695, Amari Goodridge vs ci:1342545. Each played, each was judged not-in-XI,
    // so BACKUP_INTELLIGENCE refused to promote them and they scored nothing. 14 more CPL players
    // are still on placeholder pids, and every tour the points bot does not score (no
    // cricapi_series ⇒ no registry build ⇒ placeholders never anchored) generates more.
    //
    // The namesake guard stays exactly where it was designed to bite: LPL's two Fernandos and two
    // Mendises are both `ci:`, so for them a pid miss is still final and no name can rescue them.
    if (isFeedComparablePid(player.pid)) {
      const feedHasAnyPid = [...teamXI.keys()].some(isPidKey);
      if (feedHasAnyPid) return { inXI: false, batOrder: 0 };
    } else {
      // Placeholder pid: fall back to the name, but ONLY on an EXACT normalized match — never
      // the full fuzzy ladder. fuzzyMatchName's last rule matches on SURNAME ALONE, with no
      // initial, so in this very tour "Jeremiah Louis" (uncapped) would have stolen the slot of
      // his MTSTK squadmate "Mikyle Louis" (ci:) whenever Mikyle played and he didn't. ESPN keys
      // the map by both displayName and fullName, so exact is enough for the real case while a
      // same-surname squadmate can never win it.
      const want = normName(player.displayName);
      for (const k of teamXI.keys()) {
        if (!isPidKey(k) && normName(k) === want) {
          return { inXI: true, batOrder: teamXI.get(k) ?? 0 };
        }
      }
      return { inXI: false, batOrder: 0 };
    }
  }
  // Only un-pid'd players (legacy / registry-unknown) fall back to fuzzy NAME. Fuzzy
  // never sees a pid key, so a hash can't be mistaken for a name.
  const matched = fuzzyMatchName(
    player.displayName,
    [...teamXI.keys()].filter((k) => !isPidKey(k))
  );
  return matched !== null
    ? { inXI: true, batOrder: teamXI.get(matched) ?? 0 }
    : { inXI: false, batOrder: 0 };
}

export function isPlayerInOfficialXI(
  player: Pick<Player, "pid" | "displayName">,
  teamXI: Map<string, number> | undefined
): boolean {
  return matchPlayerInXI(player, teamXI).inXI;
}

// Order players for the draft board within each team:
//   1. XI members before non-XI
//   2. within the XI, by live batting order (from the sheet) when available,
//      else by hand-set squad_number
//   3. ties broken by squad_number
//
// `lastXI` (teamCode -> name -> batOrder) comes from getLastPlayedXI:
//   - present  => isLikelyXI is the actual last-played XI; batOrder>0 orders it
//     by real scorecard position once the bot emits "Bat Order"
//   - absent   => fall back to squad_number (1-11 = likely XI)
export function getPlayersByTeams(
  team1: string,
  team2: string,
  lastXI?: Map<string, Map<string, number>>,
  sheetRoster?: Map<string, Map<string, SheetPlayer>>
): PlayerPool[] {
  const teams = [team1, team2];
  const pool: Player[] = ALL_PLAYERS.filter((p) => teams.includes(p.teamCode));

  // Self-heal: merge in any live-feed player the bot has scored for these teams who isn't
  // already in the seed — so a mid-tournament addition (e.g. an injury replacement) becomes
  // draftable/visible automatically, no players-raw.json edit needed.
  // Dedupe on STABLE IDENTITY first: the sheet's own pid, else the registry pid resolved
  // from the sheet's name spelling. That second step is what stops a phantom DUPLICATE when
  // the sheet spells a seeded player differently and the row carries no pid — e.g. sheet
  // "Milan Priyanath Rathnayake" resolving to the seed's "Milan Ratnayake" (slug:milan-
  // ratnayake). resolveEspnPid returns null on ambiguity, so it never gambles a namesake.
  // Fuzzy name is the last-resort dedupe for anyone the registry doesn't know yet.
  if (sheetRoster) {
    for (const team of teams) {
      const sheetTeam = getByTeamCode(sheetRoster, team);
      if (!sheetTeam) continue;
      const seeded = pool.filter((p) => p.teamCode === team);
      const seededPids = new Set(seeded.map((p) => p.pid).filter(Boolean) as string[]);
      const known = seeded.map((p) => p.displayName);
      for (const [name, { role, pid }] of sheetTeam) {
        const identPid = pid || resolveEspnPid(undefined, name) || undefined;
        if (identPid && seededPids.has(identPid)) continue;
        if (fuzzyMatchName(name, known) !== null) continue;
        // Carry the identity we just resolved. This used to push a pid-LESS synthetic even
        // though the sheet handed us a Player ID, so a self-healed player joined points and XI
        // membership by fuzzy NAME only — under the sheet's spelling, which for a newcomer is the
        // full LEGAL name. CPL 2026 drafted three players that way: "Kevlon Alston Anderson",
        // "Rivaldo A Clarke", "Khari Campbell" as a BOWL. You cannot find those by searching the
        // name you know, which is what "I can't see him" actually looks like. With the pid the key
        // becomes `x|<pid>|…` and points/XI join on identity exactly like a seeded player.
        pool.push(syntheticPlayer(team, role, name, 99, identPid));
        known.push(name);
        if (identPid) seededPids.add(identPid);
      }
    }
  }

  return pool
    .map((p) => {
      const teamXI = getByTeamCode(lastXI, p.teamCode);
      let isLikelyXI: boolean;
      let batOrder = 0;
      if (teamXI && teamXI.size > 0) {
        const m = matchPlayerInXI(p, teamXI);
        isLikelyXI = m.inXI;
        batOrder = m.batOrder;
      } else {
        isLikelyXI = p.squadNumber <= 11;
      }
      return { player: p, isLikelyXI, batOrder };
    })
    .sort((a, b) => {
      if (a.player.teamCode !== b.player.teamCode)
        return a.player.teamCode.localeCompare(b.player.teamCode);
      if (a.isLikelyXI !== b.isLikelyXI) return a.isLikelyXI ? -1 : 1;
      const ao = a.batOrder > 0 ? a.batOrder : 999;
      const bo = b.batOrder > 0 ? b.batOrder : 999;
      if (ao !== bo) return ao - bo;
      return a.player.squadNumber - b.player.squadNumber;
    })
    .map(({ player, isLikelyXI }) => ({ ...player, isLikelyXI }));
}

export function getPlayerByKey(key: string): Player | undefined {
  if (key.startsWith(SYNTH_PREFIX)) {
    const parts = key.split("|"); // ["s", team, role, ...nameParts]
    const team = parts[1] ?? "";
    const role = parts[2] ?? "BAT";
    const name = parts.slice(3).join("|");
    return name ? syntheticPlayer(team, role, name) : undefined;
  }
  if (key.startsWith(EXT_PREFIX)) {
    const parts = key.split("|"); // ["x", pid, team, role, ...nameParts]
    const pid = parts[1] ?? "";
    const team = parts[2] ?? "";
    const role = parts[3] ?? "BAT";
    const name = parts.slice(4).join("|");
    return pid && name ? syntheticPlayer(team, role, name, 99, pid) : undefined;
  }
  return ALL_PLAYERS.find((p) => p.key === key);
}

export function getFullSquadByTeams(team1: string, team2: string): Player[] {
  return ALL_PLAYERS.filter(
    (p) => p.teamCode === team1 || p.teamCode === team2
  ).sort((a, b) => a.teamCode.localeCompare(b.teamCode) || a.squadNumber - b.squadNumber);
}
