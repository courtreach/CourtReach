load("../board-engine.js"); const ENG=globalThis.BoardEngine;
let seed=777; const rnd=()=>{ seed=(seed*1103515245+12345)&0x7fffffff; return seed/0x7fffffff; }; const ri=(a,b)=>a+Math.floor(rnd()*(b-a+1));
let fails=0, checks=0; const fail=(m)=>{ fails++; if(fails<=25) print("  FAIL "+m); };
const court="5";
function ctxFor(day, remarks, boardPO, recalledPO, itemHi, bc, extra){ return Object.assign({ nowMins:700, seqByCourt: day.seqText?{[court]:day.seqText}:{}, remarksByCourt:{[court]:{items:{...remarks}}},
  boardPO:{...boardPO}, recalledPO:{...recalledPO}, itemHi:{...itemHi}, miscTotalByCourt:{[court]:day.T}, boardByCourt:{[court]:bc}, poMarks:{}, doneMarks:{} }, extra||{}); }

/* ---------- A. unannounced mid-list recalls: invariants only ---------- */
function dayInterleaved(T, nPO, seqText, order){
  const po=new Set(); while(po.size<nPO) po.add(order[ri(0,T-1)]);
  const events=[]; const pending=[];
  for(let i=0;i<order.length;i++){ const it=order[i];
    // recall any pending passover whose "counsel is back" tick has arrived
    while(pending.length && pending[0].at<=i){ events.push({item:pending.shift().item,kind:"recall"}); }
    if(po.has(it)){ events.push({item:it,kind:"po"}); pending.push({item:it, at:i+ri(2,6)}); pending.sort((a,b)=>a.at-b.at); } else events.push({item:it,kind:"call"});
  }
  while(pending.length) events.push({item:pending.shift().item,kind:"recall"});
  return {events, seqText, T};
}
for(let rep=0;rep<120;rep++){
  const T=ri(10,40); const misc=[...Array(T)].map((_,i)=>i+1);
  let order=misc.slice(), seqText="";
  if(rep%3===1){ const a=ri(1,T-3), b=Math.min(T,a+ri(1,6)); const blk=[]; for(let k=a;k<=b;k++) blk.push(k); order=[...blk,...misc.filter(x=>!blk.includes(x))]; seqText=`ITEM NOS.${a} TO ${b}`; }
  const day=dayInterleaved(T, ri(1,5), seqText, order);
  const remarks={}, boardPO={}, recalledPO={}, itemHi={}; const prevGap={}; const called=new Set();
  for(let i=0;i<day.events.length;i++){ const ev=day.events[i];
    const bc={court,item:String(ev.item),status:"IN SESSION",passover:ev.kind==="po"};
    if(ev.kind==="po") remarks[ev.item]="PASS OVER";
    const outstanding=ENG.passoverItemsFor({remarksByCourt:{[court]:{items:remarks}}}, court);
    for(const key in boardPO){ const it=key.split("_")[1]; if(!(it in outstanding)){ delete boardPO[key]; recalledPO[key]=true; } }
    for(const n in outstanding) boardPO[court+"_"+n]=true;
    if(ev.kind==="recall"){ delete remarks[ev.item]; delete boardPO[court+"_"+ev.item]; recalledPO[court+"_"+ev.item]=true; }
    itemHi[court]=Math.max(itemHi[court]||0, ev.item);
    const ctx=ctxFor(day,remarks,boardPO,recalledPO,itemHi,bc);
    for(const X of order){ if(called.has(X)) continue;   // only matters not yet heard
      const k=ENG.classify({courtNo:court,itemNo:String(X),listType:"Miscellaneous"}, bc, ctx); checks++;
      if(k.over) fail(`interleaved: ${X} called over while unheard (tick ${i} on ${ev.item} ${ev.kind}) seq=${day.seqText}`);
      if(k.gap!=null && k.gap<0) fail(`interleaved: negative gap for ${X}`);
      if(X===ev.item && ev.kind!=="po" && k.gap!==0) fail(`interleaved: current item ${X} gap=${k.gap} (${ev.kind})`);
      const p=prevGap[X]; if(p!=null && k.gap!=null && !(ev.kind==="po") && k.gap>p+0 && !(String(X) in outstanding)) fail(`interleaved: gap grew for ${X}: ${p} -> ${k.gap} (tick ${i} on ${ev.item} ${ev.kind}) seq="${day.seqText}"`);
      prevGap[X]=k.gap;
    }
    if(ev.kind==="call"||ev.kind==="recall"){ called.add(ev.item); remarks[ev.item]="OVER"; }
  }
}
print(`A. interleaved recalls: ${checks} checks, ${fails} fails`);

