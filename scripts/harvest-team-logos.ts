#!/usr/bin/env npx tsx
// One-time (re-runnable) offline harvest of REAL team crests → data/team-logos.json,
// keyed by our team code. Best-effort: whatever ESPN doesn't have falls back at runtime to
// the generated brand badge (lib/team-brands.ts), so a miss is invisible, never broken.
//
// Source: the same ESPN cricket API the app already uses (lib/espn.ts). For each series in
// data/espn-series.json we read every team's `logos[].href` from the /teams list and the
// /scoreboard events, mapping ESPN's team displayName -> our code via the same gender-stripped
// team key espn.ts matches on. Mirrors scripts/harvest-photos.ts in shape/spirit.
import { writeFileSync } from "node:fs";
import { TEAM_NAMES } from "@/lib/players";
import { normName } from "@/lib/fuzzy-name-match";
import espnSeries from "@/data/espn-series.json";

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/cricket";
const UA = { "User-Agent": "Mozilla/5.0 (wwc-draft team-logo harvest)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same identity key espn.ts uses: strip men/women qualifiers, normalise.
function teamKey(name: string): string {
  return normName(name.replace(/\b(?:wo)?men\b/gi, ""));
}

// code -> logo URL, plus a reverse index teamKey -> [codes] so one ESPN team fills all its
// variants (IND/MIND/OIND share "india"; MTSBR/WTSBR share "southern brave").
const out: Record<string, string> = {};
const codesByKey = new Map<string, string[]>();
for (const [code, name] of Object.entries(TEAM_NAMES)) {
  const k = teamKey(name);
  const arr = codesByKey.get(k) ?? [];
  arr.push(code);
  codesByKey.set(k, arr);
}

type EspnTeam = { displayName?: string; logos?: Array<{ href?: string }>; logo?: string };

function pickLogo(t: EspnTeam): string | null {
  const href = t.logos?.find((l) => l.href)?.href || t.logo || null;
  // Skip ESPN's generic placeholder crest so we fall back to our badge instead.
  if (!href || /default|placeholder|no-?logo/i.test(href)) return null;
  return href;
}

function record(t: EspnTeam) {
  if (!t.displayName) return;
  const logo = pickLogo(t);
  if (!logo) return;
  const codes = codesByKey.get(teamKey(t.displayName));
  if (!codes) return;
  for (const c of codes) if (!out[c]) out[c] = logo;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function harvestSeries(series: string) {
  // 1) /teams — the full team list for a series (best coverage).
  const teams = await getJson(`${ESPN_BASE}/${series}/teams`);
  const leagues = ((teams?.sports as Array<Record<string, unknown>>)?.[0]?.leagues as Array<Record<string, unknown>>) ?? [];
  for (const lg of leagues) {
    for (const t of (lg.teams as Array<Record<string, unknown>>) ?? []) {
      record((t.team as EspnTeam) ?? (t as EspnTeam));
    }
  }
  // 2) /scoreboard events — competitors carry logos too (fills anything /teams missed).
  const sb = await getJson(`${ESPN_BASE}/${series}/scoreboard`);
  for (const e of (sb?.events as Array<Record<string, unknown>>) ?? []) {
    const comp = (e.competitions as Array<Record<string, unknown>>)?.[0];
    for (const c of (comp?.competitors as Array<Record<string, unknown>>) ?? []) {
      record((c.team as EspnTeam) ?? {});
    }
  }
}

async function main() {
  const allSeries = [...(espnSeries.W ?? []), ...(espnSeries.M ?? [])];
  for (const s of allSeries) {
    await harvestSeries(s);
    await sleep(250);
  }

  const allCodes = Object.keys(TEAM_NAMES);
  const found = allCodes.filter((c) => out[c]);
  const missing = allCodes.filter((c) => !out[c]);

  writeFileSync("data/team-logos.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`\n✅ wrote data/team-logos.json — ${found.length}/${allCodes.length} teams with a real logo`);
  console.log(`   badge fallback (no logo found): ${missing.join(", ") || "none"}`);
}

main();
