/* ============================================================================
   SD Chamber Display Board — PURE proximity engine (shared, server-ready)
   ----------------------------------------------------------------------------
   This is board.html's classify()/seq/order/passover logic with EVERY global it
   used to reach for lifted into an explicit `ctx`. Same maths, no DOM, no
   Firestore, no globals — so the identical file can run in the browser (thin
   client) AND inside the Cloudflare worker (/compute), and be unit-tested in
   isolation. It is deliberately byte-faithful to the live engine; a cross-check
   harness (board-engine-check) diffs it against the running board.html to prove
   they never disagree before anything ships.

   ctx (all optional; missing → treated as empty):
     nowMins          int    minutes-into-day IST (was nowMinsIST())
     seqByCourt       {court: "raw sequence text"}      (marquee, ?seq)
     remarksByCourt   {court: {items:{item: "OVER"|"PASS OVER"|…}}}
     poMarks          {"court_item": {mode,after,…}|null}   already date-filtered
     doneMarks        {"court_item": {v:"att"|"abs",…}|null} already date-filtered
     boardPO          {"court_item": true}                   currently outstanding, live-observed
     recalledPO       {"court_item": true}                   confirmed recalled earlier today —
                                                               tells classify() a court's passover
                                                               queue is already moving, not merely
                                                               declared
     itemHi           {court: highestRawItemSeenToday}
     miscTotalByCourt {court: int|null}   Misc list size (caller precomputes; null = no Misc list / unknown)
     regTotalByCourt  {court: int|null}   Regular list size (items 101..100+N) — where a Regular
                                           pass-over comes back when nothing was announced
     boardByCourt     {court: bcRow}      the parsed board keyed by court
     fixedTimes       {"court_item": "HH:MM" | minutes}  a matter the court has fixed for a
                                                          particular time — no sequence applies
                                                          to it, so it is measured in minutes
     specialBenches   [{venue, after:[courts], at, judges}]  a special bench's own sitting
                                                          rule — "after the normal work of Courts
                                                          4, 10 & 16 is over" — used to measure
                                                          its matters (300s) from those courts
     miscParts        {court: {part:{item:"A"|"B"}, supp:[items]}}  Misc list Part-A (fresh) /
                                                          Part-B (after notice) and which items
                                                          are supplementary — the circular's
                                                          default call order (9 Oct 2026)
     dropped          {"court_item": {to, reason}}  the causelist's DROP NOTE: deleted from today's
                                                     list (or shifted) — no slot, and the matter
                                                     itself reads "deleted"
     withItem         {"court_item": "otherItem"}  the CAUSELIST's own word that this item
                                                     will be heard together with a different
                                                     item in the same court ("TO BE TAKEN UP
                                                     ALONG WITH ITEM NO. 23") — not a
                                                     passover, nothing typed in; classify()
                                                     measures the matter as if it WERE that
                                                     other item
   ============================================================================ */
