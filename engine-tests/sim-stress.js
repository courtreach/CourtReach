// ---- STRESS simulator: many factors at once, randomly combined (jsc) ----
// The other simulators each isolate one feature. A real court day mixes them: an announced
// sequence that covers part of the list, the circular's order for the rest, a "23 WITH 58"
// link, fresh AND after-notice pass-overs, a typed-in pass-over, an item disposed out of
// turn, mentioning at the start, a Special Bench at 2 PM, a Regular-list matter, a
// time-fixed matter, a manual "over" mark, stray part keys, a NOT IN SESSION tick — and, since
// sweep 3, the things the real record shows: a remark column that is thin or lags the board,
// every remark wording the operator writes, a Regular-hearing day with no Misc list, the
// court's own sequence wordings (through the marquee splitter), two pass-over markers, a time
// fixed inside the sequence line, sub-items on the board, "after item X" marks, phases of
// every reserved series, a blank board, a missing court row, a missing causelist.
// Every tick, every tracked item: the engine's answer is cross-checked against the
// KNOWABLE truth (what a person in the room could say from the board + the published facts).
//
// Run: jsc sim-stress.js            (all families; must print STRESS TOTAL 0)
//      globals: STRESS_SEED, STRESS_REPS (days per family, default 60), STRESS_ONLY="<family
//      substring>", STRESS_DEBUG=true (dumps the first failing day of each family),
//      STRESS_BASELINE=true (the original nine families only)
load("../board-engine.js"); const ENG = globalThis.BoardEngine;
let seed = globalThis.STRESS_SEED || 97531; const REPS = globalThis.STRESS_REPS || 60; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;
const pick = (arr, n) => { const a = arr.slice(), out = []; while (out.length < Math.min(n, a.length)) out.push(a.splice(ri(0, a.length - 1), 1)[0]); return out; };
const range = (a, b) => { const r = []; for (let k = a; k <= b; k++) r.push(k); return r; };

// what the display-board operator writes against a finished matter (worker's parseRemarks keeps
// OVER / PASS OVER / PART HEARD / DISPOSED and any other short remark verbatim)
// (measured on the live board, 12 Oct 2026: "OVER (Dismissed)", "OVER (List On (Date): 27-11-2026)",
// "OVER (Leave Granted / Rule NISI / Appeal Admitted)", "OVER (Disposed off)", "OVER (List After
// (Weeks): 3)", "OVER (Notice Returnable: D:0,W:0,M:0)", "PASS OVER", "HEARING" on the current item)
const VOCAB = ["OVER", "OVER", "OVER", "OVER (Dismissed)", "OVER (List On (Date): 27-11-2026)", "OVER (Leave Granted / Rule NISI / Appeal Admitted)", "OVER (Disposed off)", "OVER (List After (Weeks): 3)", "OVER (Notice Returnable: D:0,W:0,M:0)", "DISPOSED", "DISMISSED", "ADJOURNED", "LIST ON 15.10.2026", "HEARD", "ORDER RESERVED", "ALLOWED", "WITHDRAWN", "PART HEARD", "NOT PRESSED"];

/* ---------- the court's sequence line, in the wordings the Supreme Court actually publishes ---------- */
function renderSeq(F, segs, withPairs, fixedNote) {
  const st = F.textStyle || 0;
  const prefix = ["SEQUENCE ITEM NOS. ", "SEQUENCE WOULD BE ITEM NOS.", "Seq.Item Nos.", "Todays Sequence ", "sequence item nos. ", "SEQUENCE "][st];
  const rangeF = [(a, b) => `${a} TO ${b}`, (a, b) => `${a} TO ${b}`, (a, b) => `${a} to ${b}`, (a, b) => `${a}-${b}`, (a, b) => `${a} T ${b}`, (a, b) => `${a} TO ${b}`][st];
  const singleF = [n => `${n}`, n => (chance(.3) ? `ITEM NO. ${n}` : `${n}`), n => (chance(.3) ? `item no.${n}` : `${n}`), n => `${n}`, n => `${n}`, n => `${n}`][st];
  const marker1 = ["PASS OVER IF ANY", "PASSOVER IF ANY THEREAFTER", "passovers", "PO IF ANY", "fresh passover", "PASS OVER"][st];
  const marker2 = ["PASS OVER IF ANY", "PASSOVER IF ANY", "passovers", "po if any", "passover if any", "AND PASS OVER MATTERS"][st];
  const suffix = ["", " THEN REST OF THE MATTERS", " THEREAFTER AS PER LIST", " ONWARDS AS PER CAUSELIST", ".", " spl bench at 3pm"][st];
  const runsOf = items => { const runs = []; for (let i = 0; i < items.length;) { let j = i; while (j + 1 < items.length && items[j + 1] === items[j] + 1) j++; runs.push([items[i], items[j]]); i = j + 1; } return runs; };
  const withFor = end => { const w = withPairs.filter(p => p[0] === end); return w.length ? " " + (st >= 2 ? "with" : "WITH") + " " + w.map(p => p[1]).join(` ${st >= 2 ? "with" : "WITH"} `) : ""; };
  const parts = [];
  for (const sg of segs) {
    if (sg.kind === "marker") { parts.push(sg.n === 1 ? marker1 : marker2); continue; }
    const txt = runsOf(sg.items).map(r => (r[0] === r[1] ? singleF(r[0]) : rangeF(r[0], r[1])) + withFor(r[1])).join(" ");
    if (txt) parts.push(txt);
  }
  let text = prefix + parts.join(" ") + suffix;
  if (fixedNote) text += [" ITEM " + fixedNote[0] + " AT 2.30 PM", " item no " + fixedNote[0] + " at 2.30pm", " and item " + fixedNote[0] + " at 2.30 pm"][ri(0, 2)];
  return text;
}