/* ---------- B. explicit "after item X" marks (user-marked passover with a recall point) ---------- */
{ let c0=checks, f0=fails;
  for(let rep=0;rep<60;rep++){
    const T=ri(8,30); const order=[...Array(T)].map((_,i)=>i+1);
    const poItem=ri(1,T-3), after=ri(poItem+1,T-1);
    // schedule: 1..after, then recall poItem, then after+1..T
    const events=[]; for(const it of order){ if(it===poItem) events.push({item:it,kind:"po"}); else events.push({item:it,kind:"call"}); if(it===after) events.push({item:poItem,kind:"recall"}); }
    const truthIdx={}; events.forEach((e,i)=>{ if(e.kind!=="po") truthIdx[e.item]=i; });
    const remarks={}, boardPO={}, recalledPO={}, itemHi={};
    for(let i=0;i<events.length;i++){ const ev=events[i]; const bc={court,item:String(ev.item),status:"IN SESSION",passover:ev.kind==="po"};
      if(ev.kind==="po") remarks[ev.item]="PASS OVER"; if(ev.kind==="recall") delete remarks[ev.item];
      itemHi[court]=Math.max(itemHi[court]||0, ev.item);
      const seen = i>=events.findIndex(e=>e.kind==="po");   // the mark exists from the moment it is passed over
      const ctx=ctxFor({seqText:"",T},remarks,boardPO,recalledPO,itemHi,bc,{ poMarks: seen&&i<truthIdx[poItem] ? {[court+"_"+poItem]:{mode:"after",after:String(after)}} : {} });
      const recallIdx=events.findIndex(e=>e.kind==="recall");
      for(const X of order){ const j=truthIdx[X]; let truth=j-i; if(!seen && X===poItem) continue;   // unknowable before the mark
        if(!seen && j>recallIdx) truth-=1;   // before the passover happens, nobody can foresee the recall slot
        const k=ENG.classify({courtNo:court,itemNo:String(X),listType:"Miscellaneous"}, bc, ctx); checks++;
        const ok = truth<0 ? (!!k.over||(k.gap!=null&&k.gap<0)) : (k.gap===truth && !k.over);
        if(!ok) fail(`after-mark: T=${T} po=${poItem} after=${after} tick ${i} on ${ev.item}(${ev.kind}) ours=${X} truth=${truth} got=${JSON.stringify({gap:k.gap,over:!!k.over,label:k.label})}`);
      }
      if(ev.kind!=="po") remarks[ev.item]="OVER";
    }
  }
  print(`B. explicit after-marks: ${checks-c0} checks, ${fails-f0} fails`);
}

/* ---------- C. a board that never posts OVER (only PASS OVER) — exact before recalls, sane after ---------- */
{ let c0=checks, f0=fails;
  for(let rep=0;rep<80;rep++){
    const T=ri(8,40); const misc=[...Array(T)].map((_,i)=>i+1);
    let order=misc.slice(), seqText="";
    if(rep%2){ const a=ri(1,T-3), b=Math.min(T,a+ri(1,8)); const blk=[]; for(let k=a;k<=b;k++) blk.push(k); order=[...blk,...misc.filter(x=>!blk.includes(x))]; seqText=`ITEM NOS.${a} TO ${b}`; }
    const po=new Set(); const n=ri(0,4); while(po.size<n) po.add(order[ri(0,T-1)]);
    const events=[]; const q=[]; for(const it of order){ if(po.has(it)){ events.push({item:it,kind:"po"}); q.push(it);} else events.push({item:it,kind:"call"}); } for(const it of q) events.push({item:it,kind:"recall"});
    for(let r=0;r<3;r++) events.push({item:101+r,kind:"call"});
    const remarks={}, boardPO={}, recalledPO={}, itemHi={}; const out=new Set();
    for(let i=0;i<events.length;i++){ const ev=events[i]; const bc={court,item:String(ev.item),status:"IN SESSION",passover:ev.kind==="po"};
      if(ev.kind==="po"){ remarks[ev.item]="PASS OVER"; out.add(ev.item); }
      const outstanding=ENG.passoverItemsFor({remarksByCourt:{[court]:{items:remarks}}}, court);
      for(const key in boardPO){ const it=key.split("_")[1]; if(!(it in outstanding)){ delete boardPO[key]; recalledPO[key]=true; } }
      for(const nn in outstanding) boardPO[court+"_"+nn]=true;
      // knowable truth
      const idx={}; let pos=0; for(let j=i;j<events.length;j++){ const e=events[j]; if(e.kind==="recall"&&!out.has(e.item)) continue; if(e.kind==="po"&&j>i){ idx[e.item]=idx[e.item]??pos; pos++; continue; } idx[e.item]=pos; pos++; }
      if(ev.kind==="recall"){ delete remarks[ev.item]; delete boardPO[court+"_"+ev.item]; recalledPO[court+"_"+ev.item]=true; out.delete(ev.item); }
      itemHi[court]=Math.max(itemHi[court]||0, ev.item);
      const ctx=ctxFor({seqText,T},remarks,boardPO,recalledPO,itemHi,bc);
      const inRecallRound = ev.kind==="recall";
      for(const X of [...order,101,102,103]){ const j=idx[X]; const truth=(j==null)?-1:j;
        const k=ENG.classify({courtNo:court,itemNo:String(X),listType:X>=101?"Regular":"Miscellaneous"}, bc, ctx); checks++;
        if(truth<0){ /* without OVER remarks the engine cannot know an item is over except by position */ continue; }
        if(inRecallRound && seqText){ if(k.gap!=null && k.gap<0) fail("noOver: negative in round"); continue; }   // reach under a sequence needs OVER; only sanity here
        if(!(k.gap===truth && !k.over)) fail(`noOver: T=${T} seq="${seqText}" tick ${i} on ${ev.item}(${ev.kind}) ours=${X} truth=${truth} got=${JSON.stringify({gap:k.gap,over:!!k.over,label:k.label})}`);
      }
      // NO "OVER" ever posted
    }
  }
  print(`C. no OVER remarks: ${checks-c0} checks, ${fails-f0} fails`);
}

