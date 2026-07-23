import rawPlayers from "@/data/players-raw.json";
import { fuzzyMatchName } from "./fuzzy-name-match";
import teamCodes from "@/data/team-codes.json";

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

// A points-sheet key is a registry pid (cricsheet hash, "espn:N", or "slug:..."),
// not a player name. Used to keep fuzzy NAME matching from ever seeing a pid key.
export function isPidKey(k: string): boolean {
  return /^(espn:|slug:)/.test(k) || /^[0-9a-f]{8}$/.test(k);
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
// everywhere (pick/team/results) without any hand-editing. Format: "s|TEAM|ROLE|Name".
const SYNTH_PREFIX = "s|";

export function makeSyntheticKey(team: string, role: string, name: string): string {
  return `${SYNTH_PREFIX}${team}|${role}|${name}`;
}

function syntheticPlayer(team: string, role: string, name: string, squadNumber = 99): Player {
  const r = (["WK", "BAT", "AR", "BOWL"].includes(role) ? role : "BAT") as Player["role"];
  return {
    id: 0,
    key: makeSyntheticKey(team, r, name),
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
    return teamXI.has(player.pid)
      ? { inXI: true, batOrder: teamXI.get(player.pid) ?? 0 }
      : { inXI: false, batOrder: 0 };
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

  // Self-heal: merge in any live-feed player for these teams not already present.
  // Dedupe on the stable pid FIRST (so a canonical sheet name that differs from our
  // seeded name — e.g. sheet "Tajinder Singh" vs seed "Tajinder Dhillon" — doesn't spawn
  // a duplicate), then fall back to fuzzy name for un-pid'd rows.
  if (sheetRoster) {
    for (const team of teams) {
      const sheetTeam = getByTeamCode(sheetRoster, team);
      if (!sheetTeam) continue;
      const seeded = pool.filter((p) => p.teamCode === team);
      const seededPids = new Set(seeded.map((p) => p.pid).filter(Boolean) as string[]);
      const known = seeded.map((p) => p.displayName);
      for (const [name, { role, pid }] of sheetTeam) {
        if (pid && seededPids.has(pid)) continue;
        if (fuzzyMatchName(name, known) !== null) continue;
        pool.push(syntheticPlayer(team, role, name));
        known.push(name);
        if (pid) seededPids.add(pid);
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
  return ALL_PLAYERS.find((p) => p.key === key);
}

export function getFullSquadByTeams(team1: string, team2: string): Player[] {
  return ALL_PLAYERS.filter(
    (p) => p.teamCode === team1 || p.teamCode === team2
  ).sort((a, b) => a.teamCode.localeCompare(b.teamCode) || a.squadNumber - b.squadNumber);
}
