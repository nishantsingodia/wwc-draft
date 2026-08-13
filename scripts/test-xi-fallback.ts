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
console.log(`\n${pass} passed, ${fail} failed`);
if(fail) process.exit(1);
