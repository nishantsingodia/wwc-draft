import { resolveEspnPid } from "@/lib/registry";
let pass=0, fail=0;
const ck=(n:string,c:boolean)=>{c?pass++:fail++;console.log(`  ${c?"✓":"✗"} ${n}`);};

// A player the mirror has never seen — a debutant. No name is consulted.
ck("unknown athlete id constructs ci:<id> without touching names",
   resolveEspnPid(9999991, "Totally Unknown Debutant") === "ci:9999991");
ck("...and does the same when the name is empty",
   resolveEspnPid(9999991, "") === "ci:9999991");
// A known player still resolves through the registry, so ALTERNATE espn profiles (cricinfo_alt)
// keep mapping back to the canonical pid rather than minting a second identity.
const known = resolveEspnPid(556531, "Kamil Pooran");
ck("a known athlete id still resolves via the registry", known === "ci:556531");
// Garbage must never become a pid-shaped string.
for (const bad of ["", "abc", "0", "-5", "12x"]) {
  ck(`espnId ${JSON.stringify(bad)} does NOT construct a pid`,
     resolveEspnPid(bad as any, "Nobody At All") !== `ci:${bad}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
if(fail) process.exit(1);
