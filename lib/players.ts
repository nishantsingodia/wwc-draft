import rawPlayers from "@/data/players-raw.json";

export type Player = {
  id: number;
  key: string; // cricsheet_id as string → used as unique key
  name: string;
  displayName: string;
  country: string;
  role: "WK" | "BAT" | "AR" | "BOWL";
  teamCode: string;
  squadNumber: number;
  efppm: number; // expected fantasy points per match (tour projection)
};

const TEAM_FLAGS: Record<string, string> = {
  AUS: "🇦🇺",
  BAN: "🇧🇩",
  ENG: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  IND: "🇮🇳",
  IRE: "🇮🇪",
  NED: "🇳🇱",
  NZ: "🇳🇿",
  PAK: "🇵🇰",
  SA: "🇿🇦",
  SCO: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  SL: "🇱🇰",
  WI: "🏏",
};

export const TEAM_NAMES: Record<string, string> = {
  AUS: "Australia",
  BAN: "Bangladesh",
  ENG: "England",
  IND: "India",
  IRE: "Ireland",
  NED: "Netherlands",
  NZ: "New Zealand",
  PAK: "Pakistan",
  SA: "South Africa",
  SCO: "Scotland",
  SL: "Sri Lanka",
  WI: "West Indies",
};

// Normalise cricksheet initials name → readable display name
// e.g. "SFM Devine" → "Sophie Devine", falls back to "S. Devine"
const DISPLAY_NAME_MAP: Record<string, string> = {
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
  "BL Mooney": "Beth Mooney",
  "EA Perry": "Ellyse Perry",
  "A Gardner": "Ashleigh Gardner",
  "ML Schutt": "Megan Schutt",
  "G Wareham": "Georgia Wareham",
  "AJ Healy": "Alyssa Healy",
  "MM Lanning": "Meg Lanning",
  "E Villani": "Elyse Villani",
  "RA Haynes": "Rachel Haynes",
  "LM Tahuhu": "Lea Tahuhu",
  "CA Athapaththu": "Chamari Athapaththu",
  "N de Silva": "Nilakshi de Silva",
  "IM Dulani": "Inoshi Dulani",
  "HASD Siriwardene": "Hasini Perera",
  "VH Rajapaksha": "Vishmi Rajapaksha",
  "H Karunaratne": "Harshitha Madavi",
  "K Dilhari": "Kavisha Dilhari",
};

function toDisplayName(cricName: string): string {
  if (DISPLAY_NAME_MAP[cricName]) return DISPLAY_NAME_MAP[cricName];
  // fallback: "SFM Devine" → "S. Devine"
  const parts = cricName.trim().split(" ");
  if (parts.length >= 2) {
    const initials = parts[0];
    const surname = parts[parts.length - 1];
    return `${initials[0]}. ${surname}`;
  }
  return cricName;
}

export function getFlag(teamCode: string): string {
  return TEAM_FLAGS[teamCode] ?? "🏏";
}

// All 180 players
const ALL_PLAYERS: Player[] = (rawPlayers as typeof rawPlayers).map((p) => ({
  id: p.id,
  key: String(p.id),
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

export function getPlayersByTeams(team1: string, team2: string): Player[] {
  return ALL_PLAYERS.filter(
    (p) =>
      (p.teamCode === team1 || p.teamCode === team2) &&
      p.squadNumber <= 11 // likely playing XI (squad positions 1-11)
  ).sort((a, b) => b.efppm - a.efppm);
}

export function getPlayerByKey(key: string): Player | undefined {
  return ALL_PLAYERS.find((p) => p.key === key);
}

export function getFullSquadByTeams(team1: string, team2: string): Player[] {
  return ALL_PLAYERS.filter(
    (p) => p.teamCode === team1 || p.teamCode === team2
  ).sort((a, b) => a.teamCode.localeCompare(b.teamCode) || a.squadNumber - b.squadNumber);
}
