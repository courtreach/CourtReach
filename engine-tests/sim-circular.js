// ---- circular F.No. 23/Judl./2026 (9 Oct 2026) day simulator + engine cross-check (jsc) ----
// Every Miscellaneous court takes: Part-A main, Part-A supplementary, fresh pass-overs,
// Part-B main, Part-B supplementary, after-notice pass-overs. A fresh matter passed over a
// SECOND time is at the bench's discretion — no estimate (owner, 11 Oct 2026).
// No announced sequence here: the engine must derive the order from ctx.miscParts alone.
load("../board-engine.js"); const ENG = globalThis.BoardEngine;
let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr, n) => { const a = arr.slice(), out = []; while (out.length < Math.min(n, a.length)) out.push(a.splice(ri(0, a.length - 1), 1)[0]); return out; };

function buildDay(o) {
  const M = o.M, S = o.S, aM = o.aM, aS = o.aS;
  const range = (a, b) => { const r = []; for (let k = a; k <= b; k++) r.push(k); return r; };
  const mainA = range(1, aM), mainB = range(aM + 1, M), suppA = range(M + 1, M + aS), suppB = range(M + aS + 1, M + S);
  const A = mainA.concat(suppA), B = mainB.concat(suppB);
  const part = {}; A.forEach(n => part[n] = "A"); B.forEach(n => part[n] = "B");
  const freshPO = new Set(pick(A, o.nF)), anPO = new Set(pick(B, o.nB));
  const second = (o.second && freshPO.size) ? [...freshPO][0] : null;
  const ev = []; const outA = [], outB = [];
  for (const n of A) { if (freshPO.has(n)) { ev.push({ item: n, kind: "po" }); outA.push(n); } else ev.push({ item: n, kind: "call" }); }
  for (const n of outA) ev.push(n === second ? { item: n, kind: "po2" } : { item: n, kind: "recall" });   // A3
  for (const n of B) { if (anPO.has(n)) { ev.push({ item: n, kind: "po" }); outB.push(n); } else ev.push({ item: n, kind: "call" }); }
  for (const n of outB) ev.push({ item: n, kind: "recall" });                                        // B3
  if (second != null) ev.push({ item: second, kind: "recall2" });                                    // A4, at discretion
  return { ev, part, supp: suppA.concat(suppB), T: M + S, second, firstB: ev.findIndex(e => part[e.item] === "B") };
}

