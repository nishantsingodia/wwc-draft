// One-time (re-runnable) offline harvest of player photos → data/player-photos.json,
// keyed by the STABLE registry pid. Two sources, best-of:
//   1. ESPN by exact athlete id (only for players whose pid is "espn:<id>") — id-exact,
//      no name ambiguity. Verified to actually 200 (ESPN hands out full/<id>.png that 404).
//   2. Wikidata, filtered to occupation = cricketer (Q12299841) and matched on label OR
//      alias — so a same-name footballer can't be picked. P18 image → Wikimedia Commons
//      thumb. A name that maps to >1 cricketer with images is SKIPPED (ambiguous), never
//      guessed. Misses just fall back to the team flag at runtime.
//
// Runtime is a pure pid→URL lookup; all the fuzzy work is here, printed for eyeballing.
import rawPlayers from "@/data/players-raw.json";
import { writeFileSync } from "node:fs";

type P = { id: number; name: string; pid?: string; team_code: string };
const players = rawPlayers as unknown as P[];
const UA = { "User-Agent": "wwc-draft-photo-harvest/1.0 (https://wwc-draft.vercel.app; nishant@dreamstreet.tech)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function espnThumb(id: string, size = 96) {
  return `https://a.espncdn.com/combiner/i?img=/i/headshots/cricket/players/full/${id}.png&w=${size}&h=${size}`;
}
function commonsThumb(file: string, width = 160) {
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=${width}`;
}

async function espnHas(id: string): Promise<boolean> {
  try {
    const r = await fetch(`https://a.espncdn.com/i/headshots/cricket/players/full/${id}.png`, { headers: UA });
    return r.status === 200 && (r.headers.get("content-type") || "").startsWith("image");
  } catch {
    return false;
  }
}

// Batch Wikidata SPARQL: names → cricketer entity → P18 image. Returns name → image-file
// (only when exactly one cricketer with an image matches that name).
async function wikidataBatch(names: string[]): Promise<Map<string, string>> {
  const values = names.map((n) => `"${n.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"@en`).join(" ");
  const query = `SELECT ?name ?p ?img WHERE {
    VALUES ?name { ${values} }
    ?p wdt:P106 wd:Q12299841 .
    ?p rdfs:label|skos:altLabel ?name .
    ?p wdt:P18 ?img .
  }`;
  const res = await fetch("https://query.wikidata.org/sparql", {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
    body: "query=" + encodeURIComponent(query),
  });
  if (!res.ok) {
    console.log(`   [sparql ${res.status}] backing off…`);
    await sleep(5000);
    return new Map();
  }
  const j = await res.json();
  // group by name → set of (qid,file); accept only unambiguous single-cricketer matches
  const byName = new Map<string, Map<string, string>>();
  for (const b of j.results?.bindings ?? []) {
    const name = b.name?.value as string;
    const qid = (b.p?.value as string).split("/").pop()!;
    const file = (b.img?.value as string).split("/").pop()!; // Special:FilePath filename
    if (!byName.has(name)) byName.set(name, new Map());
    byName.get(name)!.set(qid, decodeURIComponent(file));
  }
  const out = new Map<string, string>();
  for (const [name, qmap] of byName) {
    if (qmap.size === 1) out.set(name, [...qmap.values()][0]);
    else console.log(`   [ambiguous] "${name}" → ${qmap.size} cricketers, skipped`);
  }
  return out;
}

async function main() {
  const photo: Record<string, string> = {}; // pid → url
  const review: string[] = [];
  let espnCount = 0, wdCount = 0;

  // 1) ESPN by exact id
  const espnPlayers = players.filter((p) => p.pid?.startsWith("espn:"));
  console.log(`ESPN pass: ${espnPlayers.length} players with espn: pid`);
  for (const p of espnPlayers) {
    const id = p.pid!.slice(5);
    if (await espnHas(id)) {
      photo[p.pid!] = espnThumb(id);
      review.push(`ESPN  ${p.name}  (${p.team_code})  ${p.pid}`);
      espnCount++;
    }
    await sleep(60);
  }

  // 2) Wikidata for everyone still without a photo
  const need = players.filter((p) => p.pid && !photo[p.pid]);
  console.log(`\nWikidata pass: ${need.length} players still need a photo`);
  const BATCH = 45;
  for (let i = 0; i < need.length; i += BATCH) {
    const slice = need.slice(i, i + BATCH);
    const nameToPlayers = new Map<string, P[]>();
    for (const p of slice) {
      if (!nameToPlayers.has(p.name)) nameToPlayers.set(p.name, []);
      nameToPlayers.get(p.name)!.push(p);
    }
    const found = await wikidataBatch([...nameToPlayers.keys()]);
    for (const [name, file] of found) {
      for (const p of nameToPlayers.get(name) ?? []) {
        if (photo[p.pid!]) continue;
        photo[p.pid!] = commonsThumb(file);
        review.push(`WIKI  ${p.name}  (${p.team_code})  ${p.pid}  ← ${file}`);
        wdCount++;
      }
    }
    console.log(`   batch ${i / BATCH + 1}/${Math.ceil(need.length / BATCH)}: +${found.size} names`);
    await sleep(1200); // be polite to the SPARQL endpoint
  }

  writeFileSync("data/player-photos.json", JSON.stringify(photo, null, 0) + "\n");
  console.log(`\n=== DONE ===`);
  console.log(`total players: ${players.length} | ESPN: ${espnCount} | Wikidata: ${wdCount} | with photo: ${Object.keys(photo).length} | flag-only: ${players.length - Object.keys(photo).length}`);
  console.log(`\n--- review (${review.length}) ---`);
  console.log(review.sort().join("\n"));
}
main().then(() => process.exit(0));
