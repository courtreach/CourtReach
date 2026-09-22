// ---- court-day simulator + engine cross-check (jsc) ----
load("../board-engine.js"); const ENG=globalThis.BoardEngine;
let seed=12345; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; };
const ri=(a,b)=>a+Math.floor(rnd()*(b-a+1));
const shuffle=a=>{ for(let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; };

// Build a day. Returns {events, seqText, T, R, passIdxMode}
function buildDay(opt){
  const T=opt.T, R=opt.R;
  const misc=[...Array(T)].map((_,i)=>i+1);
  let order=misc.slice(), seqText="", declared=[];
  if(opt.seqMode==="blocks"){            // e.g. "1 to 10, 30 to 40" then the rest ascending
    const a=ri(1,Math.max(1,T-4)), b=Math.min(T,a+ri(0,8)); const c=ri(1,T), d=Math.min(T,c+ri(0,8));
    const blk=[]; for(let k=a;k<=b;k++) blk.push(k); for(let k=c;k<=d;k++) if(!blk.includes(k)) blk.push(k);
    declared=blk; const rest=misc.filter(x=>!blk.includes(x)); order=[...blk,...rest];
    seqText=`ITEM NOS.${a} TO ${b} ${c} TO ${d}` + (opt.saysRest?" AND THEN THE REST":"");
  } else if(opt.seqMode==="full"){        // whole list in blocks, permuted
    const cuts=new Set(); while(cuts.size<Math.min(3,T-1)) cuts.add(ri(1,T-1));
    const cs=[0,...[...cuts].sort((x,y)=>x-y),T]; const blocks=[]; for(let i=0;i<cs.length-1;i++) blocks.push(misc.slice(cs[i],cs[i+1]));
    shuffle(blocks); order=blocks.flat(); declared=order.slice();
    seqText="ITEM NOS."+blocks.map(b=>b.length>1?`${b[0]} TO ${b[b.length-1]}`:String(b[0])).join(" ");
  }
  // passovers: items that get passed over at their slot
  const nPO=opt.nPO; const poSet=new Set(); while(poSet.size<Math.min(nPO,T)) poSet.add(order[ri(0,order.length-1)]);
  // recall point: "end" (after Misc, before Regular) or "passIdx" (after the declared blocks, before the rest — only meaningful for blocks)
  let recallAt = opt.recall; if(recallAt==="passIdx" && opt.seqMode!=="blocks") recallAt="end";
  if(recallAt==="passIdx") seqText = seqText.replace(/ AND THEN THE REST$/,"") + " THEN PASSOVERS AND THEN THE REST";
  const events=[]; const outstanding=[];
  const recallAll=()=>{ // in the order they were passed over
    while(outstanding.length){ const it=outstanding.shift(); events.push({item:it,kind:"recall"}); } };
  for(let i=0;i<order.length;i++){
    const it=order[i];
    if(recallAt==="passIdx" && i===declared.length) recallAll();
    if(poSet.has(it)){ events.push({item:it,kind:"po"}); outstanding.push(it); } else events.push({item:it,kind:"call"});
  }
  recallAll();
  for(let r=0;r<R;r++) events.push({item:101+r,kind:"call"});
  return {events, seqText, T, R, declared, recallAt, order, poSet};
}

// Run the engine over the day and compare. Tracks the app-side bookkeeping (boardPO/recalledPO/itemHi/remarks).
function runDay(day, targets, log){
  const court="5"; const remarks={}; const boardPO={}, recalledPO={}; const itemHi={}; let bad=0, total=0;
  const outstandingAt=new Set();
  for(let i=0;i<day.events.length;i++){
    const ev=day.events[i];
    if(ev.kind==="po") outstandingAt.add(ev.item);
    // KNOWABLE truth at this tick: a future passover cannot be foreseen, so its original slot is
    // taken as an ordinary call and its recall does not exist yet; recalls of passovers already
    // outstanding are known and sit where the court will take them.
    const lastIdx={}; let pos=0;
    for(let j=i;j<day.events.length;j++){ const e=day.events[j];
      if(e.kind==="recall" && !outstandingAt.has(e.item)) continue;
      if(e.kind==="po" && j>i){ lastIdx[e.item]=lastIdx[e.item]??pos; pos++; continue; }   // treated as a normal call
      lastIdx[e.item]=pos; pos++; }
    if(ev.kind==="recall") outstandingAt.delete(ev.item);
    // board row for this tick
    const bc={court, item:String(ev.item), status:"IN SESSION", passover:ev.kind==="po"};
    if(ev.kind==="po") remarks[ev.item]="PASS OVER";
    // app-side bookkeeping (mirrors recordBoardPO/noteItemHi)
    const outstanding=ENG.passoverItemsFor({remarksByCourt:{[court]:{items:remarks}}}, court);
    for(const key in boardPO){ const it=key.split("_")[1]; if(!(it in outstanding)){ delete boardPO[key]; recalledPO[key]=true; } }
    for(const n in outstanding) boardPO[court+"_"+n]=true;
    if(ev.kind==="po") boardPO[court+"_"+ev.item]=true;
    if(ev.kind==="recall"){ delete remarks[ev.item]; /* recalled item shows as current; remark column no longer PASS OVER */ delete boardPO[court+"_"+ev.item]; recalledPO[court+"_"+ev.item]=true; }
    itemHi[court]=Math.max(itemHi[court]||0, ev.item);
    const ctx={ nowMins:700, seqByCourt: day.seqText?{[court]:day.seqText}:{}, remarksByCourt:{[court]:{items:{...remarks}}},
      boardPO:{...boardPO}, recalledPO:{...recalledPO}, itemHi:{...itemHi}, miscTotalByCourt:{[court]:day.T}, boardByCourt:{[court]:bc}, poMarks:{}, doneMarks:{} };
    for(const X of targets){
      const j=lastIdx[X]; if(j==null){ /* already over */ }
      const truth=(j==null)?-1:j;
      const k=ENG.classify({courtNo:court,itemNo:String(X),listType:X>=101?"Regular":"Miscellaneous"}, bc, ctx);
      total++;
      let ok;
      if(truth<0) ok = !!k.over || (k.gap!=null && k.gap<0);
      else ok = (k.gap===truth) && !k.over;
      if(!ok){ bad++; if(log && log.n<log.max){ log.n++; log.lines.push(`  tick ${i} on ${ev.item}(${ev.kind}) ours=${X} truth=${truth} got=${JSON.stringify({gap:k.gap,tier:k.tier,over:!!k.over,short:k.short,label:k.label})}`); } }
    }
    // after the tick, done items get OVER
    if(ev.kind==="call"||ev.kind==="recall") remarks[ev.item]="OVER";
  }
  return {bad,total};
}

const scenarios=[];
for(const seqMode of ["none","blocks","full"]) for(const recall of ["end","passIdx"]) for(const nPO of [0,1,3,6]) for(const R of [0,4]) for(const T of [12,40])
  scenarios.push({seqMode,recall,nPO,R,T,saysRest:false});
const summary={};
for(const sc of scenarios){
  const key=`${sc.seqMode}/${sc.recall==="passIdx"&&sc.seqMode!=="blocks"?"end":sc.recall}/PO${sc.nPO}/R${sc.R}`;
  summary[key]=summary[key]||{bad:0,total:0,log:{n:0,max:4,lines:[]},ex:null};
  for(let rep=0;rep<6;rep++){
    const day=buildDay(sc);
    const targets=[...day.order, ...[...Array(sc.R)].map((_,r)=>101+r)];
    const r=runDay(day, targets, summary[key].log);
    summary[key].bad+=r.bad; summary[key].total+=r.total;
    if(r.bad && !summary[key].ex) summary[key].ex={seq:day.seqText, po:[...day.poSet], order:day.order.join(",")};
  }
}
let tb=0,tt=0;
for(const k of Object.keys(summary).sort()){ const s=summary[k]; tb+=s.bad; tt+=s.total;
  print(`${k.padEnd(28)} ${String(s.bad).padStart(6)} / ${String(s.total).padStart(6)} mismatches`);
  if(s.bad){ if(s.ex) print("   e.g. seq="+JSON.stringify(s.ex.seq)+" po="+JSON.stringify(s.ex.po)+" order="+s.ex.order); s.log.lines.forEach(l=>print(l)); }
}
print(`\nTOTAL ${tb} / ${tt}`);
