// Second-pass photo harvest: fill the gaps left by harvest-photos.ts using a FUZZY
// Wikidata search (wbsearchentities), which catches spelling variants the exact-label
// SPARQL pass missed (e.g. "Kavisha" ↔ "Kaveesha"). Precision guards keep wrong people
// out: the candidate's description must contain "cricket" AND its label must share the
// player's surname token. Merge-only — never overwrites an existing photo. Re-runnable.
import rawPlayers from "@/data/players-raw.json";
import { readFileSync, writeFileSync } from "node:fs";

type P = { id: number; name: string; pid?: string; team_code: string };
const players = rawPlayers as unknown as P[];
const photos = JSON.parse(readFileSync("data/player-photos.json", "utf8")) as Record<string, string>;
const UA = { "User-Agent": "wwc-draft-photo-harvest/1.0 (https://wwc-draft.vercel.app; nishant@dreamstreet.tech)" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
const commons = (f: string) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f)}?width=160`;

async function findQid(name: string): Promise<string | null> {
  const surname = norm(name).split(" ").pop() || "";
  for (let a = 0; a < 3; a++) {
    const r = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&type=item&language=en&limit=8&format=json`,
      { headers: UA }
    );
    if (r.status === 429) { await sleep(4000); continue; }
    if (!r.ok) return null;
    const j = await r.json();
    for (const c of j.search ?? []) {
      const desc = (c.description || "").toLowerCase();
      if (!desc.includes("cricket")) continue; // occupation guard
      const label = norm(c.label || "");
      if (surname.length >= 3 && !label.includes(surname)) continue; // surname guard
      return c.id as string;
    }
    return null;
  }
  return null;
}

async function p18Batch(qids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < qids.length; i += 45) {
    const ids = qids.slice(i, i + 45).join("|");
    let j: Record<string, unknown> | undefined;
    for (let a = 0; a < 3; a++) {
      const r = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=claims&format=json`,
        { headers: UA }
      );
      if (r.status === 429) { await sleep(4000); continue; }
      j = await r.json();
      break;
    }
    const ents = (j?.entities as Record<string, Record<string, unknown>>) ?? {};
    for (const [qid, ent] of Object.entries(ents)) {
      const claims = ent.claims as Record<string, Array<Record<string, unknown>>> | undefined;
      const img = (((claims?.P18?.[0]?.mainsnak as Record<string, unknown>)?.datavalue as Record<string, unknown>)?.value) as string | undefined;
      if (img) out.set(qid, img);
    }
    await sleep(800);
  }
  return out;
}

async function main() {
  const need = players.filter((p) => p.pid && !photos[p.pid]);
  console.log(`gaps to try: ${need.length}`);
  const pidToQid = new Map<string, { qid: string; player: P }>();
  let n = 0;
  for (const p of need) {
    const qid = await findQid(p.name);
    if (qid) pidToQid.set(p.pid!, { qid, player: p });
    if (++n % 50 === 0) console.log(`  searched ${n}/${need.length}, matched ${pidToQid.size}`);
    await sleep(350);
  }
  const qids = [...new Set([...pidToQid.values()].map((v) => v.qid))];
  console.log(`unique cricketer QIDs: ${qids.length}, fetching P18…`);
  const imgs = await p18Batch(qids);
  const review: string[] = [];
  let added = 0;
  for (const [pid, { qid, player }] of pidToQid) {
    const file = imgs.get(qid);
    if (file) { photos[pid] = commons(file); review.push(`${player.name} (${player.team_code}) ${qid} ← ${file}`); added++; }
  }
  writeFileSync("data/player-photos.json", JSON.stringify(photos, null, 0) + "\n");
  console.log(`\nADDED ${added} | total now ${Object.keys(photos).length}/${players.length}`);
  console.log(`\n--- new (review) ---\n${review.sort().join("\n")}`);
}
main().then(() => process.exit(0));
