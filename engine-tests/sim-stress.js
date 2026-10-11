// ---- STRESS simulator: many factors at once, randomly combined (jsc) ----
// The other simulators each isolate one feature. A real court day mixes them: an announced
// sequence that covers part of the list, the circular's order for the rest, a "23 WITH 58"
// link, fresh AND after-notice pass-overs, a typed-in pass-over, an item disposed out of
// turn, mentioning at the start, a Special Bench at 2 PM, a Regular-list matter, a
// time-fixed matter, a manual "over" mark, stray part keys, a NOT IN SESSION tick.
// Every tick, every tracked item: the engine's answer is cross-checked against the
// KNOWABLE truth (what a person in the room could say from the board + the published facts).
load("../board-engine.js"); const ENG = globalThis.BoardEngine;
let seed = 97531; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;
const pick = (arr, n) => { const a = arr.slice(), out = []; while (out.length < Math.min(n, a.length)) out.push(a.splice(ri(0, a.length - 1), 1)[0]); return out; };
const range = (a, b) => { const r = []; for (let k = a; k <= b; k++) r.push(k); return r; };

/* ---------- build one court-day from a random mix of factors ---------- */
function buildDay(F) {
  const M = F.M, S = F.S, aM = F.aM, aS = F.aS;
  const mainA = range(1, aM), mainB = range(aM + 1, M), suppA = range(M + 1, M + aS), suppB = range(M + aS + 1, M + S);
  const all = range(1, M + S);
  const part = {}; mainA.concat(suppA).forEach(n => part[n] = "A"); mainB.concat(suppB).forEach(n => part[n] = "B");
  const isB = n => part[n] === "B";
  // --- links: a sequence "X WITH Y" and/or a causelist "taken up along with" note
  const links = {};                                 // linked -> target (both called in one tick)
  let seqWith = null, noteWith = null, seqLinked = null;
  if (F.seqWith && F.seqMode !== "none") seqLinked = pick(all, 1)[0];          // target chosen once the declared part exists
  if (F.seqWith && F.seqMode === "none") { const t = pick(all, 1)[0], l = pick(all.filter(n => n !== t), 1)[0]; noteWith = [t, l]; links[l] = t; }  // no sequence to carry it: the causelist does
  if (F.noteWith && !noteWith) { const cands = all.filter(n => n !== seqLinked); const t = pick(cands, 1)[0]; const l = pick(cands.filter(n => n !== t), 1)[0]; if (t && l) { noteWith = [t, l]; links[l] = t; } }
  if (seqLinked != null && (seqLinked in links || Object.values(links).includes(seqLinked))) seqLinked = null;
  if (seqLinked != null) links[seqLinked] = -1;     // target filled in below
  const linked = new Set(Object.keys(links).map(Number));
  // --- out-of-turn disposal: an item marked OVER in the remark column before its turn
  const outOfTurn = F.outOfTurn ? pick(all.filter(n => !linked.has(n) && !Object.values(links).includes(n)), 1)[0] : null;
  const fixedItem = F.timeFixed ? pick(all.filter(n => !linked.has(n) && !Object.values(links).includes(n) && n !== outOfTurn), 1)[0] : null;
  // --- the court's TRUE order
  const circ = F.parts ? mainA.concat(suppA, mainB, suppB) : all.slice();
  let seqText = "", declared = [], order, passIdxDeclared = null;
  if (F.seqMode === "none") order = circ.filter(n => !linked.has(n));   // a linked item rides on its target: no slot of its own
  else {
    const pool = circ.filter(n => !linked.has(n));
    if (F.seqMode === "full") { const cuts = new Set(); while (cuts.size < 3) cuts.add(ri(1, pool.length - 1)); const cs = [0, ...[...cuts].sort((x, y) => x - y), pool.length];
      const blocks = []; for (let i = 0; i < cs.length - 1; i++) blocks.push(pool.slice(cs[i], cs[i + 1])); for (let i = blocks.length - 1; i > 0; i--) { const j = ri(0, i); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
      declared = blocks.flat(); }
    else { const a = ri(0, Math.max(0, pool.length - 6)), b = Math.min(pool.length - 1, a + ri(2, 9)); declared = pool.slice(a, b + 1); const c = ri(0, pool.length - 1), d = Math.min(pool.length - 1, c + ri(0, 5)); pool.slice(c, d + 1).forEach(n => { if (!declared.includes(n)) declared.push(n); }); }
    const rest = circ.filter(n => !declared.includes(n) && !linked.has(n));
    order = declared.concat(rest);
    // text: ranges; the WITH link printed right after the range that ends in its target
    // ("14 TO 23 WITH 58"), exactly as the court writes it; "PASSOVERS" marker sometimes
    const runs = []; for (let i = 0; i < declared.length;) { let j = i; while (j + 1 < declared.length && declared[j + 1] === declared[j] + 1) j++; runs.push([declared[i], declared[j]]); i = j + 1; }
    if (seqLinked != null) { const r0 = runs[0]; seqWith = [r0[1], seqLinked]; links[seqLinked] = r0[1]; if (Object.values(links).includes(r0[1]) && links[r0[1]] != null) { /* target can't itself be linked */ } }
    seqText = "SEQUENCE ITEM NOS. " + runs.map((r, i) => (r[0] === r[1] ? String(r[0]) : `${r[0]} TO ${r[1]}`) + (i === 0 && seqWith ? ` WITH ${seqWith[1]}` : "")).join(" ");
    if (F.seqMode === "blocks" && F.passMarker) { passIdxDeclared = declared.filter(n => n !== fixedItem).length; seqText += " PASS OVER IF ANY THEN REST OF THE MATTERS"; }
  }
  const beforeOut = outOfTurn != null ? order[order.indexOf(outOfTurn) - 1] : null;   // see runDay: that tick is unknowable
  order = order.filter(n => n !== outOfTurn && n !== fixedItem);
  // --- pass-overs (board remark or typed-in), plus a second pass-over of a fresh one
  const poCands = order.filter(n => !linked.has(n) && !Object.values(links).includes(n));
  const poSet = new Set(pick(poCands, F.nPO));
  const typedPO = new Set(F.typedPO ? pick([...poSet], 1) : []);
  const second = (F.second && F.parts && F.seqMode === "none") ? [...poSet].find(n => !isB(n)) ?? null : null;
  // recall points: announced marker -> after the declared part; circular (no seq) -> fresh POs
  // after Part A, after-notice at the end; otherwise end of list
  const ev = []; const pending = []; let flushedA = false;
  const recall = n => ev.push({ item: n, kind: n === second ? "po2" : "recall" });
  const flush = pred => { for (let i = 0; i < pending.length;) { if (pred(pending[i])) recall(pending.splice(i, 1)[0]); else i++; } };
  const freshEnd = F.parts ? aM + aS : null;
  for (let i = 0; i < order.length; i++) {
    const it = order[i];
    if (passIdxDeclared != null && i === passIdxDeclared) flush(() => true);
    if (F.seqMode === "none" && F.parts && isB(it) && !flushedA) { flushedA = true; flush(n => !isB(n)); }   // fresh POs come back as Part B begins
    if (poSet.has(it)) { ev.push({ item: it, kind: "po" }); pending.push(it); } else ev.push({ item: it, kind: "call" });
  }
  flush(() => true);
  if (second != null) ev.push({ item: second, kind: "recall2" });
  for (let r = 0; r < F.R; r++) ev.push({ item: 101 + r, kind: "call" });
  // --- interruptions: mentioning at the start, a special bench mid-day, an idle tick
  const ticks = [];
  if (F.mentioning) for (let k = 0; k < 3; k++) ticks.push({ board: String(801 + k), kind: "phase" });
  const sbAt = F.specialBench ? ri(Math.floor(ev.length * 0.3), Math.floor(ev.length * 0.7)) : -1;
  const idleAt = F.idle ? ri(1, ev.length - 2) : -1;
  ev.forEach((e, i) => {
    if (i === sbAt) { ticks.push({ board: "301", kind: "phase" }); ticks.push({ board: "302", kind: "phase" }); }
    if (i === idleAt) ticks.push({ board: String(e.item), kind: "idle" });
    ticks.push(Object.assign({ board: String(e.item) }, e));
  });
  const firstB = ev.findIndex(e => isB(e.item));
  return { F, ticks, ev, part, supp: suppA.concat(suppB), T: M + S, seqText, links, noteWith, outOfTurn, typedPO, second, firstB, freshEnd, order, fixedItem, beforeOut };
}

/* ---------- run the engine over the day and cross-check ---------- */
function runDay(day, log) {
  const court = "6", F = day.F;
  const remarks = {}, boardPO = {}, recalledPO = {}, itemHi = {};
  if (day.outOfTurn != null) remarks[day.outOfTurn] = "OVER";
  const fixedItem = day.fixedItem;
  const tracked = pick(range(1, day.T).filter(n => n !== fixedItem), Math.min(10, day.T)).concat(Object.keys(day.links).map(Number));
  if (F.R) tracked.push(101 + ri(0, F.R - 1));
  const doneItem = F.manualOver ? pick(tracked.filter(n => n < 100 && !(n in day.links)), 1)[0] : null;
  const sbItem = F.sbMatter ? 301 + ri(0, 2) : null;
  const miscParts = F.parts ? { [court]: { part: Object.fromEntries(Object.entries(day.part).map(([k, v]) => [String(k), v])), supp: day.supp.map(String) } } : {};
  if (F.parts && F.strays) { miscParts[court].part["670"] = "B"; miscParts[court].part["400"] = "A"; }
  const withItem = day.noteWith ? { [court + "_" + day.noteWith[1]]: String(day.noteWith[0]) } : {};
  const poMarks = {};
  const doneMarks = doneItem != null ? { [court + "_" + doneItem]: { v: "att" } } : {};
  const fixedTimes = fixedItem != null ? { [court + "_" + fixedItem]: "14:30" } : {};
  let bad = 0, total = 0, unscored = 0, secondPassed = false; const outstanding = new Set();
  let evIdx = 0;
  for (let t = 0; t < day.ticks.length; t++) {
    const tk = day.ticks[t];
    const isEvent = tk.kind !== "phase" && tk.kind !== "idle";
    if (isEvent) { if (tk.kind === "po") outstanding.add(tk.item); if (tk.kind === "po2") secondPassed = true; }
    // KNOWABLE remaining order from here: future POs look like calls (their recall doesn't
    // exist yet); recalls only of matters already outstanding; a discretionary recall only once
    // it is the current item; a typed-in PO looks the same as a board PO
    // Two readings of the remaining order. For a MISC matter the discretionary second recall is
    // unforeseeable (left out until it is on the board). For a REGULAR matter it still counts:
    // Misc business finishes before the Regular list begins, so that matter will be taken
    // somewhere before any Regular item — the engine's "Misc passovers" count is right there.
    const idx = {}, idxReg = {}; let pos = 0, posReg = 0;
    for (let j = evIdx; j < day.ev.length; j++) { const x = day.ev[j];
      if ((x.kind === "recall" || x.kind === "po2") && !outstanding.has(x.item)) continue;
      if (x.kind === "recall2" && j > evIdx) { if (secondPassed && outstanding.has(x.item)) posReg++; continue; }   // only once the second pass-over has actually happened
      if (x.kind === "po" && j > evIdx) { if (idx[x.item] == null) { idx[x.item] = pos; idxReg[x.item] = posReg; } pos++; posReg++; continue; }
      idx[x.item] = pos; idxReg[x.item] = posReg; pos++; posReg++; }
    if (isEvent && (tk.kind === "recall" || tk.kind === "recall2")) outstanding.delete(tk.item);
    const bc = { court, item: tk.board, status: tk.kind === "idle" ? "NOT IN SESSION" : "IN SESSION", passover: tk.kind === "po" || tk.kind === "po2" };
    if (isEvent && (tk.kind === "po" || tk.kind === "po2")) { if (day.typedPO.has(tk.item)) poMarks[court + "_" + tk.item] = { mode: "detail" }; else remarks[tk.item] = "PASS OVER"; }
    // app bookkeeping (recordBoardPO / noteItemHi, with the reserved-series guard)
    const outs = ENG.passoverItemsFor({ remarksByCourt: { [court]: { items: remarks } }, poMarks }, court);
    for (const key in boardPO) { const it = key.split("_")[1]; if (!(it in outs)) { delete boardPO[key]; recalledPO[key] = true; } }
    for (const n in outs) boardPO[court + "_" + n] = true;
    if (isEvent && (tk.kind === "recall" || tk.kind === "recall2")) { delete remarks[tk.item]; delete poMarks[court + "_" + tk.item]; delete boardPO[court + "_" + tk.item]; recalledPO[court + "_" + tk.item] = true; }
    const bn = parseInt(tk.board, 10); if (!isNaN(bn) && !ENG.isReservedItem(bn) && tk.kind !== "idle") itemHi[court] = Math.max(itemHi[court] || 0, bn);
    const ctx = { nowMins: 700, seqByCourt: day.seqText ? { [court]: day.seqText } : {}, remarksByCourt: { [court]: { items: { ...remarks } } },
      boardPO: { ...boardPO }, recalledPO: { ...recalledPO }, itemHi: { ...itemHi }, miscTotalByCourt: { [court]: day.T }, boardByCourt: { [court]: bc },
      poMarks: { ...poMarks }, doneMarks, fixedTimes, withItem, miscParts };
    // bench's intent unreadable here; likewise the one tick on the item just before a matter
    // disposed OUT OF TURN — from the board that looks exactly like the court having moved on
    const window = (secondPassed && evIdx < day.firstB) || (isEvent && tk.item === day.beforeOut);
    const check = (X, listType, truthFn, label) => {
      const k = ENG.classify({ courtNo: court, itemNo: String(X), listType }, bc, ctx);
      if (tk.kind === "phase" || tk.kind === "idle" || window) {
        // interruptions: invariants only — never "over", never a numeric distance from a phase number
        unscored++;
        const tgtX = day.links[X]; const overTruth = (tgtX != null ? idx[tgtX] : idx[X]) == null;
        if (tk.kind === "phase" && X < 100 && !overTruth && !k.done && (k.over || (k.gap != null && !k.ment && !k.special))) { bad++; total++; log.add(`  tick ${t} board ${tk.board}(${tk.kind}) ours=${X}: during a phase got ${JSON.stringify({ gap: k.gap, over: !!k.over, short: k.short })}`); }
        if (tk.kind === "idle" && k.over && !overTruth && !k.done) { bad++; total++; log.add(`  tick ${t} idle ours=${X}: 'over' while court not sitting`); }
        return;
      }
      total++;
      const r = truthFn(k);
      if (!r.ok) { bad++; log.add(`  [${label}] tick ${t} board ${tk.board}(${tk.kind}) ours=${X} truth=${r.truth} got=${JSON.stringify({ gap: k.gap, short: k.short, over: !!k.over, label: k.label })}`);
        if (globalThis.STRESS_DEBUG && !globalThis.__dumped) { globalThis.__dumped = true; print("DEBUG ---- family: " + globalThis.__fam + " | tick " + t + " board " + tk.board + "(" + tk.kind + ") ours=" + X + " truth=" + r.truth + " got gap=" + k.gap + " " + (k.label || ""));
          const eff = ENG.effSeq(ctx, court, day.seqText || "");
          print("DEBUG F=" + JSON.stringify(F)); print("DEBUG seqText=" + day.seqText); print("DEBUG links=" + JSON.stringify(day.links) + " noteWith=" + JSON.stringify(day.noteWith) + " fixed=" + day.fixedItem + " outOfTurn=" + day.outOfTurn + " typedPO=" + JSON.stringify([...day.typedPO]));
          print("DEBUG truth order=" + day.order.join(",")); print("DEBUG engine seq=" + eff.seq.join(",") + " circular=" + eff.circular + " passIdx=" + eff.passIdx);
          print("DEBUG withItem ctx=" + JSON.stringify(withItem) + " withMap=" + JSON.stringify(eff.withMap)); } }
    };
    const plainTruth = X => k => {
      // a user's own "over" mark — on the item, or on the item it is taken up with (linked
      // matters share fate: the mark on 43 covers "45 WITH 43")
      if (X === doneItem || day.links[X] === doneItem) return { ok: !!k.done && !!k.over, truth: "manual over" };
      if (X === day.second && secondPassed && evIdx >= day.firstB && outstanding.has(X)) return { ok: k.short === "2nd pass-over" && k.gap == null, truth: "2nd pass-over" };
      const tgt = day.links[X]; const m = X >= 101 ? idxReg : idx; const i = tgt != null ? m[tgt] : m[X];
      if (tgt != null && !(k.withItem === String(tgt))) return { ok: false, truth: `linked to ${tgt}` };
      if (i == null) return { ok: !!k.over || (k.gap != null && k.gap < 0), truth: "over" };
      return { ok: k.gap === i && !k.over, truth: i };
    };
    for (const X of tracked) check(X, X >= 101 ? "Regular" : "Miscellaneous", plainTruth(X), X >= 101 ? "regular" : "misc");
    if (fixedItem != null) check(fixedItem, "Miscellaneous", k => ({ ok: k.fixed === true && k.minsAway === 870 - 700, truth: "fixed 2:30 PM" }), "time-fixed");
    if (sbItem != null && tk.kind !== "phase" && tk.kind !== "idle") check(sbItem, "Miscellaneous", k => ({ ok: k.special === true && k.gap == null && !k.over, truth: "special bench, no distance" }), "special-bench");
    if (tk.board === "301" && sbItem != null) { const k = ENG.classify({ courtNo: court, itemNo: String(sbItem), listType: "Miscellaneous" }, bc, ctx); total++; const g = sbItem - 301; if (!(k.special && k.gap === g)) { bad++; log.add(`  tick ${t} board 301 ours=${sbItem}: expected series gap ${g}, got ${JSON.stringify({ gap: k.gap, short: k.short })}`); } }
    // progress-bar invariants: reach never beyond the list on a Misc item, never driven by a phase
    if (!isNaN(bn) && !ENG.isReservedItem(bn) && bn < 101 && tk.kind !== "idle") {
      const plan = ENG.passoverPlan(ctx, court, bc); const reach = ENG.reachOf(ctx, court, plan.seq || [], day.T, bc.item, plan.vacated);
      total++; if (!(reach >= 1 && reach <= Math.max(day.T, (plan.seq || []).length))) { bad++; log.add(`  tick ${t} board ${tk.board}: reach ${reach} outside 1..${day.T}`); }
      if (F.parts && !F.strays) { const co = ENG.circularOrder(ctx, court); total++; if ((co != null) !== F.parts) { bad++; log.add(`  tick ${t}: circular order ${co ? "on" : "OFF"} unexpectedly`); } }
      if (F.parts && F.strays) { const co = ENG.circularOrder(ctx, court); total++; if (!co) { bad++; log.add(`  tick ${t}: strays switched the circular order off`); } }
    }
    if (isEvent) { if (tk.kind === "call" || tk.kind === "recall" || tk.kind === "recall2") remarks[tk.item] = "OVER"; const tg = Object.keys(day.links).filter(l => day.links[l] === tk.item); if (tk.kind !== "po" && tk.kind !== "po2") tg.forEach(l => remarks[l] = "OVER"); evIdx++; }
  }
  return { bad, total, unscored };
}

/* ---------- families: each mixes several factors; the last mixes everything ---------- */
const families = [
  { name: "circular + supp + both POs", mk: () => ({ parts: true, seqMode: "none", S: ri(0, 10), nPO: ri(0, 6) }) },
  { name: "announced seq + circular rest", mk: () => ({ parts: true, seqMode: "blocks", passMarker: chance(.6), S: ri(0, 8), nPO: ri(0, 5) }) },
  { name: "full seq, no parts (pre-circular)", mk: () => ({ parts: false, seqMode: "full", S: 0, nPO: ri(0, 5) }) },
  { name: "links: WITH + causelist note", mk: () => ({ parts: chance(.5), seqMode: chance(.5) ? "blocks" : "none", passMarker: true, seqWith: true, noteWith: true, S: ri(0, 6), nPO: ri(0, 3) }) },
  { name: "interruptions: mentioning/special bench/idle", mk: () => ({ parts: true, seqMode: "none", mentioning: true, specialBench: true, idle: true, sbMatter: true, S: ri(0, 6), nPO: ri(0, 4) }) },
  { name: "regular + time-fixed + manual over", mk: () => ({ parts: chance(.5), seqMode: chance(.5) ? "blocks" : "none", passMarker: true, R: ri(1, 6), timeFixed: true, manualOver: true, S: ri(0, 5), nPO: ri(0, 4) }) },
  { name: "typed PO + out-of-turn OVER + strays", mk: () => ({ parts: true, seqMode: "none", typedPO: true, outOfTurn: true, strays: true, S: ri(0, 6), nPO: ri(2, 5) }) },
  { name: "second pass-over", mk: () => ({ parts: true, seqMode: "none", second: true, S: ri(0, 8), nPO: ri(2, 5) }) },
  { name: "EVERYTHING at once", mk: () => ({ parts: chance(.8), seqMode: ["none", "blocks", "full"][ri(0, 2)], passMarker: chance(.5), seqWith: chance(.6), noteWith: chance(.6), mentioning: chance(.5), specialBench: chance(.5), idle: chance(.5), sbMatter: chance(.5), R: chance(.6) ? ri(1, 5) : 0, timeFixed: chance(.6), manualOver: chance(.6), typedPO: chance(.5), outOfTurn: chance(.5), strays: chance(.5), second: chance(.4), S: ri(0, 10), nPO: ri(0, 6) }) },
];
let grand = 0, grandBad = 0, grandUn = 0; const allLogs = [];
for (const fam of families) {
  const log = { n: 0, max: 6, lines: [], add(l) { if (this.n++ < this.max) this.lines.push(l); } }; allLogs.push([fam.name, log]);
  globalThis.__fam = fam.name; globalThis.__dumped = false;
  let b = 0, t = 0, u = 0;
  for (let rep = 0; rep < 60; rep++) {
    const base = fam.mk();
    const M = ri(25, 70);
    const F = Object.assign({ M, S: 0, R: 0, nPO: 0 }, base);
    F.aM = F.parts ? ri(Math.floor(M * 0.35), Math.floor(M * 0.85)) : M; F.aS = F.parts && F.S ? ri(0, F.S) : F.S;
    if (!F.parts) { F.aM = M; F.aS = F.S; }
    if (F.seqMode === "full" && F.parts) F.parts = false;   // a full announced order needs no parts
    const day = buildDay(F);
    const r = runDay(day, log); b += r.bad; t += r.total; u += r.unscored;
  }
  print(`${fam.name.padEnd(44)} ${String(b).padStart(5)} / ${String(t).padStart(7)} mismatches   (${u} interruption/discretion ticks checked for invariants only)`);
  grand += t; grandBad += b; grandUn += u;
}
for (const [name, log] of allLogs) if (log.lines.length) { print("\nfirst mismatches — " + name + ":"); log.lines.forEach(l => print(l)); }
print(`\nSTRESS TOTAL ${grandBad} / ${grand}   (+${grandUn} invariant-only checks)`);