(function (root) {
  "use strict";
  const MENT_END = 640;          // 10:40 IST — mentioning done
  const REG_BASE = 101;          // Regular list numbered 101+
  /* RESERVED item numbers are court PHASES, never positions in the Miscellaneous / Regular
     call order: the 300s are Special Bench (always time-fixed, or "after the normal work of
     the court is over"), the 800s mentioning, 1500s pronouncement, 1600s Single Judge, 1700s
     Chamber. The numbered lists top out well below 300 (highest seen in a real causelist:
     226). Anything that does arithmetic on item numbers must skip these. */
  const isSpecialBenchItem = n => n >= 300 && n < 400;
  const isReservedItem = n => isSpecialBenchItem(n) || n >= 800;
  const poKey = (court, item) => String(court) + "_" + String(item);

  // ---- pure sequence maths (identical to board.html) ----
  function isMentioning(item) { const s = String(item || "").trim(); return s !== "" && !/^\d/.test(s); }

  function seqInfo(text) {
    if (!text) return { seq: [], passIdx: null, passIdxs: [], withMap: {}, fixed: {} };
    // A number written hard against the word before it — "Item Nos.1 to 4", "item no.6
    // onwards" — is how the Supreme Court actually writes these lines, and it used to cost us
    // the number entirely: "NOS.1" matches nothing numeric, so the token was skipped, and
    // with the 1 gone "1 TO 4" degraded to a bare "TO 4". Court 12's real line, "Seq. Item
    // Nos.1 to 4 51 to 55 5 to 50...", therefore parsed with items 1, 2 and 3 missing. The
    // court was ON item 1, so item 1 fell into the unlisted "rest of the matters" tail at
    // position 58 while our item 9 sat at position 10 — a gap of MINUS 48, which the board
    // then reported as the matter being behind the court. It was 13 away.
    // Split only a digit that follows a LETTER (optionally through a full stop). A digit
    // after a digit is a sub-item — 62.1 — and must survive untouched.
    const norm = String(text)
      .replace(/(\d)\s*[-–—]\s*(\d)/g, "$1 TO $2")
      .replace(/([A-Za-z])\.?(\d)/g, "$1 $2");
    const toks = norm.toUpperCase().replace(/[^0-9A-Z. ]/g, " ").split(/\s+/).filter(Boolean)
      .map(t => /^\d/.test(t) ? t : t.replace(/\.+$/, ""));   // "FRESH PASSOVER." closes the sentence too
    const out = [], seen = new Set(); let passIdx = null; const passIdxs = [];
    // "ITEM 41 AT 2 PM", "item no 1 at 12pm", "item 16 at 3.30 pm": the court has FIXED a time
    // for that item inside the sequence line itself — it holds no slot in the order (taken at
    // its time), and classify() measures it in minutes. Three of the owner's samples do this.
    const fixed = {};
    const clockOf = (a, b) => {
      const m = String(a || "").match(/^(\d{1,2})(?:\.(\d{2}))?([AP])?\.?M?\.?$/); if (!m) return null;
      let ap = m[3]; if (!ap) { const mb = /^([AP])\.?M\.?$/.exec(b || ""); if (!mb) return null; ap = mb[1]; }
      let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0; if (h > 12 || mi > 59) return null;
      if (ap === "P" && h < 12) h += 12; if (ap === "A" && h === 12) h = 0;
      return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi;
    };
    const withMap = {};   // {"58": "23"} — heard TOGETHER with the item that precedes "WITH",
                           // not a separate call-order position of its own (real example,
                           // Court 1's own published sequence today: "...14 TO 23 WITH 58...").
    const push = n => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t === "PASSOVER" || t === "PASSOVERS" || t === "PO" || (t === "PASS" && (toks[i + 1] === "OVER" || toks[i + 1] === "OVERS"))) {
        // every marker — "2 TO 13 FRESH PASSOVER 101 TO 120 PASSOVER IF ANY 14 15" has two: the
        // fresh pass-overs come back at the first, anything passed over later at the next
        if (passIdx == null) passIdx = out.length;
        if (!passIdxs.length || passIdxs[passIdxs.length - 1] !== out.length) passIdxs.push(out.length);
      }
      if (t === "AT" && /^\d/.test(toks[i - 1] || "") && clockOf(toks[i + 1], toks[i + 2])) {
        const it = parseInt(toks[i - 1], 10); if (!isNaN(it) && !isReservedItem(it)) fixed[String(it)] = clockOf(toks[i + 1], toks[i + 2]);
      }
      // A sequence line's last item routinely ends the sentence right against it — "...59
      // 60." — leaving a bare trailing period with no digit after it (unlike a real decimal
      // sub-item, "62.1", which must still be read as item 62 and left unsplit). The old
      // "\.\d+" required at least one digit after the period, so end-of-sentence punctuation
      // failed the whole token and the final number vanished outright — Court 7's declared
      // 60 and Court 12's declared 58 both dropped off the end of the sequence entirely.
      // "\.\d*" accepts zero digits after the period too, so a trailing "." is just punctuation.
      const num = t.match(/^(\d+)(?:\.\d*)?$/); if (!num) continue;
      // A CLOCK TIME inside the line — "item no 1 at 12pm", "item 41 AT 2 PM", "item 16 at
      // 3.30 pm" — must not be read as an item: "3.30" and "2" both pass the number test, so
      // "at 3.30 pm" was injecting a phantom item 3 into the middle of the call order (the
      // published samples only escaped because the time's digits happened to already be
      // declared items, and the dedup absorbed them). A number is a time, not an item, when
      // it follows "AT" or when the next token says AM/PM. Glued forms ("12PM", "3PM") never
      // matched the number test and were already inert.
      if (toks[i - 1] === "AT" || /^[AP]\.?M\.?$/.test(toks[i + 1] || "")) continue;
      const a = parseInt(num[1], 10);
      // "TO" is published truncated as a bare "T" too ("SEQUENCE 34 1 T 17 31 TO 33") —
      // without it, 1 and 17 stand as singletons and items 2–16 fall out of the declared
      // order entirely.
      // the range's end may close the sentence — "13 to 50." — the same trailing period the
      // single-number test already tolerates (stress sweep 3: "1 TO 18." lost items 2–17)
      if ((toks[i + 1] === "TO" || toks[i + 1] === "T") && /^\d+(?:\.\d*)?$/.test(toks[i + 2] || "") && !(toks[i + 2].indexOf(".") >= 0 && /^\d+\.\d+$/.test(toks[i + 2]) && /^[AP]\.?M\.?$/.test(toks[i + 3] || ""))) {
        const b = parseInt(toks[i + 2], 10);
        if (b >= a && b - a < 600) { for (let k = a; k <= b; k++) push(k); } else push(a); i += 2;
      } else if (toks[i - 1] === "WITH" && out.length) {
        // Linked to whatever was pushed immediately before "WITH" (a range's own last item,
        // for "1 TO 13 WITH 59") — recorded, not pushed: it must NOT occupy its own slot in
        // the call order, or it inflates every position after it and "23 with 58" would read
        // as two items apart instead of the same one (owner: "both will be at similar
        // position despite being far away in numbers ... 58 [should not be] a separate item
        // for the purposes of ... how far away calculation and also ... the progress bar").
        // classify()'s withItem redirect (fed from this map) handles a tracked matter ON 58
        // itself; excluding it from `seq` here is what handles everyone ELSE's distance and
        // the progress bar not double-counting the pair as two call-order positions.
        const link = String(out[out.length - 1]);
        if (!(String(a) in withMap)) withMap[String(a)] = link;
      } else push(a);
    }
    // a time-fixed item leaves the order; the markers' positions move with it
    const keep = n => !(String(n) in fixed);
    const adj = idx => idx == null ? null : out.slice(0, idx).filter(keep).length;
    const seqOut = out.filter(keep);
    return { seq: seqOut, passIdx: adj(passIdx), passIdxs: passIdxs.map(adj).filter((v, i, a) => a.indexOf(v) === i), withMap, fixed };
  }
  // The sequence text that governs a court: the board row's own, else the marquee's.
  const seqTextFor = (ctx, court, bc) => (bc && bc.sequence && String(bc.sequence).trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(court)] || "");

  function parseSequenceLine(text) {
    const out = {};
    if (!text) return out;
    const T = " " + String(text).toUpperCase().replace(/\s+/g, " ") + " ";
    // The board also labels courts with a C prefix — "Court C7: sequence item nos. …" — and
    // without accepting it the anchor failed on every court, so a whole marquee line in that
    // style parsed to NOTHING and every court showed "Not declared yet".
    const re = /COURT\s*(?:NO\.?|NUMBER|ROOM)?\s*(?:C\.?\s*)?(\d{1,2})\b/g;
    const anchors = []; let m;
    while ((m = re.exec(T))) anchors.push({ court: String(parseInt(m[1], 10)), afterNum: re.lastIndex });
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const nextStart = (i + 1 < anchors.length) ? T.lastIndexOf("COURT", anchors[i + 1].afterNum) : T.length;
      let seg = T.slice(a.afterNum, nextStart).trim();
      seg = seg.replace(/^[:\-–.\s]+/, "");
      if (seg && seqInfo(seg).seq.length) out[a.court] = seg;
    }
    return out;
  }

  function orderPos(seq, item) {
    item = Math.floor(parseFloat(item)); if (isNaN(item)) return null;
    const i = seq.indexOf(item); if (i >= 0) return i;
    const seqSet = new Set(seq); let before = 0;
    // `seq.miscTotal` (set by effSeq when the Misc list size is known, 0 on a Regular-hearing
    // day): numbers between the Misc total and 101 are nobody's items and take no positions —
    // without this a Regular item named in the sequence sat at position 0 while the next one,
    // unnamed, sat a hundred positions away (stress sweep 3)
    const mt = seq.miscTotal, vac = seq.vacated;   // (`seq.vacated`: linked / time-fixed items — no slot of their own)
    for (let n = 1; n < item; n++) { if (!seqSet.has(n) && !(vac && vac.has(n)) && (mt == null || n <= mt || n >= REG_BASE)) before++; }
    return seq.length + before;
  }

  function preStartGap(seqTxt, ours) {
    const { seq } = seqInfo(seqTxt); if (!seq.length) return null;
    const op = orderPos(seq, ours); return op == null ? null : op;
  }
  function preStartResult(g) {
    const short = g === 0 ? "up next" : g + " ahead";
    const lab = g === 0 ? "opens · you're up first" : "opens · ~" + g + " ahead in the sequence";
    return { tier: g <= 4 ? "soon" : "later", label: lab, short, gap: g, preStart: true };
  }

  // ---- ctx-backed overlays (were globals) ----
  function detailRemark(ctx, court, item) {
    const r = (ctx.remarksByCourt || {})[String(court)]; if (!r || !r.items) return "";
    if (r.items[String(item)] == null) {   // the operator marked the sub-item row ("12.1") only
      const n = Math.floor(parseFloat(item)); if (!isNaN(n)) for (const k in r.items) { if (k.indexOf(".") > 0 && Math.floor(parseFloat(k)) === n && r.items[k]) return String(r.items[k]).trim(); }
    }
    const s = String(item); if (r.items[s]) return r.items[s];
    const n = String(Math.floor(parseFloat(item)));
    return (n !== "NaN" && r.items[n]) || "";
  }
  const isOver = (ctx, court, item) => /^over$/i.test(detailRemark(ctx, court, item));
  const isPassOver = (ctx, court, item) => /pass\s*over/i.test(detailRemark(ctx, court, item));
  /* Does a board remark mean the court is FINISHED with a matter today? "Over", "dismissed",
     "disposed", "list on 12.09.2026", "after four weeks" all do. A PASS OVER emphatically
     does not — it is recalled later the same day — and part-heard continues. Anything
     unrecognised is left alone rather than guessed at.
     Lives HERE, in the engine, rather than in courtreach.html where it started: the app and
     the push watcher both have to agree about what counts as finished, and a second copy of
     these rules is precisely how the worker's classify() drifted three fixes behind once
     before. Exported through the public API so there is one set of words, in one place. */
  function remarkEndsToday(rem) {
    const s = String(rem || "").trim();
    if (!s) return false;
    if (/pass\s*over/i.test(s)) return false;
    if (/part\s*heard/i.test(s)) return false;
    if (/hearing/i.test(s)) return false;   // "HEARING": the matter is on right now
    return /^over\b/i.test(s)                 // "OVER", "OVER (Dismissed)", "OVER (List On (Date): 27-11-2026)"
      || /dismiss|dispos|allowed|withdraw|adjourn|deleted|deferred|not\s*press|\bheard\b|reserved|order|judgment|judgement|decree|leave\s*granted|rule\s*nisi|notice|admitted/i.test(s)
      || /list(ed)?\s*(on|after)/i.test(s)
      || /\bafter\b.*\bweek/i.test(s);
  }

  /* THE CALL ORDER. A court works through its declared sequence first, then everything it did
     not mention in ascending order. orderPos() speaks exactly that language (with no sequence
     it degrades to plain item order), and every position-based calculation below now uses it
     for the current item, ours, a passover's original slot and its recall point alike.
     Before this, three different functions measured position three different ways — one by
     seq.indexOf() (which returns -1 for any item in the unmentioned "rest", silently switching
     the whole adjustment off), one by raw item number (which, under a sequence, counted items
     the court had ALREADY heard as still being between us), and one by seq.length-1 as "the
     end" (which, for a partial sequence, is the end of the announcement, not of the list). The
     day simulator caught all three as wrong distances. */
  const callPos = (seq, item) => orderPos(seq, item);
  // Where the Miscellaneous list ends in call-order positions — the point recalls begin when
  // nothing more specific has been announced. Items occupy positions 0..T-1, so the end is T.
  // The announced order may carry Regular items too ("ITEM NOS. 101 TO 104, 10 TO 18 ...
  // PASS OVER IF ANY THEN REST"): they take positions, but they are not Miscellaneous
  // business, so the Misc list ends `miscTotal` MISC positions in, not `miscTotal` positions
  // in (stress sweep 2: every distance past the Regular items was short by their number).
  // A Misc list can itself run past 100 items, so "101+" alone does not make an item Regular:
  // when the list size is known, anything within it is Misc.
  const isMiscNum = (n, miscTotal) => n < REG_BASE || (miscTotal != null && n <= miscTotal);
  function miscEnd(seq, miscTotal) {
    let misc = 0, last = -1;
    seq.forEach((n, i) => { if (isMiscNum(n, miscTotal)) { misc++; last = i; } });
    if (miscTotal != null && miscTotal > 0) {
      const t = Math.max(miscTotal, misc);
      return misc >= t ? last + 1 : seq.length + (t - misc);
    }
    return seq.length || null;
  }
  // The end of the Misc list when the order in hand is the WHOLE list (effSeq `full`): after
  // its last Misc position — Regular items announced behind it are not part of it.
  function listEnd(seq, miscTotal, full) {
    if (!full) return miscEnd(seq, miscTotal);
    let last = -1; seq.forEach((n, i) => { if (isMiscNum(n, miscTotal)) last = i; });
    return last >= 0 ? last + 1 : seq.length;
  }

  /* THE CIRCULAR'S ORDER (F.No. 23/Judl./2026, 9 Oct 2026). Miscellaneous main and
     supplementary lists are each Part-A (fresh) and Part-B (after notice), and every court
     takes them: A-main, A-supp, passed-over fresh, B-main, B-supp, passed-over after-notice.
     ctx.miscParts[court] = {part:{item:"A"|"B"}, supp:[items]} comes from the causelist
     (fetch_causelist.py, by printed position — owner's rule). Returns the full default call
     order, how many Part-A positions open it (the fresh pass-over point), and each item's part
     — or null when the data isn't there or doesn't number 1..N without gaps (a gap means the
     parse missed an item, and an unknown current item would otherwise jump to the end and
     saturate the progress bar — the exact failure the reserved-series fix chased). Regular
     lists have no such split (owner), so the app only ever passes Misc data. */
  function circularOrder(ctx, court) {
    const mp = (ctx.miscParts || {})[String(court)];
    if (!mp || !mp.part) return null;
    const supp = new Set((mp.supp || []).map(String));
    const info = {};
    for (const k in mp.part) {
      if (k.indexOf(".") >= 0) continue;               // connected sub-items ride on their main item
      const n = parseInt(k, 10);
      if (isNaN(n) || n < 1 || isReservedItem(n)) continue;
      info[n] = { part: mp.part[k] === "B" ? "B" : "A", supp: supp.has(k) };
    }
    let all = Object.keys(info).map(Number).sort((a, b) => a - b);
    if (!all.length) return null;
    // The list must number 1..N cleanly. A stray FAR beyond the clean run (live data: a 50-item
    // list "containing" 670, 142, 400 — PDF fragments read as item numbers) is ignored; a gap
    // INSIDE the run, or near its end, is a missed item, and the circular order stays off.
    let run = 0; while (info[run + 1]) run++;
    if (!run || all.some(n => n > run && n <= run + 20)) return null;
    all = all.filter(n => n <= run);
    const grp = (p, sp) => all.filter(n => info[n].part === p && info[n].supp === sp);
    const A = grp("A", false).concat(grp("A", true)), B = grp("B", false).concat(grp("B", true));
    return { order: A.concat(B), freshEnd: A.length, partOf: n => (info[Math.floor(n)] || {}).part || null };
  }
  /* The call order the engine actually uses for a court. A sequence the court ANNOUNCED wins
     (and its own "passovers" point); the circular only orders whatever it leaves unmentioned
     ("then the rest") instead of plain item numbers. With NO announced sequence, the circular's
     order is the sequence and its fresh pass-over point is the passIdx. Without Part data this
     is exactly seqInfo(), so every pre-circular behaviour is unchanged. */
  function effSeq(ctx, court, seqTxt) {
    const r = effSeqRaw(ctx, court, seqTxt);
    const total = miscTotalFor(ctx, court);
    const regOnly = total == null && (regTotalFor(ctx, court) > 0 || (r.seq.length && r.seq.every(n => n >= REG_BASE)));
    r.seq.miscTotal = total != null ? total : (regOnly ? 0 : null);
    r.seq.vacated = r.vacated;
    return r;
  }
  function effSeqRaw(ctx, court, seqTxt) {
    let s = seqInfo(seqTxt);
    const circ = circularOrder(ctx, court);
    const none = () => null;
    // Items heard TOGETHER with another item hold no slot of their own — the sequence's own
    // "23 WITH 58" (seqInfo already keeps those out of `seq`) and the causelist's "TO BE TAKEN
    // UP ALONG WITH ITEM NO. 23" alike. The stress simulator caught the second kind still
    // counting as a position for everyone else: with 1 to be taken up along with 5, every
    // other matter in that court read one further away than it was.
    const linked = new Set(Object.keys(s.withMap).map(Number));
    const prefix = String(court) + "_";
    for (const key in (ctx.withItem || {})) if (key.indexOf(prefix) === 0 && ctx.withItem[key]) { const n = parseInt(key.slice(prefix.length), 10); if (!isNaN(n)) linked.add(n); }
    // ...and a matter the court's DROP NOTE deleted from today's list: never called, no slot
    // (12 Oct 2026, Court 4: 18 of its 51 serials deleted — every distance behind them was
    // overstated by the deleted matters ahead)
    for (const key in (ctx.dropped || {})) if (key.indexOf(prefix) === 0 && ctx.dropped[key]) { const n = parseInt(key.slice(prefix.length), 10); if (!isNaN(n) && key.slice(prefix.length).indexOf(".") < 0) linked.add(n); }
    // ...and so does a numbered matter the court has FIXED A TIME for ("[TO BE TAKEN UP AT
    // 2.00 P.M.]" printed against a Misc item): it is taken at its time, not at its number, so
    // its slot is empty for everyone else (stress simulator: every other matter in such a court
    // read one further away all day). Needs the court's fixed times in ctx, not only ours.
    for (const key in (ctx.fixedTimes || {})) if (key.indexOf(prefix) === 0 && clockMins(ctx.fixedTimes[key]) != null) { const n = parseInt(key.slice(prefix.length), 10); if (!isNaN(n) && n >= 1 && !isReservedItem(n)) linked.add(n); }
    // ...and one the sequence line itself fixes a time for ("ITEM 41 AT 2 PM")
    for (const k in s.fixed) { const n = parseInt(k, 10); if (!isNaN(n)) linked.add(n); }
    // a fixed-time or linked matter named in the announced order leaves it too (the court takes
    // it at its time / with its partner, not at that slot); the "passovers" point moves with it
    const declared = s.seq.filter(n => !linked.has(n));
    const adjP = idx => idx == null ? null : s.seq.slice(0, idx).filter(n => !linked.has(n)).length;
    const passIdx = adjP(s.passIdx), passIdxs = (s.passIdxs || []).map(adjP).filter((v, i, a) => a.indexOf(v) === i);
    const fixedDecl = s.fixed || {};
    s = { seq: declared, passIdx, withMap: s.withMap };
    const inSeq = new Set(s.seq);
    // `full`: the order below is the WHOLE list, explicitly — its own length is then the end of
    // the list (where after-notice / unannounced pass-overs are recalled), not the causelist's
    // serial count, which still counts the vacated items.
    if (!circ) {
      if (!linked.size) return { seq: s.seq, passIdx: s.passIdx, withMap: s.withMap, circular: false, partOf: none, freshEnd: null, full: false, vacated: linked, passIdxs, fixed: fixedDecl };
      const total = miscTotalFor(ctx, court);
      const ceiling = total != null ? total : Math.max(0, ...s.seq);
      const rest = []; for (let n = 1; n <= ceiling; n++) if (!inSeq.has(n) && !linked.has(n)) rest.push(n);
      if (!s.seq.length && total == null) return { seq: s.seq, passIdx: s.passIdx, withMap: s.withMap, circular: false, partOf: none, freshEnd: null, full: false, vacated: linked, passIdxs, fixed: fixedDecl };
      return { seq: s.seq.concat(rest), passIdx: s.passIdx, withMap: s.withMap, circular: false, partOf: none, freshEnd: null, full: total != null, vacated: linked, passIdxs, fixed: fixedDecl };
    }
    if (!s.seq.length) {
      const order = circ.order.filter(n => !linked.has(n));
      const freshEnd = circ.order.slice(0, circ.freshEnd).filter(n => !linked.has(n)).length;
      return { seq: order, passIdx: freshEnd, withMap: s.withMap, circular: true, partOf: circ.partOf, freshEnd, full: true, vacated: linked, passIdxs, fixed: fixedDecl };
    }
    const rest = circ.order.filter(n => !inSeq.has(n) && !linked.has(n));
    return { seq: s.seq.concat(rest), passIdx: s.passIdx, withMap: s.withMap, circular: false, partOf: circ.partOf, freshEnd: null, full: true, vacated: linked, passIdxs, fixed: fixedDecl };
  }

  /* How far along its call order the court has visibly got — a COUNT of positions reached.
     The current item is one reading, but it dips during a recall (the court is back on a low
     item it skipped earlier); the highest item number seen and the furthest item marked OVER
     never dip, so the reach is the greatest of the three. Under a sequence the highest NUMBER
     says little (item 12 may be first in the announced order), which is why OVER matters. */
  const reachOf = (ctx, court, seq, miscTotal, curItem, vacated) => reachInfo(ctx, court, seq, miscTotal, curItem, vacated).reach;
  // {reach, curOut}: `curOut` — the board's current item was itself called OUT OF TURN (stress
  // sweep 2: a matter taken up early, shown on the board, made every item numbered below it
  // read as "over" and dragged reach to its position). Judged only against the remark column:
  // in order unless the two slots before it are unexplained AND at least three slots lie between
  // the furthest in-order evidence and it — a remark column that lags the board by an item or
  // two is not an out-of-turn call. Callers then stand the court at the last in-order position.
  function reachInfo(ctx, court, seq, miscTotal, curItem, vacated) {
    const cur = parseFloat(curItem);
    // The board sitting on a Special Bench / mentioning / judgment item says nothing about how
    // far the numbered lists have got — counting it as a position made reach balloon past the
    // whole list the moment a 2 PM special bench began. Likewise an item that holds no slot of
    // its own (taken up along with another, or at its fixed time): when the board shows it,
    // orderPos would put it past the end and saturate the progress bar.
    const noSlot = n => vacated && vacated.has(Math.floor(n));
    // positions beyond the Misc list (a Regular item disposed early sits far past it) say
    // nothing about Misc progress — but the list's end is in POSITIONS, which Regular items
    // announced inside the order push out (stress sweep 2)
    const ceil = miscTotal != null ? Math.max(miscTotal, miscEnd(seq, miscTotal)) : Infinity;
    const curP0 = (isReservedItem(Math.floor(cur)) || noSlot(cur)) ? null : callPos(seq, curItem);
    // positions the court has visibly DEALT WITH: any remark but a pass-over (OVER, dismissed,
    // "list on …", part heard, whatever the operator wrote — the column is written only once a
    // matter was called), and the outstanding pass-overs (called and skipped — reached too)
    const touched = new Set(), poSet = new Set();
    const r = (ctx.remarksByCourt || {})[String(court)];
    if (r && r.items) for (const k in r.items) { const v = String(r.items[k] || "").trim(); if (!v || noSlot(k)) continue;
      const kp = callPos(seq, k); if (kp == null || kp >= ceil) continue; if (/pass\s*over/i.test(v)) poSet.add(kp); else if (!/hearing/i.test(v)) touched.add(kp); }   // ("HEARING" = on now, not dealt with)
    const po = passoverItemsFor(ctx, court);
    for (const k in po) { if (noSlot(k)) continue; const kp = callPos(seq, k); if (kp != null && kp < ceil) poSet.add(kp); }
    // On a Regular-hearing day (no Misc list) the Regular items' positions start after a hundred
    // phantom Misc slots (orderPos counts 1..100): nothing below the first Regular position exists
    const floorP = (miscTotal == null && cur >= REG_BASE) ? (callPos(seq, REG_BASE) || 0) : 0;
    const ok0 = q => q < floorP || touched.has(q) || poSet.has(q);
    // how far the remark column vouches for IN ORDER: the contiguous run of dealt-with positions
    let evid = 0; for (const p of touched) if (ok0(p - 1) && ok0(p - 2)) evid = Math.max(evid, p + 1);
    for (const p of poSet) if (ok0(p - 1) && ok0(p - 2)) evid = Math.max(evid, p + 1);
    // items the board has SHOWN today (app ctx.seenItems[court]; the worker has none): positions
    // the court visibly went through — they VETO a jump, never assert one
    const seenP = new Set(); const sl = (ctx.seenItems || {})[String(court)];
    if (sl) for (const it of sl) { const n = Math.floor(parseFloat(it)); if (isNaN(n) || isReservedItem(n) || noSlot(n)) continue; const p = callPos(seq, it); if (p != null) seenP.add(p); }
    const haveSeen = seenP.size >= 3;
    /* A JUMP: a position well ahead of everything the court is known to have reached, with
       nothing between — not dealt with, not passed over, never shown on the board. That is a
       matter taken OUT OF TURN (dismissed as withdrawn, mentioned, an adjournment posted early,
       or the board itself sitting on a matter called early), not reach — it used to drag reach
       to the end and collapse the progress bar / read everything below it as "over" (stress
       sweeps 1 and 2). Judged only when there is something to judge against: a remark column
       that vouches for at least three positions in order, or three polls of board history.
       Against the column alone the gap must be three unexplained slots (a column that lags the
       board by an item or two is not a jump); against board history alone six, because a quick
       bench can dispose of several matters between two polls. Deliberate blind spots: a thin
       column with no history reads every position as reach (the old behaviour); a column that
       is dense and then simply STOPS reads the court's further progress as a jump until a
       remark appears — the app's board history vetoes that, the worker's push estimates can't. */
    /* THE BOARD'S OWN ITEM (and the highest item seen): a jump when it sits four or more slots
       past the nearest position known to be reached — i.e. at least three unexplained slots
       between (a column that lags the board by an item or two is not a jump) — AND the record
       below that point is nearly complete: at most one position unexplained by a remark, a
       pass-over or the board history. A thin column cannot vouch for anything and every
       position reads as reach (the old behaviour; the owner's "past it in sequence = over"
       rule then applies). Deliberate blind spot: a column that is complete and then simply
       STOPS reads the court's further progress as a jump until a remark appears — the app's
       board history vetoes that, the worker's push estimates can't. */
    const known = q => ok0(q) || seenP.has(q) || q === curP0;   // (the board is on it: explained)
    const isJumpCur = p => {
      if (p == null) return false;
      let near = -1; for (let q = p - 1; q >= floorP; q--) if (known(q)) { near = q; break; }
      if (near < floorP) return false;
      let holes = 0, explained = 1; for (let q = floorP; q < near; q++) { if (known(q)) explained++; else holes++; }
      // The record must be complete (one miss tolerated only in a long one): ten complete
      // positions — remarks, pass-overs, the board history — vouch for a jump of five slots. A
      // column that marks only some matters never qualifies, and everything then reads as
      // reach, the old behaviour. (Measured 12 Oct 2026: real columns run from complete to
      // empty; a half-marked one can leave seven blanks in a row, which is why four complete
      // positions are not enough to call an eight-slot gap a jump.)
      const gap = p - near;
      if (holes === 0 && explained >= 10) return gap >= 5;
      if (holes <= 1 && explained >= 20) return gap >= 5;
      return false;   // (a shorter record cannot be told from a column that marks only some matters — Court 5 had 11 of 21)
    };
    const curOut = curP0 != null && isMiscNum(Math.floor(cur), miscTotal) && isJumpCur(curP0);
    const curP = curOut ? null : curP0;
    // A REMARK (or the highest item seen) ahead of the court: in order only if the two slots
    // before it are explained — dealt with, passed over, shown, or the current item itself. A
    // lone OVER with blank slots before it is a matter dealt with out of turn.
    const okc = q => q < 0 || q === curP || touched.has(q) || poSet.has(q) || seenP.has(q);
    const adjacent = p => okc(p - 1) && okc(p - 2);
    // a remark is judged as soon as the column reports anything finished (a lone OVER far ahead
    // of a court that has barely started is the classic out-of-turn disposal); the highest item
    // SEEN is judged only against a dense column or board history — in a thin column it is the
    // one reading that survives a recall dip (the court back on a low item it skipped earlier)
    const inOrderRemark = p => (curP != null && p <= curP) || touched.size === 0 || adjacent(p);
    // the board SHOWED these positions: reach evidence in order (a lagging column may not have
    // marked the last items before a recall dip — the board did show them)
    let seenHi = null; for (const p of seenP) if (p < ceil && ((curP != null && p <= curP) || adjacent(p)) && (seenHi == null || p > seenHi)) seenHi = p;
    // ...with board history in hand the strict adjacency test applies (the items before it were
    // shown, or they were not); without it, the same tolerance as the current item — a lagging
    // column must not turn a recall dip into "the court is back at item 5"
    const inOrderHi = p => (curP != null && p <= curP) || (haveSeen ? adjacent(p) : !isJumpCur(p));
    const hi = (ctx.itemHi || {})[String(court)] || 0;
    let hiP = (hi && !noSlot(hi) && !isReservedItem(hi)) ? callPos(seq, hi) : null;
    if (hiP != null && (hiP >= ceil || (hi >= REG_BASE && !isMiscNum(hi, miscTotal) && !(miscTotal == null && cur >= REG_BASE)) || (curOut && hiP === curP0) || !inOrderHi(hiP))) hiP = null;
    let overP = null; for (const p of touched) if (inOrderRemark(p) && (overP == null || p > overP)) overP = p;
    let poP = null; for (const p of poSet) if (inOrderRemark(p) && (poP == null || p > poP)) poP = p;
    const reach = Math.max(curP != null ? curP + 1 : 0, hiP != null ? hiP + 1 : 0, overP != null ? overP + 1 : 0, poP != null ? poP + 1 : 0, seenHi != null ? seenHi + 1 : 0, evid);
    return { reach, curOut };
  }
  /* Where THIS court's passovers will be taken, in one place, so the sheet and the distance
     maths can never disagree. `at` is "after"/"sequence"/"end"/"now"/null; `queue` is the
     outstanding passovers in the order they will be recalled; `gap` is how many items the
     court still has to call before the first recall (null when unknown). */
  function passoverPlan(ctx, court, bc, part) {
    const seqTxt = (bc && bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(court)] || "");
    const eff = effSeq(ctx, court, seqTxt);
    const { seq } = eff;
    const po = passoverItemsFor(ctx, court);
    const queueAll = Object.keys(po).map(k => parseInt(k, 10)).filter(n => !isNaN(n)).sort((a, b) => (callPos(seq, a) - callPos(seq, b)));
    const total = miscTotalFor(ctx, court), end = endFor(ctx, court, seq, total, eff.full, bc ? bc.item : null);
    const cur = bc ? bc.item : null; let curP = (cur != null && !isReservedItem(Math.floor(parseFloat(cur))) && !eff.vacated.has(Math.floor(parseFloat(cur)))) ? callPos(seq, cur) : null;
    const curRaw = curP;   // the board's own item's position, before any dip / out-of-turn adjustment
    const ri = bc ? reachInfo(ctx, court, seq, total, cur, eff.vacated) : { reach: 0, curOut: false }, reach = ri.reach;
    if (ri.curOut && curP != null) curP = reach - 1;   // the board's item is out of turn: the court stands at the last in-order position
    // on a recall the board dips to a low item; the court's working position is the furthest
    // it has reached in order (a thin remark column cannot otherwise account for the items
    // between — stress sweep 3)
    if (curP != null && onRecall(ctx, court, bc) && reach - 1 > curP) curP = reach - 1;
    const recalled = hasRecalledPO(ctx, court);
    // one recall point -> where the plan stands
    const decide = (passIdx, queue, rec) => {
      // The item the sequence's own "passovers" marker sits right after — "1 TO 10 25 TO 50
      // PASSOVERS" declares them after item 50 — known the moment passIdx is, independent of
      // which branch below the plan resolves to. It used to live ONLY on the "sequence" branch,
      // so the moment the court finished its declared list the plan fell to the "end" branch
      // and this already-known fact vanished from the court sheet (owner: "the passover section
      // ... not showing when the passovers will be taken up").
      const after = (passIdx != null && passIdx > 0) ? seq[passIdx - 1] : null;
      const base = { queue, after, seq, passIdx, end, circular: eff.circular, full: eff.full, vacated: eff.vacated };
      if (!bc || curP == null) return Object.assign(base, { at: null, gap: null });
      if (passIdx != null && (reach < passIdx || (reach === passIdx && !rec))) return Object.assign(base, { at: "sequence", gap: passIdx - curP });
      if (passIdx == null && rec) return Object.assign(base, { at: "now", gap: 1 });
      if (end != null && reach < end && !(passIdx != null && rec && reach === passIdx)) return Object.assign(base, { at: "end", gap: end - curP });
      if (end != null || rec) return Object.assign(base, { at: "now", gap: 1 });
      return Object.assign(base, { at: null, gap: null });
    };
    if (!eff.circular) {
      // several markers: the first one the court has not yet reached is where the next recalls are
      const ms = eff.passIdxs || [];
      const pm = ms.length ? (ms.find(m => reach <= m) ?? ms[ms.length - 1]) : eff.passIdx;
      return decide(pm, queueAll, recalled);
    }
    /* Circular: fresh pass-overs are recalled once the fresh matters (main, then supplementary)
       are done, before after-notice begins; after-notice pass-overs at the very end. A fresh
       matter still outstanding once the court has moved INTO after-notice has been passed over
       a second time — the circular leaves that to the bench's discretion, so it gets no
       estimate (owner: "The second pass over is new and cant say when it will be taken up"). */
    const fresh = queueAll.filter(n => eff.partOf(n) !== "B"), an = queueAll.filter(n => eff.partOf(n) === "B");
    // the board showing a Part-A item (a fresh matter being called, or a fresh pass-over being
    // recalled) is direct evidence the court is NOT into after-notice yet, whatever reach says
    const intoB = reach > eff.freshEnd && !(curRaw != null && curRaw < eff.freshEnd);
    // all fresh matters called and the court is visibly recalling: it is working the fresh
    // queue now — whatever an out-of-turn disposal just past the fresh point did to reach
    const workingA = !intoB && recalled && reach >= eff.freshEnd;
    const planA = intoB ? { at: "discretion", queue: fresh, gap: null, after: seq[eff.freshEnd - 1] || null, seq, passIdx: eff.freshEnd, end, circular: true, full: eff.full, vacated: eff.vacated }
                : workingA ? { at: "now", queue: fresh, gap: 1, after: seq[eff.freshEnd - 1] || null, seq, passIdx: eff.freshEnd, end, circular: true, full: eff.full, vacated: eff.vacated }
                : decide(eff.freshEnd, fresh, recalled);
    const planB = decide(null, an, false);
    if (part === "A") return planA;
    if (part === "B") return planB;
    const lead = fresh.length ? planA : planB;
    return Object.assign({}, lead, { queue: queueAll, fresh: planA, an: planB, freshEnd: eff.freshEnd });
  }

  // Items the board has already marked OVER that sit between the court and us IN CALL ORDER —
  // disposed out of turn, so they will not be called between now and our matter.
  function overAhead(ctx, court, c, ours, seq) {   // c: the court's position in call order
    const r = (ctx.remarksByCourt || {})[String(court)]; if (!r || !r.items) return 0;
    seq = seq || [];
    const o = callPos(seq, ours); if (c == null || o == null) return 0;
    let n = 0;
    for (const k in r.items) {
      if (!remarkEndsToday(r.items[k])) continue;
      if (seq.vacated && seq.vacated.has(Math.floor(parseFloat(k)))) continue;   // no slot of its own
      const v = callPos(seq, k); if (v != null && v > c && v < o) n++;
    }
    return n;
  }

  function passoverItemsFor(ctx, court) {
    const out = {};
    const add = (item, after) => {
      const n = Math.floor(parseFloat(item)); if (isNaN(n)) return;
      const a = (after != null && after !== "") ? Math.floor(parseFloat(after)) : null;
      if (!(n in out)) out[n] = { after: a }; else if (a != null && out[n].after == null) out[n].after = a;
    };
    const r = (ctx.remarksByCourt || {})[String(court)];
    if (r && r.items) for (const k in r.items) { if (/pass\s*over/i.test(r.items[k])) add(k, null); }
    const pm = ctx.poMarks || {};
    for (const key in pm) { if (!pm[key]) continue; const i = key.indexOf("_"); if (i > 0 && key.slice(0, i) === String(court)) add(key.slice(i + 1), pm[key] && pm[key].after); }
    const bpo = ctx.boardPO || {};
    for (const key in bpo) { if (!bpo[key]) continue; const i = key.indexOf("_"); if (i > 0 && key.slice(0, i) === String(court)) add(key.slice(i + 1), null); }
    return out;
  }

  /* Where a passed-over matter will be recalled, as a call-order position: an explicit "after
     item X" mark wins; then the point in the announced sequence where the court said
     "passovers"; otherwise the end of the Miscellaneous list. Null when nothing is known (no
     sequence and no list size). Owner: "a case passed over will be taken up as per sequence". */
  function recallPos(seq, passIdx, miscTotal, after, curP, full, xp, passIdxs, endPos) {
    if (after != null && after !== "") { const ap = callPos(seq, after); if (ap != null) return ap + 1; }
    // the first "passovers" point that is still ahead of the court AND past the item's own slot
    // (a matter passed over after a marker comes back at the next one, or at the end)
    const ms = (passIdxs && passIdxs.length) ? passIdxs : (passIdx != null ? [passIdx] : []);
    for (const m of ms) if ((curP == null || m > curP) && (xp == null || m > xp)) return m;
    return endPos != null ? endPos : listEnd(seq, miscTotal, !!full);
  }
  /* How OUR distance changes because of the court's OTHER outstanding passovers: one that was
     between us and the court is skipped (-1), one recalled between now and us is added (+1). */
  function poAdjust(ctx, court, curItem, ours, seq, passIdx, miscTotal, eff, curPos) {
    const po = passoverItemsFor(ctx, court); const keys = Object.keys(po); if (!keys.length) return 0;
    seq = seq || [];
    const curRaw = callPos(seq, curItem), curP = curPos != null ? curPos : curRaw, ourP = callPos(seq, ours);
    if (curP == null || ourP == null || ourP <= curP) return 0;
    const reachNow = (eff && eff.circular) ? reachOf(ctx, court, seq, miscTotal, curItem, eff.vacated) : null;
    const ourN = Math.floor(parseFloat(ours));
    let delta = 0;
    for (const k of keys) {
      if (parseInt(k, 10) === ourN) continue;
      const xp = callPos(seq, k); if (xp == null) continue;
      // circular: an after-notice pass-over comes back at the end, a fresh one at the fresh
      // pass-over point — or, once the court is into after-notice, at the bench's discretion
      // (no position at all, so it can't be counted as coming before us)
      let rp;
      if (eff && eff.circular) {
        const b = eff.partOf(parseInt(k, 10)) === "B";
        const intoB = reachNow > eff.freshEnd && !(curRaw != null && curRaw < eff.freshEnd);   // as passoverPlan reads it
        if (!b && intoB && !(po[k].after != null)) rp = null;
        else rp = recallPos(seq, b ? null : passIdx, miscTotal, po[k].after, curRaw, true, xp, b ? null : (eff && eff.passIdxs));   // the circular's order is the whole list
      } else { const endP = endFor(ctx, court, seq, miscTotal, eff && eff.full, curItem); rp = poTwice(ctx, court, k) ? endP : recallPos(seq, passIdx, miscTotal, po[k].after, curRaw, eff && eff.full, xp, eff && eff.passIdxs, endP); }
      const aheadOrig = xp > curP && xp < ourP;
      // a recall inserted at position rp is heard before the item that holds rp — so rp == ourP
      // means it comes just before us and counts
      const recallAhead = rp != null && rp > curRaw && rp > curP - 1 && rp <= ourP;   // (a recall point the court is in the middle of still counts)
      if (aheadOrig && !recallAhead) delta--;
      else if (!aheadOrig && recallAhead) delta++;
    }
    return delta;
  }
  // The passover QUEUE is taken in the order the matters were passed over, which is their call
  // order — so this counts the outstanding ones that were reached before ours.
  function passoversBeforeOurs(ctx, court, ours, seq, partOf, passIdxs, rp) {
    const po = passoverItemsFor(ctx, court); seq = seq || [];
    const ourP = callPos(seq, ours); if (ourP == null) return 0;
    // `rp(item, pos)`: where that pass-over comes back (non-circular callers) — one that comes back
    // earlier than ours is ahead of ours whatever its slot was (a typed "after item X" mark, a
    // later marker); at the same point the slot order decides
    const ourR = rp ? rp(ours, ourP) : null;
    // several markers: only a pass-over that comes back at the SAME marker as ours is ahead of ours
    const markerOf = p => { const ms = passIdxs || []; for (const m of ms) if (m > p) return m; return Infinity; };
    const ourM = markerOf(ourP);
    // circular: each part has its own queue — a fresh pass-over is never queued ahead of an
    // after-notice one (it was recalled before after-notice began, or is at the bench's discretion)
    const mine = partOf ? partOf(Math.floor(parseFloat(ours))) : null;
    let n = 0;
    for (const k in po) {
      const kp = callPos(seq, k); if (kp == null) continue;
      if (rp && ourR != null) {
        if (!partOf) { const kt = poTwice(ctx, court, k), ot = poTwice(ctx, court, ours);
          if (kt !== ot) { if (!kt) n++; continue; } }       // a second-timer is behind every first-timer
        // same point: a matter with its own "after item X" direction is taken first; then slot order
        const kA = !!(po[k] && po[k].after != null), oA = !!(po[Math.floor(parseFloat(ours))] && po[Math.floor(parseFloat(ours))].after != null);
        const kr = rp(k, kp); if (kr != null && (kr < ourR || (kr === ourR && (kA !== oA ? kA : kp < ourP)))) n++; continue; }
      if (partOf && partOf(parseInt(k, 10)) !== mine) continue;
      if (kp < ourP && (!(passIdxs && passIdxs.length) || markerOf(kp) === ourM)) n++;
    }
    return n;
  }
  // Has this court recalled ANY previously passed-over item today? Direct evidence the court
  // is actively working its passover queue rather than saving recalls for the very end —
  // classify() uses this to choose which of two estimates for OUR OWN passed-over matter to
  // trust (see the "mark" branch below).
  function hasRecalledPO(ctx, court) {
    const rp = ctx.recalledPO || {}; const prefix = String(court) + "_";
    // (an entry {after:true} is a matter recalled at its own "after item X" point — the court
    // honouring one direction, not working its pass-over queue)
    for (const k in rp) { if (rp[k] && !(rp[k] && rp[k].after) && k.indexOf(prefix) === 0) return true; }
    return false;
  }
  // Is the board's current item a passed-over matter being recalled right now? (its remark /
  // flag still says pass-over, or recordBoardPO has just moved it to recalled)
  function onRecall(ctx, court, bc) {
    if (!bc) return false;
    const n = Math.floor(parseFloat(bc.item)); if (isNaN(n)) return false;
    const key = poKey(court, n);
    if ((ctx.recalledPO || {})[key]) return true;
    if (bc.passover) return false;   // the board row itself says "passed over": a fresh pass-over, not a recall
    if ((ctx.boardPO || {})[key] || (ctx.poMarks || {})[key]) return true;
    return /pass\s*over/i.test(detailRemark(ctx, court, n));
  }
  // Passed over before and outstanding again: a SECOND pass-over. Outside the circular's two
  // queues it goes to the back of the line (recalled at the end, behind every first-time one).
  const poTwice = (ctx, court, item) => { const n = Math.floor(parseFloat(item)); return !isNaN(n) && !!(ctx.recalledPO || {})[poKey(court, n)]; };

  const doneOf = (ctx, court, item) => (ctx.doneMarks || {})[poKey(court, item)] || null;
  const poFor = (ctx, court, item) => (ctx.poMarks || {})[poKey(court, item)] || null;
  const boardPOhas = (ctx, court, item) => !!(ctx.boardPO || {})[poKey(court, item)];

  const miscTotalFor = (ctx, court) => { const v = (ctx.miscTotalByCourt || {})[String(court)]; return (v == null ? null : v); };
  const regTotalFor = (ctx, court) => { const v = (ctx.regTotalByCourt || {})[String(court)]; return (v == null ? null : v); };
  // Where the court's CURRENT list ends, in call positions: the Misc list's end while the court
  // is on Misc business; on the Regular list, the position after its last Regular item (known
  // only with the Regular list's size — a Regular-hearing day has no Misc list at all).
  function endFor(ctx, court, seq, miscTotal, full, cur) {
    const c = Math.floor(parseFloat(cur));
    if (!isNaN(c) && c >= REG_BASE && !isMiscNum(c, miscTotal)) {
      const rt = regTotalFor(ctx, court);
      // (never before the Misc end: a Regular item announced INSIDE the Misc order — "101 TO 104
      // 16 TO 21 ..." — is not the court being on the Regular list)
      if (rt != null && rt > 0) { let last = -1; for (let n = REG_BASE; n < REG_BASE + rt; n++) { const lp = callPos(seq, n); if (lp != null && lp > last) last = lp; } if (last >= 0) return Math.max(last + 1, listEnd(seq, miscTotal, full) || 0); }
    }
    return listEnd(seq, miscTotal, full);
  }

  function onRegularList(ctx, court, miscTotal, eff) {
    const bc = (ctx.boardByCourt || {})[court]; const cur = bc ? parseInt(bc.item, 10) : NaN;
    if (isNaN(cur)) return false;
    // a Regular item the court announced INSIDE its order, ahead of Misc business ("101 TO 104
    // 10 TO 18 ..."), does not mean the Misc list is finished
    if (eff && miscTotal != null && eff.seq.indexOf(cur) >= 0 && eff.seq.indexOf(cur) < listEnd(eff.seq, miscTotal, eff.full)) return false;
    // no Misc list at all (a Regular-hearing day, Tue–Thu): the board on a Regular number IS
    // the Regular list — it used to read "Regular list — after the Miscellaneous list" all day
    if (miscTotal == null) return cur >= REG_BASE;
    if (cur > miscTotal + 2) return true;
    const hi = (ctx.itemHi || {})[court] || 0;
    if (hi >= miscTotal - 3 && cur >= REG_BASE && cur < hi - 5) return true;
    return false;
  }

  /* Items a court still has to call before its NORMAL work (the Miscellaneous list, and its
     outstanding passovers) is over — or null when that cannot be known (not on the board,
     not sitting, no list size, or inside another court phase). The item on now counts: it is
     not finished yet. Once a court has moved past its Misc list only its outstanding passovers
     are counted, since the Regular list's size is not in ctx — `approx` covers that. */
  function courtRemaining(ctx, court) {
    court = String(court);
    const bc = (ctx.boardByCourt || {})[court], total = miscTotalFor(ctx, court);
    if (!bc || total == null || /not in session/i.test(bc.status || "")) return null;
    const cur = parseFloat(bc.item);
    if (isNaN(cur)) return null;
    const po = Object.keys(passoverItemsFor(ctx, court)).length;
    const fl = Math.floor(cur);
    if (fl >= 800 && fl < 900) return total + po;          // mentioning: the lists haven't begun
    if (fl >= 1500 && fl < 1600) return total + po;        // pronouncement: same
    if (isReservedItem(fl)) return null;                    // its own special bench / other phase
    if (onRegularList(ctx, court, total)) return po;
    const seqTxt = (bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[court] || "");
    const effR = effSeq(ctx, court, seqTxt);
    const reach = reachOf(ctx, court, effR.seq, total, bc.item, effR.vacated);
    // measured to the end of the EFFECTIVE order: a matter deleted by the drop note, taken up
    // with another, or fixed for a time holds no slot, so it is not "to go" either
    const end = listEnd(effR.seq, total, effR.full) || total;
    return Math.max(0, end - reach) + 1 + po;
  }

  // "14:30" / "2.30 PM" / "2 pm" / 870 -> minutes into the day, or null.
  function clockMins(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? v : null;
    const m = String(v).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([AaPp])?\.?\s*[Mm]?\.?$/);
    if (!m) return null;
    let h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0; const ap = m[3] ? m[3].toLowerCase() : "";
    if (h > 23 || mi > 59) return null;
    if (ap === "p" && h < 12) h += 12; if (ap === "a" && h === 12) h = 0;
    if (!ap && h >= 1 && h <= 8) h += 12;   // a bare "2.30" in the Supreme Court means the afternoon
    return h * 60 + mi;
  }
  const fmtClock = mins => { const h24 = Math.floor(mins / 60) % 24, m = mins % 60; const h = h24 % 12 || 12; return h + ":" + String(m).padStart(2, "0") + (h24 < 12 ? " AM" : " PM"); };
  const fmtSpan = mins => mins < 60 ? mins + " min" : (Math.floor(mins / 60) + "h" + (mins % 60 ? " " + (mins % 60) + "m" : ""));
  /* A TIME-FIXED matter (owner: "Many a times ... we find out that the case is fixed for a
     particular time ... Such a case ... should not show how far it is because no sequence
     applies to it. Instead show how much time away the case is."). Measured in minutes from
     now, never in items; `gap` stays null so nothing item-based ever touches it, and
     `minsAway` carries the number for whoever wants to alert on it. */
  function fixedResult(fixedMins, nowMins) {
    const away = fixedMins - (nowMins || 0), at = fmtClock(fixedMins);
    if (away <= 0) return { tier: "now", label: "fixed at " + at + " — time reached", short: "NOW", fixed: true, minsAway: away, at };
    if (away <= 10) return { tier: "now", label: "fixed at " + at + " · in " + fmtSpan(away), short: "in " + fmtSpan(away), fixed: true, minsAway: away, at };
    if (away <= 30) return { tier: "soon", label: "fixed at " + at + " · in " + fmtSpan(away), short: "in " + fmtSpan(away), fixed: true, minsAway: away, at };
    return { tier: "later", label: "fixed at " + at + " · in " + fmtSpan(away), short: "at " + at, fixed: true, minsAway: away, at };
  }

  // ---- the classifier — faithful port of board.html classify(e,bc) ----
  // Public entry point: a thin wrapper around classifyRaw() below, which is otherwise
  // untouched (still the exact "simulator-proven" logic, exercised byte-for-byte the same
  // way by every existing test — none of their ctx objects carry a withItem entry, and their
  // seqByCourt text never contains "WITH", so this wrapper is a no-op for all of them). It
  // only ever does ONE thing: when this item is heard together with a different one — either
  // the CAUSELIST says so (ctx.withItem, a published note) or the court's own SEQUENCE
  // announcement does ("...14 TO 23 WITH 58...", real example, Court 1, 25 Sep 2026) —
  // redirect entirely to that item: its remark, its sequence position, its passover status
  // all govern, and the result is tagged so the caller can still say which item was asked
  // about. The sequence check reads the exact same seqTxt classifyRaw derives internally
  // (bc.sequence first, else ctx.seqByCourt), so this can never disagree with what
  // classifyRaw itself would see for that court.
  function classify(e, bc, ctx) {
    ctx = ctx || {};
    const seqTxt = (bc && bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(e.courtNo)] || "");
    const withRef = seqInfo(seqTxt).withMap[String(e.itemNo)] || (ctx.withItem || {})[poKey(e.courtNo, e.itemNo)];
    // Rule 1 stays rule 1: a user's own mark on THEIR item wins outright, checked against
    // the ORIGINAL item — not the one being redirected to. Without this guard, marking your
    // own linked matter "over" would get silently overridden by the OTHER item's live
    // status the moment classifyRaw ran on it instead.
    if (withRef && withRef !== e.itemNo && !doneOf(ctx, e.courtNo, e.itemNo)) {
      const r = classifyRaw(Object.assign({}, e, { itemNo: withRef }), bc, ctx);
      return Object.assign({}, r, { withItem: withRef });
    }
    return classifyRaw(e, bc, ctx);
  }
  function classifyRaw(e, bc, ctx) {
    ctx = ctx || {};
    const ours = e.itemNo;
    // the court's DROP NOTE deleted this matter from today's list (or shifted it)
    const drp = (ctx.dropped || {})[poKey(e.courtNo, ours)];
    if (drp) return { tier: "passed", label: drp.to ? "shifted to item " + drp.to + " (drop note)" : "deleted from today's list (drop note)",
      short: drp.to ? "→ " + drp.to : "deleted", over: true, dropped: true };
    const dn = doneOf(ctx, e.courtNo, ours);
    if (dn) return { tier: "passed",
      label: dn.v === "att" ? "over — attended" : dn.v === "abs" ? "over — not attended" : "not taken up",
      short: dn.v === "att" ? "over ✓" : dn.v === "abs" ? "over ✗" : "not taken",
      over: true, done: true };
    // A fixed time beats the board's position entirely — but never the board's own word that
    // the matter is finished, which is why the remark check comes first here too.
    const seqFixed = seqInfo(seqTextFor(ctx, e.courtNo, bc)).fixed || {};
    const fixedMins = clockMins((ctx.fixedTimes || {})[poKey(e.courtNo, ours)]) ?? clockMins(seqFixed[String(Math.floor(parseFloat(ours)))]);
    if (fixedMins != null) {
      const remF = detailRemark(ctx, e.courtNo, ours);
      if (remarkEndsToday(remF)) return { tier: "passed", label: "board: " + remF, short: remF.length <= 12 ? remF.toLowerCase() : "over", over: true };
      return fixedResult(fixedMins, ctx.nowMins || 0);
    }
    if (!bc) return { tier: "unknown", label: "court not on the board", short: "—" };
    /* OUR matter is a SPECIAL BENCH matter (300s). It is never in the Miscellaneous / Regular
       call order — it is either time-fixed (handled above, in minutes) or announced to sit
       "after the normal work of the court is over" — so the item number must NEVER be
       measured against the board's (owner: "Special Bench are always listed as time fixed
       matter or with direction that they will be taken up after the work of the court or
       courts is over ... It should never be in the sequence of the miscellaneous or regular
       list". Real report: item 301 shown "241 away" with the court on item 62.) Inside the
       series itself (the bench is actually sitting) distance is series arithmetic, same shape
       as the Single/Chamber phases; otherwise there is no distance to give, only the fact. */
    const oursSB = isSpecialBenchItem(Math.floor(parseFloat(e.itemNo)));
    if (oursSB) {
      const remSB = detailRemark(ctx, e.courtNo, ours);
      if (remarkEndsToday(remSB))
        return { tier: "passed", label: "board: " + remSB, short: remSB.length <= 12 ? remSB.toLowerCase() : "over", over: true, special: true };
      const curSB = parseInt(bc.item, 10);
      if (isSpecialBenchItem(curSB)) {
        const g = Math.floor(parseFloat(ours)) - curSB;
        if (g < 0) return { tier: "passed", label: "Special Bench has moved past this item", short: "past", gap: g, special: true };
        if (g <= 1) return { tier: "now", label: g === 0 ? "SPECIAL BENCH — ON NOW" : "Special Bench — NEXT", short: g === 0 ? "NOW" : "NEXT", gap: g, special: true };
        if (g <= 4) return { tier: "soon", label: "~" + g + " Special Bench items away", short: g + " away", gap: g, special: true };
        return { tier: "later", label: g + " Special Bench items away", short: g + " away", gap: g, special: true };
      }
      /* "THIS BENCH WILL ASSEMBLE AFTER THE NORMAL WORK OF THIS COURT, COURT NO. 10 AND COURT
         NO. 16 IS OVER" (ctx.specialBenches, from fetch_causelist.py): the bench can only
         assemble once the LAST of those courts is done, so the distance is the most items any
         of them still has to call, plus this matter's place within the bench (301 first) —
         owner: "this should be taken into consideration for calculating time ... for the
         special bench matter". Every listed court must be readable, or no figure is given. */
      const benches = (ctx.specialBenches || []).filter(b => String(b.venue) === String(e.courtNo) && (b.after || []).length);
      if (benches.length) {
        const after = benches[0].after.map(String);
        const rem = after.map(c => ({ c, n: courtRemaining(ctx, c) }));
        const names = after.length === 1 ? "Court " + after[0] : "Courts " + after.slice(0, -1).join(", ") + " & " + after[after.length - 1];
        if (rem.every(r => r.n != null)) {
          const worst = rem.reduce((a, b) => (b.n > a.n ? b : a));
          const g = worst.n + Math.max(0, Math.floor(parseFloat(ours)) - 301);
          const why = worst.n > 0 ? " (Court " + worst.c + " has ~" + worst.n + " left)" : "";
          const lab = "Special Bench after " + names + " finish" + why;
          if (g <= 1) return { tier: "now", label: lab + (g === 0 ? " — about to assemble" : " — next"), short: g === 0 ? "NOW" : "NEXT", gap: g, approx: true, special: true };
          if (g <= 4) return { tier: "soon", label: "~" + g + " away · " + lab, short: "~" + g + " away", gap: g, approx: true, special: true };
          return { tier: "later", label: "~" + g + " away · " + lab, short: "~" + g + " away", gap: g, approx: true, special: true };
        }
        return { tier: "later", label: "Special Bench — after " + names + " finish", short: "special bench", special: true };
      }
      return { tier: "later", label: "Special Bench — time-fixed, or after the court's regular work is over", short: "special bench", special: true };
    }
    const seqTxt = (bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(e.courtNo)] || "");
    if (/not in session/i.test(bc.status || "")) {
      const pg = preStartGap(seqTxt, ours);
      if (pg != null) return preStartResult(pg);
      return { tier: "idle", label: "court not sitting", short: "not sitting" };
    }
    if (isMentioning(ours)) {
      // The mentioning WINDOW has closed — which says nothing about what happened to the
      // matter. It used to read "over", and a phase ending is not a disposal.
      if ((ctx.nowMins || 0) > MENT_END) return { tier: "passed", label: "mentioning window has closed", short: "closed", ment: true };
      return { tier: "soon", label: "mentioning — watch", short: "watch", gap: 0, ment: true };
    }
    const curBoardNum = parseInt(bc.item, 10);
    const oursNum = parseFloat(ours);
    const oursSingle = oursNum >= 1600 && oursNum < 1700, oursChamber = oursNum >= 1700 && oursNum < 1800;
    if (oursSingle || oursChamber) {
      const inPhase = (oursSingle && curBoardNum >= 1600 && curBoardNum < 1700) || (oursChamber && curBoardNum >= 1700 && curBoardNum < 1800);
      if (inPhase) {
        const g = Math.floor(oursNum) - Math.floor(curBoardNum);
        if (g < 0) return { tier: "passed", label: "matter is over", short: "over", over: true, gap: g };
        if (g <= 1) return { tier: "now", label: g === 0 ? "ITEM ON NOW" : "NEXT — get in", short: g === 0 ? "NOW" : "NEXT", gap: g };
        if (g <= 4) return { tier: "soon", label: "~" + g + " items away", short: g + " away", gap: g };
        return { tier: "later", label: g + " items away", short: g + " away", gap: g };
      }
      return { tier: "later", label: (oursSingle ? "Single Judge" : "Chamber Judge") + " list — after the board", short: "after board", reg: true };
    }
    /* OUR OWN matter in the MENTIONING series (800s). The series sits in a fixed place in
       the court's day: pronouncements (1500s) first, then mentioning, then the
       Miscellaneous and Regular lists (owner: "the mentioning series ... will be always
       taken up before the miscellaneous and regular lists and after pronouncement").
       While the board is inside the series, distance is series arithmetic, same shape as
       the Single/Chamber phases above; once the board is into the numbered lists the
       series is finished for the day. */
    const oursMent = oursNum >= 800 && oursNum < 900;
    if (oursMent) {
      if (curBoardNum >= 800 && curBoardNum < 900) {
        const g = Math.floor(oursNum) - Math.floor(curBoardNum);
        if (g < 0) return { tier: "passed", label: "mentioning item is over", short: "over", over: true, gap: g, ment: true };
        if (g <= 1) return { tier: "now", label: g === 0 ? "MENTIONING — ON NOW" : "mentioning — NEXT", short: g === 0 ? "NOW" : "NEXT", gap: g, ment: true };
        if (g <= 4) return { tier: "soon", label: "~" + g + " mentioning items away", short: g + " away", gap: g, ment: true };
        return { tier: "later", label: g + " mentioning items away", short: g + " away", gap: g, ment: true };
      }
      if (curBoardNum >= 1500 && curBoardNum < 1600) return { tier: "soon", label: "mentioning — after the pronouncements", short: "after pronouncement", ment: true };
      if (!isNaN(curBoardNum) && curBoardNum < 800) return { tier: "passed", label: "mentioning is over — the lists are running", short: "closed", ment: true };
      return { tier: "soon", label: "mentioning — taken up before the lists", short: "mentioning", ment: true };
    }
    if (curBoardNum >= 800 && curBoardNum < 900) return { tier: "soon", label: "mentioning is on", short: "mentioning", ment: true };
    if (curBoardNum >= 1500 && curBoardNum < 1600) return { tier: "soon", label: "pronouncement is on", short: "pronouncement" };
    if (curBoardNum >= 1600 && curBoardNum < 1700) return { tier: "soon", label: "Single Judge matters on", short: "single judge" };
    if (curBoardNum >= 1700 && curBoardNum < 1800) return { tier: "soon", label: "Chamber Judge matters on", short: "chamber" };
    // What the board itself says wins, and is quoted rather than flattened to "over" — a
    // DISMISSED is not the same fact as an OVER, and the court sheet was the only place that
    // distinction survived. Only the ISLAND has to abbreviate, so a long remark ("list on
    // 12.09.2026") still collapses to "over" there; the full wording travels in `label` and
    // is spelled out in the sheet.
    const remNow = detailRemark(ctx, e.courtNo, ours);
    if (remarkEndsToday(remNow))
      return { tier: "passed", label: "board: " + remNow,
               short: remNow.length <= 12 ? remNow.toLowerCase() : "over", over: true };
    // The board is on a Special Bench item (the 2 PM bench is sitting) while OURS is a normal
    // list item: the numbered lists are paused, not advanced — item-number arithmetic against
    // 301 would call every list item "over" and put the court hundreds of positions ahead.
    if (isSpecialBenchItem(curBoardNum))
      return { tier: "later", label: "Special Bench is sitting — the list resumes after it", short: "special bench", special: true };
    const eff = effSeq(ctx, e.courtNo, seqTxt);
    const { seq, passIdx } = eff;
    const miscTotalHere = miscTotalFor(ctx, e.courtNo);
    // the court's position in call order — null only when the board's item isn't a number;
    // an item called out of turn puts the court at the last position it reached in order
    const curRI = reachInfo(ctx, e.courtNo, seq, miscTotalHere, bc.item, eff.vacated);
    const curPos0 = callPos(seq, bc.item);
    const curPos = (curPos0 != null && ((curRI.curOut) || (onRecall(ctx, e.courtNo, bc) && curRI.reach - 1 > curPos0))) ? curRI.reach - 1 : curPos0;
    const mark = poFor(ctx, e.courtNo, ours)
      || (isPassOver(ctx, e.courtNo, ours) ? { mode: "detail" } : null)
      || (boardPOhas(ctx, e.courtNo, ours) ? { mode: "slot" } : null);
    if (mark) {
      /* OUR OWN matter has been passed over. Where it comes back is recallPos(): after a named
         item, at the sequence's "passovers" point, or at the end of the Misc list — and it
         comes back in its TURN in the passover queue, behind the ones passed over before it
         (owner: "failing to see sequence of passovers and failing to calculate how far our
         case which was 4th passover in line is"). gap = items the court still has to call
         before the recall point, plus the passovers queued ahead of ours.
         Once the court has visibly recalled ANY passover today (hasRecalledPO), that is direct
         evidence it is working the queue now rather than saving it, so the distance is simply
         our place in the queue — one for the item on now, plus every outstanding passover that
         was reached before ours. Before any recall is seen, the recall point is trusted; the
         failure mode of that choice is under-promising, which is the safer one. */
      let gap = null, tail = "";
      // the board is on OUR matter right now (recalling it, or passing it over again): on now
      if (curPos0 != null && !bc.passover && orderPos(seq, ours) === curPos0) return { tier: "now", label: "recalled — item on now", short: "NOW", gap: 0, po: true };
      const endHere = endFor(ctx, e.courtNo, seq, miscTotalHere, eff.full, bc.item);
      const poAll = passoverItemsFor(ctx, e.courtNo);
      const afterOf = item => (poAll[Math.floor(parseFloat(item))] || {}).after;
      const curRI2 = reachInfo(ctx, e.courtNo, seq, miscTotalHere, bc.item, eff.vacated);
      const intoB2 = eff.circular && curRI2.reach > eff.freshEnd && !(curPos0 != null && curPos0 < eff.freshEnd);
      const rpOf = eff.circular
        // the circular's two queues: an "after item X" direction wins; fresh ones come back at
        // the fresh point (none foreseeable once the court is into after-notice); after-notice at the end
        ? ((item, pos) => { const a = afterOf(item); if (a != null) { const ap = callPos(seq, a); return ap != null ? ap + 1 : null; }
            return eff.partOf(Math.floor(parseFloat(item))) === "B" ? endHere : (intoB2 ? null : eff.freshEnd); })
        : ((item, pos) => recallPos(seq, passIdx, miscTotalHere, afterOf(item), curPos0, eff.full, pos, eff.passIdxs, endHere));
      const queued = passoversBeforeOurs(ctx, e.courtNo, ours, seq, eff.circular ? eff.partOf : null, eff.circular ? null : eff.passIdxs, rpOf);
      const explicitAfter = (mark.mode === "after" && mark.after) ? mark.after : null;
      if (curPos != null) {
        if (explicitAfter != null) {
          const rp = recallPos(seq, null, null, explicitAfter, curPos);
          if (rp != null) {
            let skipped = 0;
            const rr = (ctx.remarksByCourt || {})[String(e.courtNo)];
            if (rr && rr.items) for (const k in rr.items) { if (!remarkEndsToday(rr.items[k]) || eff.vacated.has(parseInt(k, 10))) continue;
              const v = callPos(seq, k); if (v != null && v > curPos && v < rp) skipped++; }
            gap = Math.max(0, rp - curPos - skipped) + queued; tail = " · taken after item " + String(explicitAfter);
          }
        } else {
          const ourPart = eff.circular ? (eff.partOf(oursNum) === "B" ? "B" : "A") : null;
          let plan = passoverPlan(ctx, e.courtNo, bc, ourPart);
          // passed over a second time outside the circular: back of the line, at the end
          if (!eff.circular && poTwice(ctx, e.courtNo, ours) && plan.gap != null) { const endP = endFor(ctx, e.courtNo, seq, miscTotalHere, eff.full, bc.item); if (endP != null && endP > curPos) plan = Object.assign({}, plan, { at: "end", gap: endP - curPos }); }
          if (plan.at === "discretion")
            return { tier: "later", label: "second pass-over — taken up at the bench's discretion", short: "2nd pass-over", po: true };
          if (plan.gap != null) {
            let skipped = 0;
            const rr = (ctx.remarksByCourt || {})[String(e.courtNo)];
            if (rr && rr.items) for (const k in rr.items) { if (!remarkEndsToday(rr.items[k]) || eff.vacated.has(parseInt(k, 10))) continue;
              const v = callPos(seq, k); if (v != null && v > curPos && v < curPos + plan.gap) skipped++; }
            gap = Math.max(0, plan.gap - skipped) + queued;
            tail = eff.circular
              ? (ourPart === "B" ? " · after-notice pass-overs, at the end" : " · fresh pass-overs, after the fresh matters")
              : plan.at === "sequence" ? " · taken after the sequence" : plan.at === "end" ? " · taken at end" : " · in the passover queue";
          }
        }
      }
      if (gap == null) return { tier: "later", label: "passed over — awaiting its turn", short: "passed over", po: true };
      if (gap <= 0) return { tier: "now", label: "passed over — item on now", short: "NOW", gap, po: true };
      if (gap === 1) return { tier: "now", label: "passed over — next", short: "NEXT", gap, po: true };
      if (gap <= 4) return { tier: "soon", label: "~" + gap + " items away · passed over" + tail, short: gap + " away", gap, po: true };
      return { tier: "later", label: gap + " items away · passed over" + tail, short: gap + " away", gap, po: true };
    }
    if (/^reg/i.test((e.listType || "").trim())) {
      const miscTotal = miscTotalFor(ctx, e.courtNo);
      // our Regular matter announced in the court's own order: its place is simply its position
      if (!onRegularList(ctx, e.courtNo, miscTotal, eff) && seq.indexOf(Math.floor(oursNum)) < 0) {
        if (miscTotal == null && !seq.length)
          return { tier: "later", label: "Regular list — after the Miscellaneous list", short: "after Misc", reg: true };
        const cur = parseInt(bc.item, 10);
        // miscDone approximates "how far into Misc has the court actually gotten" — but once
        // recalls are happening, the board's CURRENT item can be a low-numbered passover being
        // recalled right now, which is a temporary DIP, not real regression. Using cur alone
        // there would read that dip as "only just started Misc" and wildly overstate what's
        // left (owner's report: Court 8 showing 21 away with only three passovers and three
        // Regular matters actually outstanding — 21 is explained exactly by this: cur reading
        // a recalled low item while the court had genuinely already reached item ~97+ of a
        // ~100 Misc list). itemHi (the highest raw item any poll has seen at this court today)
        // never regresses on a recall the way cur does — same signal onRegularList() already
        // trusts for its own "has this court moved past Misc" call — so take whichever is
        // higher.
        // Progress is measured in CALL-ORDER positions — see reachOf(): the furthest the court
        // has visibly got, which does not dip while it is recalling a low-numbered passover.
        const miscDone = reachOf(ctx, e.courtNo, seq, miscTotal, bc.item, eff.vacated);
        // where the Misc list ends in call positions — Regular items announced inside the order
        // take positions of their own (counted below), so this is NOT simply the Misc total
        const end = listEnd(seq, miscTotal, eff.full);
        let outOfTurnAhead = 0;
        { const rr = (ctx.remarksByCourt || {})[String(e.courtNo)];
          if (rr && rr.items) for (const k in rr.items) { if (!remarkEndsToday(rr.items[k]) || eff.vacated.has(parseInt(k, 10))) continue;
            const p = callPos(seq, k); if (p != null && p >= miscDone && p < Math.max(end, seq.length)) outOfTurnAhead++; } }
        // positions still to be called before Misc is finished (Regular items the court put
        // inside that stretch included — they ARE called there)
        const miscLeft = Math.max(0, end - miscDone - outOfTurnAhead);
        // Regular matters that come before ours: the ones not announced anywhere (they follow in
        // number order after Misc) plus the announced ones that sit past the Misc end and have
        // not been reached. Announced ones the court has already called are gone.
        const inSeq = new Set(seq);
        let regRank = 1;   // ours itself: "the item right after the current one is 1"
        for (let n = REG_BASE; n < Math.floor(oursNum); n++) if (!inSeq.has(n)) regRank++;
        seq.forEach((n, p) => { if (!isMiscNum(n, miscTotal) && n !== Math.floor(oursNum) && p >= Math.max(end, miscDone)) regRank++; });
        // Misc's own outstanding passovers are still Misc business, not yet disposed, and
        // Misc must finish before Regular starts — so they count toward the gap too (owner:
        // "miscellaneous list comes first before the regular list and so also any passover
        // from the miscellaneous list comes first before regular list ... unless there is a
        // specific sequence provides for otherwise"). Concrete worked example that shaped
        // this: Court 8, item 31 current, Misc total 35, six outstanding Misc passovers, our
        // matter is Regular #104 (regRank 4) — expected gap = 6 (passovers) + 4 (Misc left:
        // 32-35) + 3 (Regular ahead: 101-103) = 13.
        //
        // Only passovers AT OR BEHIND the court's REACH so far count here — one still ahead of
        // that (item > miscDone) is already inside miscLeft above (it hasn't been reached OR
        // skipped yet from our vantage point), so adding it again would double it. Boundary is
        // miscDone (== max(cur,hi)), not cur alone, for the same reason miscDone itself uses
        // it: a passover with item number between a temporary recall dip and the court's real
        // peak was genuinely already reached and skipped, and using cur here would silently
        // drop it from the gap entirely — not double-counted, just gone.
        //
        // The exception: if the announced sequence explicitly places Regular items BEFORE its
        // mention of passovers (i.e. the court is saying "101-120 first, passovers after"),
        // that overrides the default — those passovers are no longer Misc-first business.
        const poException = seq.length && passIdx != null && seq.slice(0, passIdx).some(n => n >= REG_BASE);
        let miscPOLeft = 0;
        if (!poException) {
          const po = passoverItemsFor(ctx, e.courtNo);
          const miscCeil = miscTotal != null ? miscTotal : (REG_BASE - 1);
          for (const k in po) { const n = parseInt(k, 10), kp = callPos(seq, k); if (!isNaN(n) && n <= miscCeil && kp != null && kp < miscDone) miscPOLeft++; }
        }
        // regRank, not regRank-1: the same convention as every other distance here — the item
        // right after the current one is 1 ("NEXT"). With Misc finished and no passovers, the
        // first Regular matter is next, not "on now" (the simulator caught the old off-by-one:
        // it reported 101 as NOW while the court was still on the last Misc item).
        const gap = miscLeft + miscPOLeft + regRank;
        const detail = (miscLeft > 0 || miscPOLeft > 0)
          ? "Misc: " + miscLeft + " to go" + (miscPOLeft ? " · " + miscPOLeft + " passover" + (miscPOLeft === 1 ? "" : "s") : "")
          : "Misc done";
        if (gap <= 1) return { tier: "now", label: "Regular — get in now", short: "NOW", gap, reg: true };
        if (gap <= 4) return { tier: "soon", label: "Regular — ~" + gap + " away · " + detail, short: gap + " away", gap, reg: true };
        return { tier: "later", label: "Regular — ~" + gap + " away · " + detail, short: gap + " away", gap, reg: true };
      }
    }
    // `approx` also when the order is only the circular's DEFAULT — no announced sequence
    let gap = null, approx = !!eff.circular || !seq.length;   // raw item numbers when nothing was announced
    if (curPos != null) { const op = orderPos(seq, ours); if (op != null) gap = (curPos0 != null && op === curPos0) ? 0 : (curPos !== curPos0 && op <= curPos) ? -1 : op - curPos; }   // ours on the board = on now, dip or not; at or before the working position during a dip = already called
    if (gap != null && gap > 0) { const done = overAhead(ctx, e.courtNo, curPos, ours, seq); if (done > 0) gap = Math.max(0, gap - done); }
    let poNote = "";
    if (gap != null) { const pa = poAdjust(ctx, e.courtNo, bc.item, ours, seq, passIdx, miscTotalHere, eff, curPos); if (pa) { gap = Math.max(0, gap + pa); poNote = pa < 0 ? " · " + (-pa) + " passed over ahead" : " · " + pa + " recalled first"; } }
    if (gap == null) { const pg = preStartGap(seqTxt, ours); if (pg != null) return preStartResult(pg); }
    if (gap == null) return { tier: "unknown", label: "position unclear", short: "—" };
    // Nothing posted, and the court is past this item in the TRUE call order — so it is over
    // (owner: "if nothing is forthcoming and in terms of sequence the court is past that case
    // then show it as over"). This branch briefly reported "no result" instead, after it put a
    // false "over" on Court 12's item 9 — but the real fault there was the sequence parser
    // dropping items 1-3, which made a case 13 AHEAD of the court look 48 behind it. With the
    // order computed correctly, being past it in sequence is a sound basis for calling it
    // over, and `over` is set so the label, the strikethrough and the alerts all agree.
    // `approx` still marks the weaker case where no sequence was published at all and this is
    // raw item numbers; the tap-to-unstrike override remains for when the board is wrong.
    if (gap < 0) return { tier: "passed", label: "matter is over", short: "over", over: true, gap, approx };
    if (gap <= 1) return { tier: "now", label: gap === 0 ? "ITEM ON NOW" : "NEXT — get in", short: gap === 0 ? "NOW" : "NEXT", gap, approx, poNote };
    if (gap <= 4) return { tier: "soon", label: "~" + gap + " items away" + poNote, short: gap + " away", gap, approx, poNote };
    return { tier: "later", label: gap + " items away" + poNote, short: gap + " away", gap, approx, poNote };
  }

  const API = { classify, courtRemaining, circularOrder, effSeq, isReservedItem, isSpecialBenchItem, seqInfo, orderPos, parseSequenceLine, preStartGap, preStartResult, isMentioning, MENT_END, REG_BASE, passoverItemsFor, detailRemark, remarkEndsToday, callPos, recallPos, miscEnd, reachOf, passoverPlan, passoversBeforeOurs, reachInfo, seqTextFor, endFor, onRecall, poTwice, clockMins, fmtClock };
  root.BoardEngine = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