/* ---------- build one court-day from a random mix of factors ---------- */
function buildDay(F) {
  const regOnly = !!F.regOnly;
  const M = F.M, S = F.S, aM = F.aM, aS = F.aS, R = F.R;
  const mainA = range(1, aM), mainB = range(aM + 1, M), suppA = range(M + 1, M + aS), suppB = range(M + aS + 1, M + S);
  const regs = range(101, 100 + R);
  const all = regOnly ? regs : range(1, M + S);          // the list the court works through
  const part = {}; mainA.concat(suppA).forEach(n => part[n] = "A"); mainB.concat(suppB).forEach(n => part[n] = "B");
  const isB = n => part[n] === "B";
  // --- links: a sequence "X WITH Y" (one or two) and/or a causelist "taken up along with" note
  const links = {};                                 // linked -> target (both called in one tick)
  let seqWith = null, noteWith = null, seqLinked = null, seqLinked2 = null;
  if (F.seqWith && F.seqMode !== "none") seqLinked = pick(all, 1)[0];          // target chosen once the declared part exists
  if (F.seqWith && F.seqMode === "none") { const t = pick(all, 1)[0], l = pick(all.filter(n => n !== t), 1)[0]; noteWith = [t, l]; links[l] = t; }  // no sequence to carry it: the causelist does
  if (F.twoSeqWith && seqLinked != null) seqLinked2 = pick(all.filter(n => n !== seqLinked), 1)[0] ?? null;
  if (F.noteWith && !noteWith) { const cands = all.filter(n => n !== seqLinked && n !== seqLinked2); const t = pick(cands, 1)[0]; const l = pick(cands.filter(n => n !== t), 1)[0]; if (t && l) { noteWith = [t, l]; links[l] = t; } }
  let noteWith2 = null;   // a second matter to be taken up with the SAME target
  if (F.twoLinks && noteWith) { const l2 = pick(all.filter(n => n !== noteWith[0] && !(n in links) && n !== seqLinked && n !== seqLinked2), 1)[0]; if (l2) { noteWith2 = [noteWith[0], l2]; links[l2] = noteWith[0]; } }
  if (seqLinked != null && (seqLinked in links || Object.values(links).includes(seqLinked))) seqLinked = null;
  if (seqLinked2 != null && (seqLinked2 in links || Object.values(links).includes(seqLinked2) || seqLinked == null)) seqLinked2 = null;
  if (seqLinked != null) links[seqLinked] = -1;     // target filled in below
  if (seqLinked2 != null) links[seqLinked2] = -1;
  const linked = new Set(Object.keys(links).map(Number));
  const isTarget = n => Object.values(links).includes(n);
  // --- out-of-turn disposal: an item marked OVER in the remark column before its turn
  const outOfTurn = F.outOfTurn ? pick(all.filter(n => !linked.has(n) && !isTarget(n)), 1)[0] : null;
  const fixedItem = F.timeFixed ? pick(all.filter(n => !linked.has(n) && !isTarget(n) && n !== outOfTurn), 1)[0] : null;
  // --- the court's TRUE order
  const circ = (F.parts && !regOnly) ? mainA.concat(suppA, mainB, suppB) : all.slice();
  let seqText = "", declared = [], order, markerPts = [];   // markerPts: indices into the full order where recalls are flushed
  const segs = [];                                           // what the sequence line says, in order
  if (F.seqMode === "none") order = circ.filter(n => !linked.has(n));   // a linked item rides on its target: no slot of its own
  else {
    const pool = circ.filter(n => !linked.has(n));
    if (F.seqMode === "suppFirst") { declared = pool.filter(n => n > M).concat(pool.filter(n => n <= M).slice(0, ri(2, 6))); }
    else if (F.seqMode === "full") { const cuts = new Set(); while (cuts.size < Math.min(3, pool.length - 1)) cuts.add(ri(1, pool.length - 1)); const cs = [0, ...[...cuts].sort((x, y) => x - y), pool.length];
      const blocks = []; for (let i = 0; i < cs.length - 1; i++) blocks.push(pool.slice(cs[i], cs[i + 1])); for (let i = blocks.length - 1; i > 0; i--) { const j = ri(0, i); [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; }
      declared = blocks.flat(); }
    else { const a = ri(0, Math.max(0, pool.length - 6)), b = Math.min(pool.length - 1, a + ri(2, 9)); declared = pool.slice(a, b + 1); const c = ri(0, pool.length - 1), d = Math.min(pool.length - 1, c + ri(0, 5)); pool.slice(c, d + 1).forEach(n => { if (!declared.includes(n)) declared.push(n); }); }
    // a time fixed INSIDE the sequence line: that item is named with its time, not in a run
    if (F.seqFixed && fixedItem != null) declared = declared.filter(n => n !== fixedItem);
    // the WITH links: the first (and second) run's last item is the target
    const withPairs = [];
    const runsOf = items => { const runs = []; for (let i = 0; i < items.length;) { let j = i; while (j + 1 < items.length && items[j + 1] === items[j] + 1) j++; runs.push([items[i], items[j]]); i = j + 1; } return runs; };
    const runs = runsOf(declared);
    if (seqLinked != null && runs.length) { seqWith = [runs[0][1], seqLinked]; links[seqLinked] = runs[0][1]; withPairs.push([runs[0][1], seqLinked]); }
    else if (seqLinked != null) { delete links[seqLinked]; linked.delete(seqLinked); seqLinked = null; }
    if (seqLinked2 != null && runs.length > 1 && runs[1][1] !== seqLinked) { links[seqLinked2] = runs[1][1]; withPairs.push([runs[1][1], seqLinked2]); } else if (seqLinked2 != null) { delete links[seqLinked2]; linked.delete(seqLinked2); }
    const marker = (F.seqMode === "blocks" || F.seqMode === "suppFirst") && F.passMarker;
    if (F.twoMarkers && marker && R > 0 && !regOnly) {
      // "2 TO 13 FRESH PASSOVER 101 TO 120 PASSOVER IF ANY 14 15": block A, its pass-overs,
      // the Regular block, pass-overs since, then block B
      const cut = Math.max(1, Math.floor(declared.length / 2));
      const A = declared.slice(0, cut), B = declared.slice(cut);
      segs.push({ kind: "items", items: A }, { kind: "marker", n: 1 }, { kind: "items", items: regs }, { kind: "marker", n: 2 }, { kind: "items", items: B });
      declared = A.concat(regs, B);
      markerPts.push(A.length, A.length + regs.length);
    } else {
      // Regular items named INSIDE the announced order, before "PASS OVER" (the engine's
      // poException): the court takes them where announced, Misc pass-overs no longer come first
      if (F.regInSeq && R && !regOnly) declared = regs.concat(declared);
      segs.push({ kind: "items", items: declared });
      if (marker) { segs.push({ kind: "marker", n: 1 }); markerPts.push(declared.length); }
    }
    const rest = circ.filter(n => !declared.includes(n) && !linked.has(n));
    order = declared.concat(rest);
    const fixedNote = (F.seqFixed && fixedItem != null) ? [fixedItem] : null;
    const text = renderSeq(F, segs, withPairs, fixedNote);
    // through the marquee splitter, with other courts' lines around it, exactly as the board publishes
    const marquee = (F.neighbours ? "Court C2: SEQUENCE 1 TO 10 PASS OVER IF ANY 11 TO 20 " : "") + "Court C6: " + text + (F.neighbours ? " Court C9: Sequence would be item nos.1 to 25 56 to 59 PO if any item no.26 onwards as per causelist" : "");
    seqText = (F.textStyle != null || F.neighbours) ? (ENG.parseSequenceLine(marquee)["6"] || "") : text;
  }
  const beforeOut = outOfTurn != null ? order[order.indexOf(outOfTurn) - 1] : null;   // see runDay: that tick is unknowable
  const ootLater = !!(F.ootBoard && outOfTurn != null);
  // markers are indices into the order the court actually walks (no fixed item, no pre-disposed out-of-turn item)
  const dropped = n => n === fixedItem || (n === outOfTurn && !ootLater);
  const markerIdx = markerPts.map(pt => order.slice(0, pt).filter(n => !dropped(n)).length);
  order = order.filter(n => !dropped(n));
  // --- pass-overs (board remark or typed-in), plus a second pass-over of a fresh one
  const firstMarker = markerIdx.length ? markerIdx[0] : null;
  let poCands = order.filter(n => !linked.has(n) && !isTarget(n));
  if (F.poBeforeMarkerOnly) poCands = firstMarker != null ? poCands.filter(n => order.indexOf(n) < firstMarker) : [];
  const poSet = new Set(pick(poCands, F.nPO));
  const typedPO = new Set(F.typedPO ? pick([...poSet], 1) : []);
  const second = (F.second && F.parts && F.seqMode === "none") ? [...poSet].find(n => !isB(n)) ?? null
    : F.secondNoParts ? ([...poSet][0] ?? null) : null;
  // a typed "after item X" mark on one pass-over: it comes back right after X is called
  const afterMap = {};
  if (F.afterMark && poSet.size) {
    const p = [...poSet].find(n => n !== second);
    if (p != null) { const pi = order.indexOf(p); const xs = order.slice(pi + 1).filter(n => !poSet.has(n) && !linked.has(n) && !isTarget(n) && n !== outOfTurn); const X = xs.length ? xs[ri(0, Math.min(xs.length - 1, 8))] : null; if (X != null) afterMap[p] = X; }
  }
  // recall points: announced marker(s) -> flush there; circular (no seq) -> fresh POs after
  // Part A, after-notice at the end; otherwise end of list
  const ev = []; const pending = []; let flushedA = false;
  const recall = n => ev.push({ item: n, kind: n === second ? "po2" : "recall" });
  const flush = pred => { for (let i = 0; i < pending.length;) { if (pred(pending[i])) recall(pending.splice(i, 1)[0]); else i++; } };
  const freshEnd = (F.parts && !regOnly) ? aM + aS : null;
  for (let i = 0; i < order.length; i++) {
    const it = order[i];
    if (markerIdx.includes(i)) flush(n => afterMap[n] == null);
    if (F.seqMode === "none" && F.parts && !regOnly && isB(it) && !flushedA) { flushedA = true; flush(n => !isB(n) && afterMap[n] == null); }   // fresh POs come back as Part B begins
    if (it === outOfTurn) { ev.push({ item: it, kind: "call", oot: true }); continue; }   // ootLater only: dropped from the truth once called out of turn
    if (poSet.has(it)) { ev.push({ item: it, kind: "po" }); pending.push(it); } else ev.push({ item: it, kind: "call" });
    flush(n => afterMap[n] === it);                       // "after item X": X was just called
  }
  flush(() => true);
  if (second != null) ev.push({ item: second, kind: "recall2" });
  if (!regOnly) for (let r = 0; r < R; r++) if (!order.includes(101 + r)) ev.push({ item: 101 + r, kind: "call" });
  // --- interruptions: mentioning at the start, a special bench mid-day, an idle tick, other phases
  const ticks = [];
  if (F.mentioning) for (let k = 0; k < 3; k++) ticks.push({ board: String(801 + k), kind: "phase" });
  const sbAt = F.specialBench ? ri(Math.floor(ev.length * 0.3), Math.floor(ev.length * 0.7)) : -1;
  const idleAt = F.idle ? ri(1, Math.max(1, ev.length - 2)) : -1;
  const blankAt = F.blankIdle ? ri(1, Math.max(1, ev.length - 2)) : -1;        // board blank, NOT IN SESSION
  const absentAt = F.absent ? ri(1, Math.max(1, ev.length - 2)) : -1;          // the court's row missing from the board
  const pronAt = F.pron ? ri(1, Math.max(1, ev.length - 2)) : -1;              // 1501: judgment pronouncement
  const singleAt = F.single ? ri(1, Math.max(1, ev.length - 2)) : -1;          // 1601: Single Judge matters
  const chamberAt = F.chamber ? ri(1, Math.max(1, ev.length - 2)) : -1;        // 1701: Chamber matters
  // the out-of-turn matter is CALLED at some moment (shown on the board, then OVER) — not a
  // remark that was simply there from the start
  const ootIdx = ev.findIndex(e => e.oot);
  // before its own slot, and at least three slots ahead of the court's in-order progress: an
  // item called one or two slots early cannot be told from a remark column that lags the board
  // by an item or two, and the engine deliberately reads it as in order (reachInfo tolerance)
  let ootAt = -1;
  if (ootLater) for (let tries = 0; tries < 30 && ootAt < 0; tries++) {
    const c = ri(1, Math.max(1, Math.min(ootIdx, ev.length - 3))), pe = ev[c - 1];
    // (after a CALL, so the remark column already shows a finished matter — the engine judges order only then)
    const callsBefore = ev.slice(0, c).filter(x => x.kind === "call" && !x.oot).length;   // the column must already vouch for three finished matters
    // the engine's rule (reachInfo): ten complete positions vouch for a jump of five slots
    const jump = order.indexOf(outOfTurn) - order.indexOf(pe.item);
    if (pe.kind === "call" && !pe.oot && callsBefore >= 10 && jump >= 5) ootAt = c;
  }
  ev.forEach((e, i) => {
    if (i === ootAt) ticks.push({ board: String(outOfTurn), kind: "oot", item: outOfTurn });
    if (e.oot && ootAt >= 0) { ticks.push(Object.assign({ board: String(e.item), skip: true }, e)); return; }
    if (i === sbAt) { ticks.push({ board: "301", kind: "phase" }); ticks.push({ board: "302", kind: "phase" }); }
    if (i === pronAt) ticks.push({ board: "1501", kind: "phase" });
    if (i === singleAt) { ticks.push({ board: "1601", kind: "phase" }); ticks.push({ board: "1602", kind: "phase" }); }
    if (i === chamberAt) ticks.push({ board: "1701", kind: "phase" });
    if (i === idleAt) ticks.push({ board: String(e.item), kind: "idle" });
    if (i === blankAt) ticks.push({ board: "", kind: "idle" });
    if (i === absentAt) ticks.push({ board: "", kind: "absent" });
    ticks.push(Object.assign({ board: String(e.item) }, e));
  });
  const firstB = ev.findIndex(e => isB(e.item));
  return { F, ticks, ev, part, supp: suppA.concat(suppB), T: M + S, R, regOnly, seqText, links, noteWith, noteWith2, outOfTurn, typedPO, second, firstB, freshEnd, order, fixedItem, beforeOut, ootLater, afterMap, markerIdx };
}

/* ---------- run the engine over the day and cross-check ---------- */
function runDay(day, log) {
  const court = "6", F = day.F;
  const remarks = {}, boardPO = {}, recalledPO = {}, itemHi = {}, seen = [];
  const density = F.density == null ? 1 : F.density, lag = F.lag || 0;
  const finished = () => F.vocab ? VOCAB[ri(0, VOCAB.length - 1)] : "OVER";
  const rkey = it => (F.subItems && chance(.2)) ? it + ".1" : String(it);   // the operator sometimes marks the sub-item row
  // the remark column: a finished matter gets its remark with probability `density`, `lag`
  // ticks after it was called (visible from the following tick when lag is 0)
  const remQ = [];
  const post = (it, t) => { if (F.noRemarks) return; if (chance(density)) remQ.push({ at: t + lag, item: it, rem: finished() }); };
  const ended = () => { let r = finished(); while (/part\s*heard/i.test(r)) r = finished(); return r; };   // an out-of-turn matter was DISPOSED of, not part heard
  if (day.outOfTurn != null && !day.ootLater && !F.noRemarks) remarks[day.outOfTurn] = ended();
  const fixedItem = day.fixedItem;
  const tracked = pick(range(1, day.T).filter(n => n !== fixedItem), Math.min(10, day.T)).concat(Object.keys(day.links).map(Number));
  if (day.R) tracked.push(...pick(range(101, 100 + day.R).filter(n => n !== fixedItem && !(n in day.links)), day.regOnly ? Math.min(8, day.R) : 1));
  const doneItem = F.manualOver ? pick(tracked.filter(n => (n in day.part) && !(n in day.links)), 1)[0] : null;
  const sbItem = F.sbMatter ? 301 + ri(0, 2) : null;
  const miscParts = (F.parts && !day.regOnly) ? { [court]: { part: Object.fromEntries(Object.entries(day.part).map(([k, v]) => [String(k), v])), supp: day.supp.map(String) } } : {};
  if (F.parts && F.strays && miscParts[court]) { miscParts[court].part["670"] = "B"; miscParts[court].part["400"] = "A"; }
  if (F.partsGap && miscParts[court]) { const ks = Object.keys(miscParts[court].part).map(Number).sort((a, b) => a - b); for (const k of pick(ks.slice(0, Math.max(1, ks.length - 4)), ri(1, 3))) delete miscParts[court].part[String(k)]; }   // the causelist parse missed an item (below the top: a missing tail is not a gap)
  const withItem = day.noteWith ? { [court + "_" + day.noteWith[1]]: String(day.noteWith[0]) } : {};
  if (day.noteWith2) withItem[court + "_" + day.noteWith2[1]] = String(day.noteWith2[0]);
  const poMarks = {};
  const doneMarks = doneItem != null ? { [court + "_" + doneItem]: { v: "att" } } : {};
  // the fixed time: from the causelist / typed in (ctx.fixedTimes), or ONLY from the sequence line
  const fixedTimes = (fixedItem != null && !(F.seqFixed && !F.ctxFixed)) ? { [court + "_" + fixedItem]: "14:30" } : {};
  let bad = 0, total = 0, unscored = 0, secondPassed = false, ootDone = false, progressIdx = -1; const outstanding = new Set();
  let evIdx = 0;
  for (let t = 0; t < day.ticks.length; t++) {
    const tk = day.ticks[t];
    for (const q of remQ) if (!q.done && q.at < t) { q.done = true; if (remarks[q.item] !== "PASS OVER") remarks[rkey(q.item)] = q.rem; }
    const isEvent = tk.kind !== "phase" && tk.kind !== "idle" && tk.kind !== "oot" && tk.kind !== "absent";
    if (tk.skip) { evIdx++; continue; }   // the out-of-turn matter's own slot, already taken
    if (isEvent) { if (tk.kind === "po") outstanding.add(tk.item); if (tk.kind === "po2") { secondPassed = true; outstanding.add(tk.item); } }
    // KNOWABLE remaining order from here: future POs look like calls (their recall doesn't
    // exist yet); recalls only of matters already outstanding; a discretionary recall only once
    // it is the current item; a typed-in PO looks the same as a board PO
    // Two readings of the remaining order. For a MISC matter the discretionary second recall is
    // unforeseeable (left out until it is on the board). For a REGULAR matter it still counts:
    // Misc business finishes before the Regular list begins, so that matter will be taken
    // somewhere before any Regular item — the engine's "Misc passovers" count is right there.
    // An item's truth is its NEXT appearance from here (first occurrence wins): a future
    // pass-over looks like a call at its slot; an outstanding one is its recall; one being
    // passed over right now (first or second time) is its next recall, not "now".
    const idx = {}, idxReg = {}; let pos = 0, posReg = 0;
    const set = x => { if (idx[x.item] == null) { idx[x.item] = pos; idxReg[x.item] = posReg; } };
    for (let j = evIdx; j < day.ev.length; j++) { const x = day.ev[j];
      if (x.oot) { if (ootDone) continue; }   // the out-of-turn matter: an ordinary future call until the court takes it
      if ((x.kind === "recall" || x.kind === "po2" || x.kind === "recall2") && !outstanding.has(x.item)) continue;
      if (x.kind === "recall2" && j > evIdx) {
        if (!F.secondNoParts) { if (secondPassed && outstanding.has(x.item)) posReg++; continue; }   // circular: the second recall is at the bench's discretion — unforeseeable
        if (!secondPassed) continue; }                                                              // no circular: foreseeable (back at the end) only once the second pass-over has happened
      if (j === evIdx && (x.kind === "po" || x.kind === "po2")) { pos++; posReg++; continue; }   // being passed over now: its truth is its next recall
      set(x); pos++; posReg++; }
    if (isEvent && (tk.kind === "recall" || tk.kind === "recall2")) outstanding.delete(tk.item);
    if (isEvent && tk.oot && ootDone) { evIdx++; continue; }
    const subNow = F.subItems && isEvent && tk.kind === "call" && chance(.25);
    const bc = tk.kind === "absent" ? null : { court, item: tk.board + (subNow ? ".1" : ""), status: (tk.kind === "idle") ? "NOT IN SESSION" : "IN SESSION", passover: tk.kind === "po" || tk.kind === "po2" };
    // a court with NO remark column: pass-overs are known only from the board row's own
    // "passed over" flag (boardPO), never from remarks; nothing is ever marked OVER
    if (isEvent && (tk.kind === "po" || tk.kind === "po2")) {
      if (tk.kind === "po2") recalledPO[court + "_" + tk.item] = true;   // the app saw the court call it again before passing it over again (recordBoardPO)
      if (day.typedPO.has(tk.item) || F.noRemarks) poMarks[court + "_" + tk.item] = { mode: "detail" }; else remarks[tk.item] = "PASS OVER";
      if (day.afterMap[tk.item] != null) { poMarks[court + "_" + tk.item] = { mode: "after", after: String(day.afterMap[tk.item]) }; }
    }
    // app bookkeeping (recordBoardPO / noteItemHi, with the reserved-series guard)
    const outs = ENG.passoverItemsFor({ remarksByCourt: { [court]: { items: remarks } } }, court);   // as the app's recordBoardPO: the remark column only
    for (const key in boardPO) { const it = key.split("_")[1]; if (!(it in outs)) { delete boardPO[key]; recalledPO[key] = (poMarks[key] && poMarks[key].mode === "after") ? { after: true } : true; } }
    for (const n in outs) boardPO[court + "_" + n] = true;
    if (isEvent && (tk.kind === "recall" || tk.kind === "recall2")) { const key = court + "_" + tk.item; const wasAfter = !!(poMarks[key] && poMarks[key].mode === "after"); delete remarks[tk.item]; delete remarks[tk.item + ".1"]; delete poMarks[key]; delete boardPO[key]; recalledPO[key] = wasAfter ? { after: true } : true; }
    const bn = parseInt(tk.board, 10); if (!isNaN(bn) && !ENG.isReservedItem(bn) && tk.kind !== "idle" && tk.kind !== "absent") { itemHi[court] = Math.max(itemHi[court] || 0, bn); if (F.seen && bc) seen.push(bc.item); }   // the oot item latches itemHi too — as it would in the app
    const remNow = { ...remarks }; if (isEvent && tk.kind === "call" && !F.noRemarks && chance(.7)) remNow[tk.item] = "HEARING";   // the live column marks the item on now
    const ctx = { nowMins: 700, seqByCourt: day.seqText ? { [court]: day.seqText } : {}, remarksByCourt: { [court]: { items: remNow } },
      boardPO: { ...boardPO }, recalledPO: { ...recalledPO }, itemHi: { ...itemHi }, boardByCourt: bc ? { [court]: bc } : {},
      miscTotalByCourt: (day.regOnly || F.noTotal) ? {} : { [court]: day.T }, regTotalByCourt: (F.regTotalKnown && day.R > 0) ? { [court]: day.R } : {},   // (the app passes a size only for a list that exists)
      seenItems: F.seen ? { [court]: seen.slice() } : {},
      poMarks: { ...poMarks }, doneMarks, fixedTimes, withItem, miscParts };
    // bench's intent unreadable here; likewise the one tick on the item just before a matter
    // disposed OUT OF TURN — from the board that looks exactly like the court having moved on;
    // and, without board history, the one or two ticks where a matter taken out of turn earlier
    // sits one or two slots ahead of the court (its latched item number reads as reach, within
    // the engine's deliberate lag tolerance)
    if (isEvent && (tk.kind === "call" || tk.kind === "po")) progressIdx = Math.max(progressIdx, day.order.indexOf(tk.item));   // the court's in-order progress (a recall dip does not move it)
    const ootAhead = ootDone && !F.seen && isEvent && day.order.indexOf(day.outOfTurn) > progressIdx && day.order.indexOf(day.outOfTurn) - progressIdx <= 7;
    const window = (secondPassed && !F.secondNoParts && evIdx < day.firstB) || (isEvent && tk.item === day.beforeOut)
      || (F.noRemarks && isEvent && (tk.kind === "recall" || tk.kind === "recall2" || tk.kind === "po2")) || ootAhead || F.invariantsOnly
      || ((lag > 0 || density < 1) && !F.seen && isEvent && (tk.kind === "recall" || tk.kind === "recall2" || tk.kind === "po2"));   // a thin or lagging column, no board history: the items before a recall dip are unknowable
    const isReg = X => X >= 101 && !(X in day.part);
    const check = (X, listType, truthFn, label) => {
      let k;
      try { k = ENG.classify({ courtNo: court, itemNo: String(X), listType }, bc, ctx); }
      catch (e) { bad++; total++; log.add(`  tick ${t} board ${tk.board}(${tk.kind}) ours=${X}: ENGINE THREW ${e}`); return; }
      if (tk.kind === "phase" || tk.kind === "idle" || tk.kind === "oot" || tk.kind === "absent" || window) {
        // interruptions: invariants only — never "over", never a numeric distance from a phase number
        unscored++;
        const tgtX = day.links[X]; const overTruth = (tgtX != null ? idx[tgtX] : idx[X]) == null;
        if (tk.kind === "phase" && !isReg(X) && !overTruth && !k.done && (k.over || (k.gap != null && !k.ment && !k.special))) { bad++; total++; log.add(`  tick ${t} board ${tk.board}(${tk.kind}) ours=${X}: during a phase got ${JSON.stringify({ gap: k.gap, over: !!k.over, short: k.short })}`); }
        if ((tk.kind === "idle" || tk.kind === "absent") && k.over && !overTruth && !k.done) { bad++; total++; log.add(`  tick ${t} ${tk.kind} ours=${X}: 'over' while court not sitting / not on the board`); }
        // the court is on a matter taken OUT OF TURN: nothing still to come may be called over
        if (tk.kind === "oot" && !isReg(X) && !overTruth && !k.done && k.over) { bad++; total++; log.add(`  tick ${t} board ${tk.board}(out of turn) ours=${X}: called 'over' while the court is on an out-of-turn matter`);
          if (globalThis.STRESS_DEBUG && globalThis.__dumped !== globalThis.__fam) { globalThis.__dumped = globalThis.__fam; print("DEBUG OOT F=" + JSON.stringify(F) + " seq=" + day.seqText + " order=" + day.order.join(",") + " links=" + JSON.stringify(day.links) + " got=" + JSON.stringify(k));
            const ef = ENG.effSeq(ctx, court, day.seqText); print("DEBUG remarks=" + JSON.stringify(ctx.remarksByCourt[court].items) + " poMarks=" + JSON.stringify(ctx.poMarks) + " boardPO=" + JSON.stringify(ctx.boardPO) + " itemHi=" + JSON.stringify(ctx.itemHi) + " doneMarks=" + JSON.stringify(ctx.doneMarks) + " seq=" + ef.seq.join(",") + " full=" + ef.full + " ri=" + JSON.stringify(ENG.reachInfo(ctx, court, ef.seq, day.T, bc.item, ef.vacated)) + " t=" + t + " evIdx=" + evIdx + " ticks=" + day.ticks.map(x => x.kind + (x.skip ? "skip" : "") + ":" + x.board).join(" ")); } }
        return;
      }
      total++;
      const r = truthFn(k);
      if (!r.ok) { bad++; log.add(`  [${label}] tick ${t} board ${bc.item}(${tk.kind}) ours=${X} truth=${r.truth} got=${JSON.stringify({ gap: k.gap, short: k.short, over: !!k.over, label: k.label })}`);
        if (globalThis.STRESS_DEBUG && globalThis.__dumped !== globalThis.__fam) { globalThis.__dumped = globalThis.__fam; print("DEBUG ---- family: " + globalThis.__fam + " | tick " + t + " board " + bc.item + "(" + tk.kind + ") ours=" + X + " truth=" + r.truth + " got gap=" + k.gap + " " + (k.label || ""));
          const eff = ENG.effSeq(ctx, court, day.seqText || "");
          print("DEBUG F=" + JSON.stringify(F)); print("DEBUG seqText=" + day.seqText); print("DEBUG links=" + JSON.stringify(day.links) + " noteWith=" + JSON.stringify(day.noteWith) + " fixed=" + day.fixedItem + " outOfTurn=" + day.outOfTurn + " typedPO=" + JSON.stringify([...day.typedPO]) + " afterMap=" + JSON.stringify(day.afterMap) + " markers=" + JSON.stringify(day.markerIdx));
          print("DEBUG truth order=" + day.order.join(",")); print("DEBUG engine seq=" + eff.seq.join(",") + " circular=" + eff.circular + " passIdx=" + eff.passIdx + " passIdxs=" + JSON.stringify(eff.passIdxs) + " full=" + eff.full);
          print("DEBUG withItem ctx=" + JSON.stringify(withItem) + " withMap=" + JSON.stringify(eff.withMap) + " fixedTimes=" + JSON.stringify(fixedTimes) + " totals=" + JSON.stringify([ctx.miscTotalByCourt, ctx.regTotalByCourt]));
          print("DEBUG remarks=" + JSON.stringify(ctx.remarksByCourt[court].items) + " poMarks=" + JSON.stringify(ctx.poMarks) + " boardPO=" + JSON.stringify(ctx.boardPO) + " recalledPO=" + JSON.stringify(ctx.recalledPO) + " itemHi=" + JSON.stringify(ctx.itemHi) + " seen=" + JSON.stringify(ctx.seenItems));
          print("DEBUG plan=" + JSON.stringify(ENG.passoverPlan(ctx, court, bc), (kk, v) => (kk === "seq" || kk === "vacated") ? undefined : v) + " reach=" + JSON.stringify(ENG.reachInfo(ctx, court, eff.seq, (day.regOnly || F.noTotal) ? null : day.T, bc.item, eff.vacated))); } }
    };
    const plainTruth = X => k => {
      // a user's own "over" mark — on the item, or on the item it is taken up with (linked
      // matters share fate: the mark on 43 covers "45 WITH 43")
      if (X === doneItem || day.links[X] === doneItem) return { ok: !!k.done && !!k.over, truth: "manual over" };
      if (day.links[X] === fixedItem) return { ok: k.fixed === true, truth: "fixed (with the time-fixed item)" };   // "13 WITH 14", 13 fixed at 2:30: 14 goes with it
      if (X === day.second && !F.secondNoParts && secondPassed && evIdx >= day.firstB && outstanding.has(X)) return { ok: k.short === "2nd pass-over" && k.gap == null, truth: "2nd pass-over" };
      const tgt = day.links[X]; const m = (isReg(X) && !day.regOnly) ? idxReg : idx; const i = tgt != null ? m[tgt] : m[X];
      if (tgt != null && !(k.withItem === String(tgt))) return { ok: false, truth: `linked to ${tgt}` };
      if (i == null) return { ok: !!k.over || (k.gap != null && k.gap < 0), truth: "over" };
      return { ok: k.gap === i && !k.over, truth: i };
    };
    for (const X of tracked) check(X, isReg(X) ? "Regular" : "Miscellaneous", plainTruth(X), isReg(X) ? "regular" : "misc");
    if (fixedItem != null) check(fixedItem, isReg(fixedItem) ? "Regular" : "Miscellaneous", k => ({ ok: k.fixed === true && k.minsAway === 870 - 700, truth: "fixed 2:30 PM" }), "time-fixed");
    if (sbItem != null && tk.kind !== "phase" && tk.kind !== "idle" && tk.kind !== "absent") check(sbItem, "Miscellaneous", k => ({ ok: k.special === true && k.gap == null && !k.over, truth: "special bench, no distance" }), "special-bench");
    if (tk.board === "301" && sbItem != null) { const k = ENG.classify({ courtNo: court, itemNo: String(sbItem), listType: "Miscellaneous" }, bc, ctx); total++; const g = sbItem - 301; if (!(k.special && k.gap === g)) { bad++; log.add(`  tick ${t} board 301 ours=${sbItem}: expected series gap ${g}, got ${JSON.stringify({ gap: k.gap, short: k.short })}`); } }
    // progress-bar invariants: reach never beyond the list on a Misc item, never driven by a phase
    if (bc && !isNaN(bn) && !ENG.isReservedItem(bn) && bn < 101 && tk.kind !== "idle") {
      const plan = ENG.passoverPlan(ctx, court, bc); const reach = ENG.reachOf(ctx, court, plan.seq || [], F.noTotal ? null : day.T, bc.item, plan.vacated);
      const regsIn = (plan.seq || []).filter(n => n >= 101).length;   // Regular items announced inside the order take positions too
      total++; if (!(reach >= 1 && reach <= Math.max(day.T + regsIn, (plan.seq || []).length))) { bad++; log.add(`  tick ${t} board ${tk.board}: reach ${reach} outside 1..${day.T + regsIn}`); }
      if (F.parts && !F.strays && !F.partsGap) { const co = ENG.circularOrder(ctx, court); total++; if ((co != null) !== F.parts) { bad++; log.add(`  tick ${t}: circular order ${co ? "on" : "OFF"} unexpectedly`); } }
      if (F.parts && F.strays) { const co = ENG.circularOrder(ctx, court); total++; if (!co) { bad++; log.add(`  tick ${t}: strays switched the circular order off`); } }
      if (F.partsGap) { const co = ENG.circularOrder(ctx, court); total++; if (co) { bad++; log.add(`  tick ${t}: circular order ON despite a gap in the part data`); } }
    }
    if (tk.kind === "oot") { ootDone = true; remQ.push({ at: t + lag, item: tk.item, rem: ended() }); }
    if (isEvent) { if (tk.kind === "call" || tk.kind === "recall" || tk.kind === "recall2") post(tk.item, t); const tg = Object.keys(day.links).filter(l => day.links[l] === tk.item); if (tk.kind !== "po" && tk.kind !== "po2") tg.forEach(l => post(Number(l), t)); evIdx++; }
  }
  return { bad, total, unscored };
}

/* ---------- families: each mixes several factors; the last ones mix everything ---------- */
const anyMode = () => ["none", "blocks", "full"][ri(0, 2)];
const families = [
  { name: "circular + supp + both POs", mk: () => ({ parts: true, seqMode: "none", S: ri(0, 10), nPO: ri(0, 6) }) },
  { name: "announced seq + circular rest", mk: () => ({ parts: true, seqMode: "blocks", passMarker: chance(.6), S: ri(0, 8), nPO: ri(0, 5) }) },
  { name: "full seq, no parts (pre-circular)", mk: () => ({ parts: false, seqMode: "full", S: 0, nPO: ri(0, 5) }) },
  { name: "links: WITH + causelist note", mk: () => ({ parts: chance(.5), seqMode: chance(.5) ? "blocks" : "none", passMarker: true, seqWith: true, noteWith: true, S: ri(0, 6), nPO: ri(0, 3) }) },
  { name: "interruptions: mentioning/special bench/idle", mk: () => ({ parts: true, seqMode: "none", mentioning: true, specialBench: true, idle: true, sbMatter: true, S: ri(0, 6), nPO: ri(0, 4) }) },
  { name: "regular + time-fixed + manual over", mk: () => ({ parts: chance(.5), seqMode: chance(.5) ? "blocks" : "none", passMarker: true, R: ri(1, 6), timeFixed: true, manualOver: true, S: ri(0, 5), nPO: ri(0, 4) }) },
  { name: "typed PO + out-of-turn OVER + strays", mk: () => ({ parts: true, seqMode: "none", typedPO: true, outOfTurn: true, strays: true, S: ri(0, 6), nPO: ri(2, 5) }) },
  { name: "second pass-over", mk: () => ({ parts: true, seqMode: "none", second: true, S: ri(0, 8), nPO: ri(2, 5) }) },
  { name: "EVERYTHING at once", mk: () => ({ parts: chance(.8), seqMode: anyMode(), passMarker: chance(.5), seqWith: chance(.6), noteWith: chance(.6), mentioning: chance(.5), specialBench: chance(.5), idle: chance(.5), sbMatter: chance(.5), R: chance(.6) ? ri(1, 5) : 0, timeFixed: chance(.6), manualOver: chance(.5), typedPO: chance(.5), outOfTurn: chance(.5), strays: chance(.5), second: chance(.5), S: ri(0, 10), nPO: ri(0, 6) }) },
];
const sweep2 = [
  { name: "S2 big Misc list (100-130 items)", mk: () => ({ big: true, parts: true, seqMode: chance(.5) ? "none" : "blocks", passMarker: chance(.5), S: ri(0, 12), nPO: ri(0, 6) }) },
  { name: "S2 out-of-turn item SHOWN on the board", mk: () => ({ parts: chance(.6), seqMode: chance(.5) ? "none" : "blocks", passMarker: true, outOfTurn: true, ootBoard: true, S: ri(0, 6), nPO: ri(0, 4), R: chance(.5) ? ri(1, 3) : 0 }) },
  { name: "S2 no remark column (board PO flag only)", mk: () => ({ noRemarks: true, parts: chance(.6), seqMode: chance(.5) ? "none" : "blocks", passMarker: chance(.5), S: ri(0, 6), nPO: ri(2, 5), R: chance(.5) ? ri(1, 3) : 0 }) },
  { name: "S2 supplementary-first announced order", mk: () => ({ parts: true, seqMode: "suppFirst", passMarker: chance(.6), S: ri(3, 10), nPO: ri(0, 4) }) },
  { name: "S2 two matters linked to one target", mk: () => ({ noteWith: true, twoLinks: true, parts: chance(.6), seqMode: chance(.5) ? "none" : "blocks", passMarker: true, S: ri(0, 5), nPO: ri(0, 3) }) },
  { name: "S2 Regular items inside the announced order", mk: () => ({ regInSeq: true, R: ri(2, 4), parts: chance(.5), seqMode: "blocks", passMarker: true, S: ri(0, 5), nPO: ri(1, 4) }) },
  { name: "S2 full announced order + part data", mk: () => ({ fullWithParts: true, parts: true, seqMode: "full", S: ri(0, 6), nPO: ri(0, 4) }) },
  { name: "S2 EVERYTHING (sweep-2 factors too)", mk: () => ({ parts: chance(.8), seqMode: ["none", "blocks", "full", "suppFirst"][ri(0, 3)], passMarker: chance(.5), seqWith: chance(.5), noteWith: chance(.6), twoLinks: chance(.5), mentioning: chance(.4), specialBench: chance(.5), idle: chance(.5), sbMatter: chance(.4), R: chance(.5) ? ri(1, 4) : 0, regInSeq: chance(.4), timeFixed: chance(.5), manualOver: chance(.5), typedPO: chance(.5), outOfTurn: chance(.6), ootBoard: chance(.6), noRemarks: chance(.3), strays: chance(.5), second: chance(.4), S: ri(0, 10), nPO: ri(0, 6), fullWithParts: true }) },
];
const sweep3 = [
  { name: "S3 thin remark column (30-70% of matters marked)", mk: () => ({ density: [0.3, 0.5, 0.7][ri(0, 2)], seen: chance(.5), vocab: chance(.5), parts: chance(.6), seqMode: anyMode(), passMarker: chance(.6), S: ri(0, 6), nPO: ri(0, 4), R: chance(.5) ? ri(1, 3) : 0 }) },
  { name: "S3 remark column lags the board by 1-2 items", mk: () => ({ lag: ri(1, 2), seen: chance(.5), parts: chance(.6), seqMode: anyMode(), passMarker: chance(.6), S: ri(0, 6), nPO: ri(1, 5), R: chance(.5) ? ri(1, 3) : 0 }) },
  { name: "S3 every remark wording + sub-items on the board", mk: () => ({ vocab: true, subItems: true, parts: chance(.6), seqMode: anyMode(), passMarker: chance(.6), S: ri(0, 6), nPO: ri(0, 4), R: chance(.5) ? ri(1, 3) : 0 }) },
  { name: "S3 Regular-hearing day (no Misc list at all)", mk: () => ({ regOnly: true, R: ri(15, 35), seqMode: chance(.5) ? "none" : "blocks", passMarker: chance(.7), nPO: ri(0, 4), regTotalKnown: chance(.6), vocab: chance(.5), idle: chance(.3), textStyle: chance(.5) ? ri(0, 5) : null }) },
  { name: "S3 the court's own sequence wordings (marquee split)", mk: () => ({ textStyle: ri(0, 5), neighbours: chance(.6), parts: chance(.5), seqMode: chance(.6) ? "blocks" : "full", passMarker: chance(.7), seqWith: chance(.4), twoSeqWith: chance(.5), S: ri(0, 6), nPO: ri(0, 4), R: chance(.3) ? ri(1, 3) : 0 }) },
  { name: "S3 two pass-over markers around a Regular block", mk: () => ({ twoMarkers: true, R: ri(2, 8), seqMode: "blocks", passMarker: true, parts: chance(.5), nPO: ri(1, 5), S: ri(0, 5), textStyle: ri(0, 5) }) },
  { name: "S3 a time fixed inside the sequence line", mk: () => ({ seqFixed: true, timeFixed: true, ctxFixed: chance(.5), seqMode: chance(.6) ? "blocks" : "full", passMarker: chance(.6), parts: chance(.5), S: ri(0, 5), nPO: ri(0, 4), textStyle: ri(0, 5) }) },
  { name: "S3 'after item X' marks + second pass-over, no parts", mk: () => ({ afterMark: true, typedPO: chance(.5), secondNoParts: chance(.6), parts: false, seqMode: chance(.5) ? "none" : "blocks", passMarker: chance(.6), S: ri(0, 5), nPO: ri(2, 5) }) },
  { name: "S3 phases of every series, blank board, court row missing", mk: () => ({ pron: true, single: chance(.7), chamber: chance(.7), blankIdle: true, absent: true, mentioning: chance(.5), specialBench: chance(.5), parts: chance(.6), seqMode: anyMode(), passMarker: chance(.5), S: ri(0, 6), nPO: ri(0, 4) }) },
  { name: "S3 no list size (causelist missing)", mk: () => ({ noTotal: true, poBeforeMarkerOnly: true, parts: false, seqMode: chance(.6) ? "blocks" : "full", passMarker: true, S: 0, nPO: ri(0, 4), R: 0 }) },
  { name: "S3 incomplete part data (circular must switch off)", mk: () => ({ partsGap: true, invariantsOnly: true, parts: true, seqMode: chance(.5) ? "none" : "blocks", passMarker: chance(.5), S: ri(0, 6), nPO: ri(0, 4) }) },
  { name: "S3 board history + everything", mk: () => ({ seen: true, vocab: chance(.5), subItems: chance(.5), parts: chance(.8), seqMode: ["none", "blocks", "full", "suppFirst"][ri(0, 3)], passMarker: chance(.5), seqWith: chance(.5), noteWith: chance(.6), twoLinks: chance(.4), mentioning: chance(.4), specialBench: chance(.5), idle: chance(.5), sbMatter: chance(.4), R: chance(.5) ? ri(1, 4) : 0, regInSeq: chance(.3), timeFixed: chance(.5), manualOver: chance(.5), typedPO: chance(.5), outOfTurn: chance(.6), ootBoard: chance(.6), strays: chance(.4), second: chance(.4), S: ri(0, 10), nPO: ri(0, 6), fullWithParts: true, textStyle: chance(.5) ? ri(0, 5) : null, neighbours: chance(.4), afterMark: chance(.3), pron: chance(.3), blankIdle: chance(.3), absent: chance(.3) }) },
  { name: "S3 EVERYTHING (all three sweeps)", mk: () => ({ density: chance(.4) ? [0.3, 0.5, 0.7][ri(0, 2)] : 1, lag: chance(.3) ? ri(1, 2) : 0, seen: chance(.5), vocab: chance(.5), subItems: chance(.4), parts: chance(.8), seqMode: ["none", "blocks", "full", "suppFirst"][ri(0, 3)], passMarker: chance(.5), seqWith: chance(.5), twoSeqWith: chance(.4), noteWith: chance(.6), twoLinks: chance(.4), mentioning: chance(.4), specialBench: chance(.5), idle: chance(.5), sbMatter: chance(.4), R: chance(.5) ? ri(1, 4) : 0, regInSeq: chance(.3), twoMarkers: chance(.3), timeFixed: chance(.5), seqFixed: chance(.4), ctxFixed: chance(.5), manualOver: chance(.5), typedPO: chance(.5), afterMark: chance(.3), outOfTurn: chance(.6), ootBoard: chance(.6), noRemarks: chance(.2), strays: chance(.4), second: chance(.4), secondNoParts: chance(.3), S: ri(0, 10), nPO: ri(0, 6), fullWithParts: true, textStyle: chance(.6) ? ri(0, 5) : null, neighbours: chance(.4), pron: chance(.3), single: chance(.3), chamber: chance(.3), blankIdle: chance(.3), absent: chance(.3), noTotal: chance(.15), regTotalKnown: chance(.6) }) },
];
if (!globalThis.STRESS_BASELINE) families.push(...sweep2, ...sweep3);
if (globalThis.STRESS_ONLY) families.splice(0, families.length, ...families.filter(f => f.name.includes(globalThis.STRESS_ONLY)));

// factors that cannot be combined — the truth would not be knowable from the board at all
function reconcile(F) {
  if (F.big) F.R = 0;                                                  // 101+ would collide with the Misc numbers
  if (F.regOnly) { F.parts = false; F.S = 0; F.M = 0; F.big = false; F.regInSeq = false; F.twoMarkers = false; F.outOfTurn = false; F.ootBoard = false; F.second = false; F.noTotal = false; F.manualOver = false; F.sbMatter = false; F.timeFixed = false; F.seqFixed = false; }
  if (F.noRemarks) { F.ootBoard = false; F.outOfTurn = false; F.vocab = false; }   // without a remark column the engine can never learn an out-of-turn disposal
  if ((F.density != null && F.density < 1) || F.lag) { F.ootBoard = false; F.outOfTurn = false; }   // a thin or lagging column cannot vouch for an out-of-turn matter
  if (F.twoMarkers) { if (F.seqMode !== "blocks" || !F.R) F.twoMarkers = false; else { F.passMarker = true; F.regInSeq = false; } }
  if (F.regInSeq && F.seqMode !== "blocks") F.regInSeq = false;
  if (F.seqFixed) { F.timeFixed = true; if (F.seqMode === "none") F.seqFixed = false; }
  if (F.noTotal) { F.parts = false; F.poBeforeMarkerOnly = true; F.passMarker = true; if (F.seqMode === "none") F.seqMode = "blocks"; F.R = 0; F.regInSeq = false; F.twoMarkers = false; F.second = false; F.secondNoParts = false; }   // no list size: nothing that comes back "at the end" can be placed
  if (F.partsGap) { F.parts = true; F.invariantsOnly = true; F.strays = false; if (F.seqMode === "full") F.seqMode = "blocks"; }
  if (F.regOnly && !F.regTotalKnown) { F.poBeforeMarkerOnly = true; if (!F.passMarker || F.seqMode === "none") F.nPO = 0; }
  if (F.secondNoParts) { F.parts = false; F.second = false; }
  if (F.second && !(F.parts && F.seqMode === "none")) F.second = false;
  if (F.afterMark && F.nPO < 1) F.nPO = 1;
  return F;
}

let grand = 0, grandBad = 0, grandUn = 0; const allLogs = [];
for (const fam of families) {
  const log = { n: 0, max: 6, lines: [], add(l) { if (this.n++ < this.max) this.lines.push(l); } }; allLogs.push([fam.name, log]);
  globalThis.__fam = fam.name; globalThis.__dumped = false;
  let b = 0, t = 0, u = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const base = fam.mk();
    const M = base.big ? ri(100, 130) : ri(25, 70);
    const F = reconcile(Object.assign({ M, S: 0, R: 0, nPO: 0 }, base));
    F.aM = (F.parts && !F.regOnly) ? ri(Math.floor(F.M * 0.35), Math.floor(F.M * 0.85)) : F.M; F.aS = F.parts && F.S ? ri(0, F.S) : F.S;
    if (!F.parts) { F.aM = F.M; F.aS = F.S; }
    if (F.seqMode === "full" && F.parts && !F.fullWithParts) F.parts = false;   // (sweep 2 keeps them: the engine must ignore them)
    const day = buildDay(F);
    const r = runDay(day, log); b += r.bad; t += r.total; u += r.unscored;
  }
  print(`${fam.name.padEnd(58)} ${String(b).padStart(5)} / ${String(t).padStart(7)} mismatches   (${u} interruption/discretion ticks checked for invariants only)`);
  grand += t; grandBad += b; grandUn += u;
}
for (const [name, log] of allLogs) if (log.lines.length) { print("\nfirst mismatches — " + name + ":"); log.lines.forEach(l => print(l)); }
print(`\nSTRESS TOTAL ${grandBad} / ${grand}   (+${grandUn} invariant-only checks)`);