function runDay(day, log) {
  const court = "7"; const remarks = {}, boardPO = {}, recalledPO = {}, itemHi = {};
  const miscParts = { [court]: { part: Object.fromEntries(Object.entries(day.part).map(([k, v]) => [String(k), v])), supp: day.supp.map(String) } };
  const targets = Object.keys(day.part).map(Number);
  let bad = 0, total = 0, unscored = 0;
  const outstanding = new Set(); let secondPassed = false;
  for (let i = 0; i < day.ev.length; i++) {
    const e = day.ev[i];
    if (e.kind === "po") outstanding.add(e.item);
    if (e.kind === "po2") secondPassed = true;
    // KNOWABLE remaining order from this tick: future pass-overs look like calls; recalls only of
    // matters already outstanding; a future second pass-over can't be foreseen (looks like its
    // A3 recall); the discretionary A4 recall doesn't exist yet.
    const idx = {}; let pos = 0;
    for (let j = i; j < day.ev.length; j++) { const x = day.ev[j];
      if ((x.kind === "recall" || x.kind === "po2") && !outstanding.has(x.item)) continue;
      if (x.kind === "recall2" && j > i) continue;      // the discretionary recall can't be foreseen — but once it IS the current item, it is on now
      if (x.kind === "po" && j > i) { if (idx[x.item] == null) idx[x.item] = pos; pos++; continue; }
      idx[x.item] = pos; pos++; }
    if (e.kind === "recall" || e.kind === "recall2") outstanding.delete(e.item);
    const bc = { court, item: String(e.item), status: "IN SESSION", passover: e.kind === "po" || e.kind === "po2" };
    if (e.kind === "po" || e.kind === "po2") remarks[e.item] = "PASS OVER";
    // app bookkeeping (recordBoardPO / noteItemHi)
    const outs = ENG.passoverItemsFor({ remarksByCourt: { [court]: { items: remarks } } }, court);
    for (const key in boardPO) { const it = key.split("_")[1]; if (!(it in outs)) { delete boardPO[key]; recalledPO[key] = true; } }
    for (const n in outs) boardPO[court + "_" + n] = true;
    if (e.kind === "recall" || e.kind === "recall2") { delete remarks[e.item]; delete boardPO[court + "_" + e.item]; recalledPO[court + "_" + e.item] = true; }
    itemHi[court] = Math.max(itemHi[court] || 0, e.item);
    const ctx = { nowMins: 700, seqByCourt: {}, remarksByCourt: { [court]: { items: { ...remarks } } }, boardPO: { ...boardPO },
      recalledPO: { ...recalledPO }, itemHi: { ...itemHi }, miscTotalByCourt: { [court]: day.T }, boardByCourt: { [court]: bc },
      poMarks: {}, doneMarks: {}, miscParts };
    // Between the second pass-over (at A3) and the first after-notice call the court's intent is
    // genuinely unreadable from the board (it looks like an unrecalled fresh pass-over) — those
    // ticks are not scored.
    const window = secondPassed && i < day.firstB;
    for (const X of targets) {
      const k = ENG.classify({ courtNo: court, itemNo: String(X), listType: "Miscellaneous" }, bc, ctx);
      if (window) { unscored++; continue; }
      total++;
      let ok;
      if (X === day.second && secondPassed && i >= day.firstB && outstanding.has(X)) ok = k.short === "2nd pass-over" && k.gap == null;
      else if (idx[X] == null) ok = !!k.over || (k.gap != null && k.gap < 0);
      else ok = k.gap === idx[X] && !k.over;
      if (!ok) { bad++; if (log.n < log.max) { log.n++; log.lines.push(`  tick ${i} on ${e.item}(${e.kind}) ours=${X} truth=${idx[X] ?? "over"} got=${JSON.stringify({ gap: k.gap, short: k.short, over: !!k.over, label: k.label })}`); } }
    }
    if (e.kind === "call" || e.kind === "recall" || e.kind === "recall2") remarks[e.item] = "OVER";
  }
  return { bad, total, unscored };
}

let grand = 0, grandBad = 0, grandUn = 0; const log = { n: 0, max: 12, lines: [] };
const shapes = [
  { name: "no supp, no PO", M: 40, S: 0, nF: 0, nB: 0, second: false },
  { name: "supp both parts", M: 45, S: 8, nF: 0, nB: 0, second: false },
  { name: "fresh POs", M: 50, S: 6, nF: 4, nB: 0, second: false },
  { name: "AN POs", M: 50, S: 6, nF: 0, nB: 3, second: false },
  { name: "both POs", M: 55, S: 10, nF: 5, nB: 4, second: false },
  { name: "2nd pass-over", M: 50, S: 8, nF: 4, nB: 3, second: true },
];
for (const sh of shapes) {
  let b = 0, t = 0, u = 0;
  for (let rep = 0; rep < 40; rep++) {
    const aM = ri(Math.floor(sh.M * 0.4), Math.floor(sh.M * 0.85));
    const aS = sh.S ? ri(0, sh.S) : 0;
    const day = buildDay({ M: sh.M, S: sh.S, aM, aS, nF: sh.nF, nB: sh.nB, second: sh.second });
    const r = runDay(day, log); b += r.bad; t += r.total; u += r.unscored;
  }
  print(`${sh.name.padEnd(18)} ${String(b).padStart(5)} / ${String(t).padStart(7)} mismatches` + (u ? `   (${u} unscored: 2nd pass-over window)` : ""));
  grand += t; grandBad += b; grandUn += u;
}
if (log.lines.length) { print("first mismatches:"); log.lines.forEach(l => print(l)); }
print(`\nCIRCULAR TOTAL ${grandBad} / ${grand}`);