/* ---------- D. parser + position spot checks ---------- */
{ let f0=fails;
  const eq=(a,b,m)=>{ checks++; if(JSON.stringify(a)!==JSON.stringify(b)) fail(m+" got "+JSON.stringify(a)+" want "+JSON.stringify(b)); };
  eq(ENG.seqInfo("Seq. Item Nos.1 to 4 51 to 55 5 to 50").seq.slice(0,6), [1,2,3,4,51,52], "Court 12 real line");
  eq(ENG.seqInfo("1-4, 51-55").seq, [1,2,3,4,51,52,53,54,55], "hyphen ranges");
  eq(ENG.seqInfo("ITEM NOS. 62.1 62.2 63").seq, [62,63], "sub-items collapse to parent");
  eq(ENG.seqInfo("1 to 10 then passovers then 11 to 20").passIdx, 10, "passover marker index");
  eq(ENG.orderPos([5,6,7],"62.1"), 3+61-3, "sub-item position = parent");
  const pd=ENG.parseSequenceLine("COURT NO. 1 ITEM NOS 1 TO 5 COURT NO. 12 SEQ. ITEM NOS.1 TO 4 51 TO 55 5 TO 50");
  eq(Object.keys(pd), ["1","12"], "parseSequenceLine courts");
  eq(ENG.seqInfo(pd["12"]).seq.length, 55, "court 12 expands to 55 items");
  // pre-start: court not sitting, sequence declared
  const k=ENG.classify({courtNo:"12",itemNo:"9",listType:"Miscellaneous"}, {court:"12",item:"",status:"NOT IN SESSION"}, {seqByCourt:{"12":pd["12"]}});
  eq([k.preStart,k.gap], [true, 13], "preStart gap = position in sequence (9 sits 14th in 1-4,51-55,5-50 -> 13 ahead)");
  // the owner's Court 8 worked example: item 31 current, Misc 35, six outstanding passovers (all reached), Regular 104
  const rem={}; [3,7,12,18,22,29].forEach(n=>rem[n]="PASS OVER"); for(let n=1;n<=30;n++) if(!rem[n]) rem[n]="OVER";
  const k8=ENG.classify({courtNo:"8",itemNo:"104",listType:"Regular"}, {court:"8",item:"31",status:"IN SESSION"}, {remarksByCourt:{"8":{items:rem}}, miscTotalByCourt:{"8":35}, boardByCourt:{"8":{court:"8",item:"31"}}});
  eq(k8.gap, 4+6+4, "Court 8 example: 4 misc left (32-35) + 6 passovers + 104 is 4th Regular = 14 (NEXT=1 convention)");
  // recall round in progress, no sequence: 2 outstanding ahead of ours
  const rem2={}; for(let n=1;n<=12;n++) rem2[n]="OVER"; rem2[4]="PASS OVER"; rem2[9]="PASS OVER"; delete rem2[2];
  const k9=ENG.classify({courtNo:"3",itemNo:"9",listType:"Miscellaneous"}, {court:"3",item:"2",status:"IN SESSION"}, {remarksByCourt:{"3":{items:rem2}}, miscTotalByCourt:{"3":12}, recalledPO:{"3_2":true}, boardByCourt:{"3":{court:"3",item:"2"}}, itemHi:{"3":12}});
  eq(k9.gap, 2, "recall round: on recalled 2, then 4, then ours 9 -> 2");
  const plan=ENG.passoverPlan({remarksByCourt:{"3":{items:rem2}}, miscTotalByCourt:{"3":12}, recalledPO:{"3_2":true}, itemHi:{"3":12}}, "3", {court:"3",item:"2"});
  eq([plan.at, plan.queue], ["now",[4,9]], "plan: being recalled now, queue 4 then 9");
  const plan2=ENG.passoverPlan({remarksByCourt:{"5":{items:{"3":"PASS OVER","1":"OVER","2":"OVER"}}}, miscTotalByCourt:{"5":40}, seqByCourt:{"5":"ITEM NOS.1 TO 10 THEN PASSOVERS AND THEN THE REST"}}, "5", {court:"5",item:"4"});
  eq([plan2.at, plan2.gap, plan2.after], ["sequence", 7, 10], "plan: after the announced sequence (after item 10), 7 to go");
  print(`D. parser/position spot checks: ${fails-f0} fails`);
}
print(`\nROUND 2 TOTAL: ${checks} checks, ${fails} fails`);
