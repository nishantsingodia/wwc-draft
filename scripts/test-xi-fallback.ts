import { matchPlayerInXI } from "@/lib/players";
let pass=0, fail=0;
const ck=(n:string,c:boolean)=>{c?pass++:fail++;console.log(`  ${c?"✓":"✗"} ${n}`);};

// feed carries pids -> strict rule, namesake CANNOT steal a slot
const pidFeed = new Map<string,number>([["ci:111",1],["ci:222",2]]);
ck("pid'd player present in a pid'd feed is IN",
   matchPlayerInXI({pid:"ci:111",displayName:"A Fernando"}, pidFeed).inXI === true);
ck("pid'd player ABSENT from a pid'd feed is OUT (namesake guard intact)",
   matchPlayerInXI({pid:"ci:999",displayName:"A Fernando"}, pidFeed).inXI === false);

// feed carries NO pids -> absence is our failure, fall back to name
const nameFeed = new Map<string,number>([["Kamil Pooran",4],["Kyle Mayers",3]]);
ck("pid'd player in a feed with NO pids falls back to NAME (the CPL dropout)",
   matchPlayerInXI({pid:"ci:556531",displayName:"Kamil Pooran"}, nameFeed).inXI === true);
ck("...and keeps the feed's bat order",
   matchPlayerInXI({pid:"ci:556531",displayName:"Kamil Pooran"}, nameFeed).batOrder === 4);
ck("a genuinely absent player is still OUT even in a pid-less feed",
   matchPlayerInXI({pid:"ci:1",displayName:"Nobody Here"}, nameFeed).inXI === false);
ck("un-pid'd draft player still name-matches (unchanged)",
   matchPlayerInXI({pid:undefined as any,displayName:"Kyle Mayers"}, nameFeed).inXI === true);
ck("empty feed -> OUT",
   matchPlayerInXI({pid:"ci:1",displayName:"X"}, new Map()).inXI === false);
// ── PLACEHOLDER PIDS (uncapped: / cs: / slug: / legacy hash) ───────────────────
// An ESPN-derived XI map is keyed by ci:/espn: + raw names. A placeholder pid can never
// appear in it, so its absence is OUR failure to anchor the player, not evidence he sat
// out. CPL 2026: 4 players who played were judged not-in-XI and never promoted.
const espnFeed = new Map<string,number>([
  ["ci:1209191", 10], ["Joshua James", 10],   // as lib/espn.ts keys it: pid AND name
  ["ci:494581", 1],   ["Rahkeem Cornwall", 1],
  ["ci:1078695", 3],  ["Mikyle Louis", 3],
]);
ck("uncapped: pid absent from a ci:-keyed feed falls back to EXACT NAME (the CPL bug)",
   matchPlayerInXI({pid:"uncapped:joshua-james",displayName:"Joshua James"}, espnFeed).inXI === true);
ck("...and keeps the feed's bat order",
   matchPlayerInXI({pid:"uncapped:joshua-james",displayName:"Joshua James"}, espnFeed).batOrder === 10);
ck("cs: pid gets the same treatment",
   matchPlayerInXI({pid:"cs:abc",displayName:"Rahkeem Cornwall"}, espnFeed).inXI === true);
ck("slug: pid gets the same treatment",
   matchPlayerInXI({pid:"slug:rahkeem-cornwall",displayName:"Rahkeem Cornwall"}, espnFeed).inXI === true);
ck("a placeholder-pid player who genuinely did not play is still OUT",
   matchPlayerInXI({pid:"uncapped:jakeem-pollard",displayName:"Jakeem Pollard"}, espnFeed).inXI === false);

// THE REGRESSION THIS FIX MUST NOT CAUSE. fuzzyMatchName's last rule matches on SURNAME
// ALONE with no initial, so a full fuzzy fall-back would hand Jeremiah Louis his MTSTK
// squadmate Mikyle Louis's slot. Exact-name-only is what stops it.
ck("a same-surname SQUADMATE cannot steal the slot (Jeremiah vs Mikyle Louis)",
   matchPlayerInXI({pid:"uncapped:jeremiah-louis",displayName:"Jeremiah Louis"}, espnFeed).inXI === false);
ck("re-anchored ci: pid matches exactly, no name needed",
   matchPlayerInXI({pid:"ci:1209191",displayName:"whatever spelling"}, espnFeed).inXI === true);
ck("a ci: pid absent from a ci:-keyed feed is still OUT (namesake guard intact)",
   matchPlayerInXI({pid:"ci:404",displayName:"Joshua James"}, espnFeed).inXI === false);

console.log(`\n${pass} passed, ${fail} failed`);
if(fail) process.exit(1);
