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
     miscTotalByCourt {court: int|null}   Misc list size (caller precomputes)
     boardByCourt     {court: bcRow}      the parsed board keyed by court
     fixedTimes       {"court_item": "HH:MM" | minutes}  a matter the court has fixed for a
                                                          particular time — no sequence applies
                                                          to it, so it is measured in minutes
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
  const poKey = (court, item) => String(court) + "_" + String(item);

  // ---- pure sequence maths (identical to board.html) ----
  function isMentioning(item) { const s = String(item || "").trim(); return s !== "" && !/^\d/.test(s); }

  function seqInfo(text) {
    if (!text) return { seq: [], passIdx: null, withMap: {} };
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
    const toks = norm.toUpperCase().replace(/[^0-9A-Z. ]/g, " ").split(/\s+/).filter(Boolean);
    const out = [], seen = new Set(); let passIdx = null;
    const withMap = {};   // {"58": "23"} — heard TOGETHER with the item that precedes "WITH",
                           // not a separate call-order position of its own (real example,
                           // Court 1's own published sequence today: "...14 TO 23 WITH 58...").
    const push = n => { if (!seen.has(n)) { seen.add(n); out.push(n); } };
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (passIdx == null && (t === "PASSOVER" || t === "PASSOVERS" || t === "PO" || (t === "PASS" && (toks[i + 1] === "OVER" || toks[i + 1] === "OVERS")))) passIdx = out.length;
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
      if ((toks[i + 1] === "TO" || toks[i + 1] === "T") && /^\d+$/.test(toks[i + 2] || "")) {
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
    return { seq: out, passIdx, withMap };
  }

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
    for (let n = 1; n < item; n++) { if (!seqSet.has(n)) before++; }
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
    return /^over$/i.test(s)
      || /dismiss|dispos|allowed|withdraw|adjourn|deleted|deferred|not\s*press/i.test(s)
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
  function miscEnd(seq, miscTotal) {
    if (miscTotal != null && miscTotal > 0) return Math.max(miscTotal, seq.length);
    return seq.length || null;
  }

  /* How far along its call order the court has visibly got — a COUNT of positions reached.
     The current item is one reading, but it dips during a recall (the court is back on a low
     item it skipped earlier); the highest item number seen and the furthest item marked OVER
     never dip, so the reach is the greatest of the three. Under a sequence the highest NUMBER
     says little (item 12 may be first in the announced order), which is why OVER matters. */
  function reachOf(ctx, court, seq, miscTotal, curItem) {
    const cur = parseFloat(curItem), curP = callPos(seq, curItem);
    const hi = (ctx.itemHi || {})[String(court)] || 0, hiP = hi ? callPos(seq, hi) : null;
    let overP = null;
    const r = (ctx.remarksByCourt || {})[String(court)];
    if (r && r.items) for (const k in r.items) { if (!/^over$/i.test(r.items[k])) continue;
      const kp = callPos(seq, k); if (kp != null && kp < (miscTotal != null ? miscTotal : Infinity) && (overP == null || kp > overP)) overP = kp; }
    // ...and an outstanding passover was, by definition, called and skipped — its slot is reached.
    let poP = null;
    const po = passoverItemsFor(ctx, court);
    for (const k in po) { const kp = callPos(seq, k); if (kp != null && kp < (miscTotal != null ? miscTotal : Infinity) && (poP == null || kp > poP)) poP = kp; }
    return Math.max(curP != null ? curP + 1 : 0, hiP != null ? hiP + 1 : 0, overP != null ? overP + 1 : 0, poP != null ? poP + 1 : 0, (!seq.length && !isNaN(cur)) ? cur : 0);
  }
  /* Where THIS court's passovers will be taken, in one place, so the sheet and the distance
     maths can never disagree. `at` is "after"/"sequence"/"end"/"now"/null; `queue` is the
     outstanding passovers in the order they will be recalled; `gap` is how many items the
     court still has to call before the first recall (null when unknown). */
  function passoverPlan(ctx, court, bc) {
    const seqTxt = (bc && bc.sequence && bc.sequence.trim()) ? bc.sequence : ((ctx.seqByCourt || {})[String(court)] || "");
    const { seq, passIdx } = seqInfo(seqTxt);
    const po = passoverItemsFor(ctx, court);
    const queue = Object.keys(po).map(k => parseInt(k, 10)).filter(n => !isNaN(n)).sort((a, b) => (callPos(seq, a) - callPos(seq, b)));
    const total = miscTotalFor(ctx, court), end = miscEnd(seq, total);
    const cur = bc ? bc.item : null, curP = cur != null ? callPos(seq, cur) : null;
    const reach = bc ? reachOf(ctx, court, seq, total, cur) : 0;
    const recalled = hasRecalledPO(ctx, court);
    // The item the sequence's own "passovers" marker sits right after — "1 TO 10 25 TO 50
    // PASSOVERS" declares them after item 50 — known the moment passIdx is, independent of
    // which branch below the plan resolves to. It used to live ONLY on the "sequence" branch,
    // so the moment the court finished its declared list (reach reaching passIdx — which,
    // since passIdx routinely equals the list's own end, is almost immediately), the plan
    // fell to the "end" branch and this already-known fact vanished from the court sheet
    // (owner: "the passover section ... not showing when the passovers will be taken up" —
    // "1-10, 25-50 and then passovers" should say "after 50" regardless of which branch).
    const after = (passIdx != null && passIdx > 0) ? seq[passIdx - 1] : null;
    if (!bc || curP == null) return { at: null, queue, gap: null, after, seq, passIdx, end };
    if (passIdx != null && (reach < passIdx || (reach === passIdx && !recalled))) return { at: "sequence", queue, gap: passIdx - curP, after, seq, passIdx, end };
    if (passIdx == null && recalled) return { at: "now", queue, gap: 1, after, seq, passIdx, end };
    if (end != null && reach < end && !(passIdx != null && recalled && reach === passIdx)) return { at: "end", queue, gap: end - curP, after, seq, passIdx, end };
    if (end != null || recalled) return { at: "now", queue, gap: 1, after, seq, passIdx, end };
    return { at: null, queue, gap: null, after, seq, passIdx, end };
  }

  // Items the board has already marked OVER that sit between the court and us IN CALL ORDER —
  // disposed out of turn, so they will not be called between now and our matter.
  function overAhead(ctx, court, curItem, ours, seq) {
    const r = (ctx.remarksByCourt || {})[String(court)]; if (!r || !r.items) return 0;
    seq = seq || [];
    const c = callPos(seq, curItem), o = callPos(seq, ours); if (c == null || o == null) return 0;
    let n = 0;
    for (const k in r.items) {
      if (!/^over$/i.test(r.items[k])) continue;
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
  function recallPos(seq, passIdx, miscTotal, after, curP) {
    if (after != null && after !== "") { const ap = callPos(seq, after); if (ap != null) return ap + 1; }
    if (passIdx != null && (curP == null || passIdx > curP)) return passIdx;
    return miscEnd(seq, miscTotal);
  }
  /* How OUR distance changes because of the court's OTHER outstanding passovers: one that was
     between us and the court is skipped (-1), one recalled between now and us is added (+1). */
  function poAdjust(ctx, court, curItem, ours, seq, passIdx, miscTotal) {
    const po = passoverItemsFor(ctx, court); const keys = Object.keys(po); if (!keys.length) return 0;
    seq = seq || [];
    const curP = callPos(seq, curItem), ourP = callPos(seq, ours);
    if (curP == null || ourP == null || ourP <= curP) return 0;
    const ourN = Math.floor(parseFloat(ours));
    let delta = 0;
    for (const k of keys) {
      if (parseInt(k, 10) === ourN) continue;
      const xp = callPos(seq, k); if (xp == null) continue;
      const rp = recallPos(seq, passIdx, miscTotal, po[k].after, curP);
      const aheadOrig = xp > curP && xp < ourP;
      // a recall inserted at position rp is heard before the item that holds rp — so rp == ourP
      // means it comes just before us and counts
      const recallAhead = rp != null && rp > curP && rp <= ourP;
      if (aheadOrig && !recallAhead) delta--;
      else if (!aheadOrig && recallAhead) delta++;
    }
    return delta;
  }
  // The passover QUEUE is taken in the order the matters were passed over, which is their call
  // order — so this counts the outstanding ones that were reached before ours.
  function passoversBeforeOurs(ctx, court, ours, seq) {
    const po = passoverItemsFor(ctx, court); seq = seq || [];
    const ourP = callPos(seq, ours); if (ourP == null) return 0;
    let n = 0; for (const k in po) { const kp = callPos(seq, k); if (kp != null && kp < ourP) n++; }
    return n;
  }
  // Has this court recalled ANY previously passed-over item today? Direct evidence the court
  // is actively working its passover queue rather than saving recalls for the very end —
  // classify() uses this to choose which of two estimates for OUR OWN passed-over matter to
  // trust (see the "mark" branch below).
  function hasRecalledPO(ctx, court) {
    const rp = ctx.recalledPO || {}; const prefix = String(court) + "_";
    for (const k in rp) { if (rp[k] && k.indexOf(prefix) === 0) return true; }
    return false;
  }

  const doneOf = (ctx, court, item) => (ctx.doneMarks || {})[poKey(court, item)] || null;
  const poFor = (ctx, court, item) => (ctx.poMarks || {})[poKey(court, item)] || null;
  const boardPOhas = (ctx, court, item) => !!(ctx.boardPO || {})[poKey(court, item)];

  const miscTotalFor = (ctx, court) => { const v = (ctx.miscTotalByCourt || {})[String(court)]; return (v == null ? null : v); };

  function onRegularList(ctx, court, miscTotal) {
    const bc = (ctx.boardByCourt || {})[court]; const cur = bc ? parseInt(bc.item, 10) : NaN;
    if (isNaN(cur)) return false;
    if (miscTotal == null) return false;
    if (cur > miscTotal + 2) return true;
    const hi = (ctx.itemHi || {})[court] || 0;
    if (hi >= miscTotal - 3 && cur >= REG_BASE && cur < hi - 5) return true;
    return false;
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
    const dn = doneOf(ctx, e.courtNo, ours);
    if (dn) return { tier: "passed",
      label: dn.v === "att" ? "over — attended" : dn.v === "abs" ? "over — not attended" : "not taken up",
      short: dn.v === "att" ? "over ✓" : dn.v === "abs" ? "over ✗" : "not taken",
      over: true, done: true };
    // A fixed time beats the board's position entirely — but never the board's own word that
    // the matter is finished, which is why the remark check comes first here too.
    const fixedMins = clockMins((ctx.fixedTimes || {})[poKey(e.courtNo, ours)]);
    if (fixedMins != null) {
      const remF = detailRemark(ctx, e.courtNo, ours);
      if (remarkEndsToday(remF)) return { tier: "passed", label: "board: " + remF, short: remF.length <= 12 ? remF.toLowerCase() : "over", over: true };
      return fixedResult(fixedMins, ctx.nowMins || 0);
    }
    if (!bc) return { tier: "unknown", label: "court not on the board", short: "—" };
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
    const { seq, passIdx } = seqInfo(seqTxt);
    const miscTotalHere = miscTotalFor(ctx, e.courtNo);
    const curPos = callPos(seq, bc.item);          // null only when the board's item isn't a number
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
      const queued = passoversBeforeOurs(ctx, e.courtNo, ours, seq);
      const explicitAfter = (mark.mode === "after" && mark.after) ? mark.after : null;
      if (curPos != null) {
        if (explicitAfter != null) {
          const rp = recallPos(seq, null, null, explicitAfter, curPos);
          if (rp != null) { gap = Math.max(0, rp - curPos); tail = " · taken after item " + String(explicitAfter); }
        } else {
          const plan = passoverPlan(ctx, e.courtNo, bc);
          if (plan.gap != null) {
            gap = plan.gap + queued;
            tail = plan.at === "sequence" ? " · taken after the sequence" : plan.at === "end" ? " · taken at end" : " · in the passover queue";
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
      if (!onRegularList(ctx, e.courtNo, miscTotal)) {
        const regRank = (Math.floor(oursNum) >= REG_BASE) ? (Math.floor(oursNum) - (REG_BASE - 1)) : Math.max(1, Math.floor(oursNum) || 1);
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
        const miscDone = reachOf(ctx, e.courtNo, seq, miscTotal, bc.item);
        const miscLeft = Math.max(0, (miscTotal != null ? miscTotal : seq.length) - miscDone);
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
    let gap = null, approx = false;
    if (seq.length) { const op = orderPos(seq, ours), cp = orderPos(seq, bc.item); if (op != null && cp != null) gap = op - cp; }
    if (gap == null) { const c = parseFloat(bc.item); if (!isNaN(c)) { gap = Math.floor(oursNum) - Math.floor(c); approx = true; } }
    if (gap != null && gap > 0) { const done = overAhead(ctx, e.courtNo, bc.item, ours, seq); if (done > 0) gap = Math.max(0, gap - done); }
    let poNote = "";
    if (gap != null) { const pa = poAdjust(ctx, e.courtNo, bc.item, ours, seq, passIdx, miscTotalHere); if (pa) { gap = Math.max(0, gap + pa); poNote = pa < 0 ? " · " + (-pa) + " passed over ahead" : " · " + pa + " recalled first"; } }
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

  const API = { classify, seqInfo, orderPos, parseSequenceLine, preStartGap, preStartResult, isMentioning, MENT_END, REG_BASE, passoverItemsFor, detailRemark, remarkEndsToday, callPos, recallPos, miscEnd, reachOf, passoverPlan, passoversBeforeOurs, clockMins, fmtClock };
  root.BoardEngine = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
