#!/usr/bin/env python3
"""
Supreme Court of India — per-court BENCH (coram) fetcher for CourtReach (self-standing copy).

Model (owner's decision, Jul 2026): the office Staff enter each listing on the
day sheet — court no, item no, causelist type, cause title, date, briefing
counsel. This scheduled Action cannot read the app's database, so it does NOT
search for the chamber's matters. Instead it downloads the published SC lists
for a rolling window of upcoming days and extracts, per (date, list-type,
court): the BENCH (coram) and the court's total/fresh counts. The app then
looks up whatever court/item/type/date Staff entered and fills in the
authoritative bench "as per the causelist".

Writes court-updates.json at the repo root; the app reads it same-origin.
Free: pure fetch + PDF text, no API keys. Drafting aid only — the court's
published list is authoritative.

List-type PDF codes (verified against real 13-07-2026 PDFs):
  Miscellaneous  M_J   |  Regular / Final  F_J  |  Chamber  M_C
  Single Judge   M_S   |  Registrar        M_R  |  Curative & Review  M_CC
Each publishes _1 (main) and, some days, _2 (supplementary).
"""

import copy
import io
import json
import re
import sys
import time
import datetime
import urllib.request

DAILY_BASE = "https://api.sci.gov.in/jonew/cl/{date}/{suffix}.pdf"

# human list-type -> (suffix, variant) to try, main first then supplementary so
# a later supplementary court entry overrides the main one for the same court.
LIST_TYPES = {
    "Miscellaneous":      [("M_J_1", "main"), ("M_J_2", "supp")],
    "Regular":            [("F_J_1", "main"), ("F_J_2", "supp")],
    "Chamber":            [("M_C_1", "main"), ("M_C_2", "supp")],
    "Single Judge":       [("M_S_1", "main"), ("M_S_2", "supp")],
    "Registrar":          [("M_R_1", "main"), ("M_R_2", "supp")],
    "Curative & Review":  [("M_CC_1", "main")],
}

# Fetch every published list for a full week+ of upcoming sitting days, so a
# matter listed several days out (e.g. a call today for a hearing next Tuesday)
# already resolves its cause title the moment the SC publishes that day's list.
WINDOW_DAYS = 12
OUTPUT_FILE = "court-updates.json"
# Bump whenever parse_courts changes how items/benches are extracted. The size-
# based change-detection reuses a cached parse when the PDF is unchanged; without
# this, a parser FIX never reaches already-cached dates (their PDFs don't change).
# A version mismatch forces a full re-parse of every date in the window.
PARSER_VERSION = 16  # bumped: bracketed notes run to "]"; left-over-in-another-court / after-special-bench phrasings
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; courtreach-causelist-bot/1.0)"}

COURT_RE = re.compile(r"COURT\s*NO\.?\s*[:\-]?\s*([0-9]+)", re.I)
CJ_RE    = re.compile(r"CHIEF\s+JUSTICE'?S\s+COURT", re.I)
REG_RE   = re.compile(r"REGISTRAR\s+COURT\s*NO\.?\s*[:\-]?\s*([0-9]+)", re.I)
# coram lines are a judge ("HON'BLE ...") or a registrar officer ("..., REGISTRAR"
# / "REGISTRAR (TIME..."). The registrar form is kept strict so a PARTY name that
# merely contains "registrar" (e.g. "THE SUB REGISTRAR POOYAPPALLY AND ORS.") is
# NOT mistaken for the bench.
JUDGE_RE = re.compile(r"^HON'?BLE\b", re.I)
REGOFF_RE = re.compile(r",\s*REGISTRAR\b|REGISTRAR\s*(\(|$)", re.I)
TOTAL_RE = re.compile(r"total\s*(?:matters)?\s*[:\-]?\s*([0-9]+)", re.I)
FRESH_RE = re.compile(r"fresh\s*(?:matters)?\s*[:\-]?\s*([0-9]+)", re.I)
ITEM_RE  = re.compile(r"^\s*([0-9]{1,4})\b")
SKIP_CORAM = re.compile(r"NOTE|APPRECIATED|ADJOURNMENT|ASSEMBLE|WILL SIT|NORMAL", re.I)

# --- Special Bench time (300-series) --------------------------------------------
# A "SPECIAL BENCH" section (item numbers 301, 302, ... — owner: "300 series is
# for Special Bench cases which are usually time fixed cases") declares its
# sitting time ONCE, right under the judges' names, not per item — real example
# (13-08-2026 list, Court 4): "(TIME : 2:00 PM)" followed later by item 301. A
# court can sit MORE THAN ONE special bench in a day (same list, same court, a
# second bench composition on the next page) and the second one may have no
# clock time at all, only a relative note — real example, same day, same court,
# second bench: "[ THIS SPECIAL BENCH WILL SIT IMMEDIATELY AFTER THE HEARING OF
# SPECIAL BENCH MATTER LISTED AT 2:00 P.M. IN THIS COURT, IS OVER ]" — captured
# and shown verbatim rather than guessed into a computed clock time, since it
# genuinely depends on when the first bench finishes.
SPECIAL_BENCH_RE = re.compile(r"SPECIAL\s+BENCH", re.I)
TIME_RE = re.compile(r"\(\s*TIME\s*:\s*([\d.:]+\s*[AP]\.?M\.?)\s*\)", re.I)
# The relative-timing note is bracketed but the bracket does NOT reliably close on
# the same line — real example wraps "...LISTED AT 2:00" / "P.M. IN THIS COURT,
# IS OVER ]" across two lines of the extracted text. Matched in two steps: does
# this line OPEN the note (with or without also closing it), and — while one is
# open — does a later line CLOSE it.
BRACKET_NOTE_START_RE = re.compile(r"\[\s*(THIS SPECIAL BENCH WILL SIT.*)$", re.I)

# --- "taken up with another item" note --------------------------------------------------
# The causelist itself sometimes says an item will be heard TOGETHER with a different item
# number in the SAME court — real example, Court 1 today: item 58 carries
# "[TO BE TAKEN UP ALONG WITH ITEM NO. 23 I.E. SLP(C) No. 33394-33395/2026]". That is not a
# passover and nobody types it in — it is a published fact, and measuring item 58 by its own
# raw position would show it far away when it is actually called the moment item 23 is
# (owner: "our app needs to take into account such information"). Wraps across lines the
# same way the Special Bench note does — "...SLP(C) No.\n32577/2026 ]" — so it is
# accumulated the same way, but attached to whichever ITEM the note physically sits inside
# (last_item below), not to a forward-looking section like the Special Bench time is.
# Only the ITEM NO. form is resolved to a position; a case-number form ("...ALONG WITH
# SLP(C) No. 32577/2026", no item number given) is left unhandled for now — the stored item
# text often doesn't carry the case number at all (it can fall on its own wrapped line that
# this parser drops), so matching it back to an item number is not reliable yet.
WITH_ITEM_RE = re.compile(r"\bALONG\s*WITH\s+ITEM\s+NO\.?\s*([0-9]{1,4}(?:\.[0-9]{1,3})?)", re.I)
WITH_NOTE_START_RE = re.compile(r"\[([^\]]*\bALONG\s*WITH\b.*)$", re.I)

# --- operational day notes (bench composition / sittings) -------------------------------
# The lists themselves carry the day's operational notices as "NOTE:-" blocks at the foot
# of a court's section — real examples, 25 Sep 2026: "[ HON'BLE MRS JUSTICE V. MOHANA WILL
# SIT IN COURT NO. 17 TO TAKE UP SINGLE JUDGE BENCH/CHAMBER MATTERS AFTER THE NORMAL WORK
# OF THIS COURT IS OVER ]" and "HON'BLE MR. JUSTICE K.V. VISWANATHAN WILL SIT IN SPECIAL
# BENCH IN COURT NO. 6 AT 2:00 P.M." (the latter repeated at the foot of several courts).
# There is no separate daily notices feed for these (the sci.gov.in notices page carries
# only occasional circulars), so this is the authoritative source. A block ends at the
# "NEW DELHI / ADDITIONAL REGISTRAR" sign-off; the KEEP/SKIP filters separate a real
# operational note (a judge sitting elsewhere, a bench change, a court not sitting) from
# the listing-circular boilerplate every page repeats.
NOTE_LINE_RE = re.compile(r"^NOTE\s*:-\s*(.*)$", re.I)
NOTE_END_RE = re.compile(r"^NEW DELHI\b|^ADDITIONAL REGISTRAR|^SUPREME COURT OF INDIA", re.I)
NOTE_KEEP_RE = re.compile(
    r"WILL\s+(?:NOT\s+)?SIT|NOT\s+SITTING|SHALL\s+(?:NOT\s+)?SIT|SPECIAL\s+BENCH|"
    r"ASSEMBLE|COMPOSITION|ON\s+LEAVE|WILL\s+PRESIDE|WILL\s+TAKE\s+UP|"
    r"LEFT\s+OVER\s+MATTERS|FOLLOWING\s+BENCH", re.I)
NOTE_SKIP_RE = re.compile(r"AS\s+PER\s+CIRCULAR|FRESH\s+MATTERS|APPRECIATED|LISTING\s+IS\s+AUTOMATIC", re.I)
NOTE_COURT_RE = re.compile(r"COURT\s*NOS?\.?\s*:?\s*([0-9]{1,2})", re.I)


# Notices about Single Judge / Chamber Judge sittings are deliberately NOT tracked (owner:
# "Ignore any notices of Single Judge or Chamber Judge notings. We are not concerned with when
# they are sitting or not sitting").
IGNORABLE_NOTE_RE = re.compile(r"single\s+judge|\bchambers?\b", re.I)
# A table that follows a NOTE (a "DROP NOTE:-" listing of items shifted to another bench, with
# its "Item No. Case No. Petitioner/Respondent Advocate Shifted to Reason" header) is list
# content, not part of the note — it used to be swallowed into the note's text.
NOTE_JUNK_RE = re.compile(r"\bDROP\s+NOTE\b|^Item\s+No\.|^Case\s+No\.|^Shifted\s+to\b", re.I)
_ABBREV = {"mr", "mrs", "ms", "dr", "hon", "no", "nos", "dt", "sh", "smt", "sri", "vs", "jr", "sr", "st", "m/s", "etc"}


def split_sentences(text):
    """Sentence-split a notice body WITHOUT breaking on 'Mr.', 'K.V.', 'P.M.', 'Court No.' —
    a split only happens before a capital letter, and a fragment ending in an abbreviation or
    an initial is glued back to what follows."""
    parts = re.split(r"(?<=[.;])\s+(?=[A-Z\"'(])", re.sub(r"\s+", " ", text or "").strip())
    out = []
    for frag in parts:
        if out:
            last = out[-1].split(" ")[-1].rstrip(".").lower()
            lastraw = out[-1].split(" ")[-1]
            # "p.m." / "a.m." END a sentence when a mixed-case sentence follows ("... upto 2:55
            # p.m. Special Bench comprising ...") — gluing there merged separate changes and put
            # the wrong time on a bench (7 Oct 2026). In ALL-CAPS causelist text the next word
            # is capitalised anyway ("2.00 P.M. TO TAKE UP"), so there it stays glued.
            ampm = lastraw.lower() in ("a.m.", "p.m.", "am.", "pm.")
            if ampm and re.match(r"[A-Z][a-z]", frag):
                out.append(frag)
                continue
            if last in _ABBREV or re.fullmatch(r"(?:[A-Za-z]\.)+[A-Za-z]?\.?", lastraw):
                out[-1] += " " + frag
                continue
        out.append(frag)
    return [x for x in out if x]


# A court SECTION header is exactly "COURT NO. : 4" (or "CHIEF JUSTICE'S COURT") on its own
# line. The looser COURT_RE matches wrapped note text too ("COURT NO. 3, IF ANY]"), which would
# silently reassign the section in the middle of a note.
SECTION_RE = re.compile(r"^COURT\s*NO\.?\s*:\s*([0-9]{1,2})\s*$", re.I)
SECTION_CJ_RE = re.compile(r"^CHIEF\s+JUSTICE'?S\s+COURT\s*$", re.I)
# A judge-side note about sitting in a special bench elsewhere ("HON'BLE MR. JUSTICE MANOJ
# MISRA WILL SIT IN SPECIAL BENCH IN COURT NO. 4 AFTER ...") belongs to the JUDGE'S OWN court
# — the section it is printed in — not to the venue (owner, 5 Oct 2026: "the notice should come
# up in his Court 10 and not Court 4"). The venue gets the structured special-bench summary.
# Generalised to ANY judge-movement note ("HON'BLE MR. JUSTICE MANMOHAN WILL SIT IN COURT NO.3
# AT 2.00 P.M. TO TAKE UP LEFT OVER MATTERS OF COURT NO. 3" is printed in Court 9 — his own
# court; Court 3 carries its own "left over matters ... by the following bench" note).
SB_SIT_NOTE_RE = re.compile(r"\bWILL\s+SIT\s+IN\b", re.I)


def _section_of(line):
    m = SECTION_RE.match(line)
    if m:
        return str(int(m.group(1)))
    if SECTION_CJ_RE.match(line):
        return "1"
    return None


# ================================================================================
# NOTICE INTERPRETATION — what a notice or NOTE:- actually means, one plain line per court
# --------------------------------------------------------------------------------
# Owner, 7 Oct 2026, showing a court sheet of run-together fragments: "Look at this mess of
# notices. Can you make out what the notices are trying to say. We need better fetching of
# notices and then setting out them here." The SC's daily listing notice is a list of
# PARAGRAPHS, each a self-contained change ("Special Bench comprising ... is constituted in
# Court No. 4 ... at 3:00 p.m. to hear M.A.No.74/2025 ... Hence, Regular benches in Court No. 4
# & Court No. 11 ... will sit upto 2:55 p.m."). Each paragraph is read whole, the sentence
# kinds below are recognised, and the result is rewritten as short lines per court
# ("Special Bench to sit at 3:00 PM — Justices M.M. Sundresh and Aravind Kumar · to hear
# M.A. No. 74/2025 in C.A. No. 14300/2024; regular bench to sit only until 2:55 PM"). Anything
# unrecognised falls back to the tidied sentence itself — never dropped, never guessed.
# Every fact carries `keys` so the same fact from the causelist and from a notice collapses.

CLOCK_RE = re.compile(r"\b(\d{1,2})(?:[.:](\d{2}))?\s*([AaPp])\.?\s*[Mm]\b\.?")
_NAME_STOP = {"AND", "IN", "IS", "WILL", "ON", "CONSTITUTED", "COMPRISING", "WHO", "TO", "AT",
              "OF", "THE", "FOR", "SHALL", "HAS", "HAVE", "WOULD", "SIT", "SITTING", "NOT", "BE",
              "AS", "WITH", "FROM", "INSTEAD", "HENCE", "ACCORDINGLY", "MATTERS", "BENCH"}


def _clean(t):
    return re.sub(r"\s+", " ", (t or "").replace("’", "'").replace("‘", "'")
                  .replace("“", '"').replace("”", '"')).strip()


def fmt_clock(t):
    m = CLOCK_RE.search(t or "")
    if not m:
        return None
    return "{}:{} {}M".format(int(m.group(1)), m.group(2) or "00", m.group(3).upper())


def _title_word(w):
    if re.fullmatch(r"(?:[A-Za-z]\.)+", w):          # initials: M.M. / N.V.
        return w.upper()
    return w[:1].upper() + w[1:].lower() if w.isupper() and len(w) > 1 else w


def judges_in(text):
    """Every judge named, in order, as 'Justice X' (or 'the Chief Justice'). Copes with the
    notices' own slips ("Hon'ble Aravind Kumar" — no "Justice") and ALL-CAPS causelist text."""
    out = []
    t = _clean(text)
    for m in re.finditer(r"HON'?BLE\s+", t, re.I):
        rest = t[m.end():]
        if re.match(r"(?:THE\s+)?CHIEF\s+JUSTICE\b", rest, re.I):
            name = "the Chief Justice"
        else:
            rest = re.sub(r"^(?:(?:MR|MRS|MS|DR)\.?\s+)?(?:JUSTICE\s+)?", "", rest, flags=re.I)
            words = []
            for tok in rest.split(" "):
                bare = tok.strip(",;.()")
                if not bare or bare.upper() in _NAME_STOP or re.match(r"\d", bare) or tok.startswith("(") \
                        or bare in ("—", "–", "-") or re.match(r"HON'?BLE$", bare, re.I):
                    break
                words.append(_title_word(bare if not re.fullmatch(r"(?:[A-Za-z]\.)+", tok.rstrip(",;")) else tok.rstrip(",;")))
                if tok.endswith(",") or tok.endswith(";") or (tok.endswith(".") and not re.fullmatch(r"(?:[A-Za-z]\.)+", tok)):
                    break
            if not words:
                continue
            name = "Justice " + " ".join(words)
        if name not in out:
            out.append(name)
    return out


def names_phrase(js):
    if not js:
        return ""
    if all(j.startswith("Justice ") for j in js) and len(js) > 1:
        bare = [j[len("Justice "):] for j in js]
        return "Justices " + (", ".join(bare[:-1]) + " and " + bare[-1])
    return js[0] if len(js) == 1 else ", ".join(js[:-1]) + " and " + js[-1]


def _bench_kind(t):
    if re.search(r"constitution\s+bench", t, re.I):
        return "Constitution Bench"
    if re.search(r"special\s+bench", t, re.I):
        return "Special Bench"
    if re.search(r"single\s+judge", t, re.I):
        return "Single Judge Bench"
    return "Bench"


def _tidy_case(t):
    t = re.sub(r"\b(M\.A|C\.A|W\.P|S\.L\.P|T\.P|Crl\.A|R\.P)\.?\s*No\.?\s*", lambda m: m.group(1) + ". No. ", t)
    t = re.sub(r"\bDiary\s*No\.?\s*", "Diary No. ", t, flags=re.I)
    t = re.sub(r"\b(M\.A|C\.A|W\.P)\.(?=Diary)", r"\1. ", t)
    return t.strip(" .")


def _venue(t):
    m = re.search(r"\bin\s+Court\s+No\.?\s*:?\s*(\d{1,2})\b", t, re.I)
    if m:
        return str(int(m.group(1)))
    if re.search(r"Chief\s+Justice'?s\s+Court", t, re.I):
        return "1"
    return None


def interpret_sentence(s, section=None):
    """[{courts, text, keys, sb?}] for one sentence; [] when it is about Single Judge /
    Chamber matters; None when no template matches (caller falls back to the sentence)."""
    t = _clean(s)
    if IGNORABLE_NOTE_RE.search(t):
        return []
    named = courts_in(t)
    clock = fmt_clock(t)
    js = judges_in(t)

    # 1. a bench cancelled
    if re.search(r"\b(?:stands|is|has\s+been)\s+cancell?ed\b", t, re.I):
        kind = _bench_kind(t)
        v = _venue(t) or (named[0] if named else section)
        if not v:
            return None
        who = names_phrase(js) if len(js) <= 3 else "{} judges".format(len(js))
        return [{"courts": [v], "text": "{}{}{} is cancelled".format(
                    kind, " of " + who if who else "", " at " + clock if clock else ""),
                 "keys": ["cancel|{}|{}".format(v, clock)]}]

    # 2. a bench constituted (Special / Constitution / a fresh division bench)
    if re.search(r"\bconstituted\s+in\b", t, re.I):
        kind = _bench_kind(t)
        v = _venue(t) or (named[0] if named else section)
        if not v:
            return None
        pm = re.search(r"\bto\s+hear\s+(.+)$", t, re.I)
        purpose = _tidy_case(pm.group(1)) if pm else ""
        if clock:
            txt = "{} to sit at {} — {}{}".format(kind, clock, names_phrase(js), " · to hear " + purpose if purpose else "")
        else:
            txt = "{}{} to sit{}".format(kind, " of " + names_phrase(js) if js else "", " — to hear " + purpose if purpose else "")
        f = {"courts": [v], "text": txt, "keys": ["bench|{}".format(v)]}
        if kind == "Special Bench":
            f["sb"] = {"venue": v, "judges": js, "at": clock, "after": [], "extra": []}
        return [f]

    # 3. matters re-assigned to a recomposed bench
    rm = re.search(r"will\s+now\s+be\s+taken\s+up.*?\bby\s+the\s+bench\s+comprising\s+(.+)$", t, re.I)
    if rm:
        v = _venue(t) or (named[0] if named else section)
        old = judges_in(t[:rm.start()])
        new = judges_in(rm.group(1))
        if not v or not new:
            return None
        add = [j for j in new if j not in old]
        gone = [j for j in old if j not in new]
        diff = ""
        if add and gone:
            diff = " — {} in place of {}".format(names_phrase(add), names_phrase(gone))
        elif add:
            diff = " — {} {} the bench".format(names_phrase(add), "joins" if len(add) == 1 else "join")
        elif gone:
            diff = " — {} not sitting".format(names_phrase(gone))
        return [{"courts": [v], "text": "Bench today: {}{}".format(names_phrase(new), diff),
                 "keys": ["recomp|{}".format(v)]}]

    # 4. a bench moved to another court room
    mv = re.search(r"will\s+sit\s+in\s+Court\s+No\.?\s*(\d{1,2})\s+instead\s+of\s+Court\s+No\.?\s*(\d{1,2})", t, re.I)
    if mv:
        to, frm = str(int(mv.group(1))), str(int(mv.group(2)))
        um = re.search(r"up\s*to\s+(.+)$", t, re.I)
        until = fmt_clock(um.group(1)) if um else None
        who = names_phrase(js)
        return [{"courts": [to], "text": "{} to sit here instead of Court {}{}".format(
                    who or "The bench", frm, ", until " + until if until else ""),
                 "keys": ["moved|{}".format(to)]},
                {"courts": [frm], "text": "{} to sit in Court {}, not here".format(who or "The listed bench", to),
                 "keys": ["movedfrom|{}".format(frm)]}]

    # 5. regular bench(es) sit only until a time
    um = re.search(r"\bwill\s+sit\s+up\s*to\s+(\d{1,2}(?:[.:]\d{2})?\s*[AaPp]\.?\s*[Mm]\.?)", t, re.I)
    # "JUSTICE X WILL SIT IN COURT NO. 18 ... AND THIS BENCH WILL SIT UPTO 3:55" — the time is
    # that moving bench's, not the regular bench of every court named; branch 8 handles it
    if um and re.search(r"WILL\s+SIT\s+IN\s+(?:SPECIAL\s+BENCH\s+IN\s+)?(?:THIS\s+COURT|COURT\s+NO)", t, re.I) and js:
        um = None
    if um:
        until = fmt_clock(um.group(1))
        cs = named or ([section] if section else [])
        if not cs:
            return None
        return [{"courts": [c], "text": "Regular bench to sit only until {}".format(until),
                 "keys": ["until|{}|{}".format(c, until)]} for c in cs]

    # 6. a bench sits the whole day
    if re.search(r"will\s+sit\s+for\s+the\s+whole\s+day", t, re.I):
        cs = [_venue(t)] if _venue(t) else (named or ([section] if section else []))
        if not cs:
            return None
        return [{"courts": [c], "text": "Regular bench to sit for the entire day{}".format(
                    " — " + names_phrase(js) if js else ""), "keys": ["wholeday|{}".format(c)]} for c in cs]

    # 7. a judge not holding court
    if re.search(r"will\s+not\s+be\s+holding\s+(?:the\s+)?court|will\s+not\s+sit\b", t, re.I) and js:
        cs = named or ([section] if section else [])
        return [{"courts": cs, "text": "{} is not sitting today".format(js[0]),
                 "keys": ["absent|{}".format(js[0])]}] if cs else None

    # 8. a judge moving: to a special bench, or to take up another court's left-over matters
    jm = re.search(r"WILL\s+SIT\s+IN\s+(SPECIAL\s+BENCH\s+IN\s+)?(THIS\s+COURT|COURT\s+NO\.?\s*(\d{1,2}))", t, re.I)
    if jm and js:
        dest = section if re.match(r"THIS", jm.group(2), re.I) else str(int(jm.group(3)))
        lm = re.search(r"LEFT\s+OVER\s+MATTERS\s+OF\s+(THIS\s+COURT|COURT\s+NO\.?\s*(\d{1,2}))", t, re.I)
        if jm.group(1):                                  # special bench
            if dest and dest == section:
                txt = "{} to sit in the Special Bench here{}".format(js[0], " at " + clock if clock else "")
            else:
                txt = "{} to leave{} for the Special Bench in Court {}".format(
                    js[0], " at " + clock if clock else "", dest)
            return [{"courts": [section] if section else [dest], "text": txt,
                     "keys": ["sbjoin|{}|{}".format(js[0], dest)]}]
        if lm:
            of = section if re.match(r"THIS", lm.group(1), re.I) else str(int(lm.group(2)))
            um2 = re.search(r"\bsit\s+up\s*to\s+(.+)$", t, re.I)
            until = fmt_clock(um2.group(1)) if um2 else None
            txt = "{} to sit in Court {}{} to take up {}'s left-over matters{}".format(
                js[0], dest, " from " + clock if clock else "", "this court" if of == section else "Court " + str(of),
                ", until " + until if until else "")
            cs = sorted({c for c in (section, of) if c}, key=int)
            return [{"courts": cs, "text": txt, "keys": ["leftover|{}|{}".format(js[0], of)]}]
        cs = [section] if section else [dest]
        return [{"courts": cs, "text": "{} to sit in Court {}{}".format(js[0], dest, " at " + clock if clock else ""),
                 "keys": ["sits|{}|{}".format(js[0], dest)]}]

    # 9. left-over matters taken up by a named bench at a time
    if re.search(r"LEFT\s+OVER\s+MATTERS", t, re.I) and re.search(r"FOLLOWING\s+BENCH|BY\s+THE\s+BENCH", t, re.I) and section:
        room = re.search(r"TAKEN\s+UP\s+IN\s+COURT\s+NO\.?\s*(\d{1,2})", t, re.I)
        if re.search(r"ASSEMBLE\s+AFTER\s+THE\s+HEARING\s+IN\s+SPECIAL\s+BENCH", t, re.I):
            # the clock here is the SPECIAL BENCH's sitting, not when left-overs begin
            when = " after the Special Bench hearing here{} is over".format(" (" + clock + ")" if clock else "")
        else:
            when = " from " + clock if clock else ""
        return [{"courts": [section], "text": "Left-over matters to be taken up{}{} by {}".format(
                    " in Court " + str(int(room.group(1))) if room else "", when,
                    names_phrase(js) if js else "another bench"),
                 "keys": ["leftover|bench|{}".format(section)]}]
    return None


def _sentence_case(t):
    """A readable fallback for an ALL-CAPS note nothing above recognised."""
    if t.upper() != t:
        return t
    out = t.lower()
    out = re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), out)
    out = re.sub(r"\bhon'?ble\b", "Hon'ble", out)
    out = re.sub(r"\bjustice\s+((?:[a-z.]+\s?){1,4})", lambda m: "Justice " + " ".join(_title_word(w.upper()) for w in m.group(1).split()), out)
    out = re.sub(r"\bcourt no\.", "Court No.", out)
    out = re.sub(r"\b(\d{1,2})[.:](\d{2})\s*p\.?\s*m\.?", lambda m: "{}:{} PM".format(m.group(1), m.group(2)), out)
    out = re.sub(r"\b(\d{1,2})[.:](\d{2})\s*a\.?\s*m\.?", lambda m: "{}:{} AM".format(m.group(1), m.group(2)), out)
    return out


def interpret_paragraph(para, section=None, fallback_courts=None):
    """Facts for one notice paragraph (or one causelist note), merged per court:
    "Special Bench to sit at 3:00 PM — ...; regular bench to sit only until 2:55 PM"."""
    para = _clean(para)
    sents = split_sentences(para)
    facts, unknown = [], []
    for sn in sents:
        r = interpret_sentence(sn, section)
        if r is None:
            unknown.append(sn)
        else:
            facts.extend(r)
    # a Special/Constitution bench in this paragraph explains why OTHER courts stop early
    benches = [f for f in facts if f["keys"][0].startswith("bench|")]
    out, by_court = [], {}
    for f in facts:
        for c in f["courts"]:
            if c not in by_court:
                by_court[c] = {"courts": [c], "parts": [], "keys": [], "sb": None}
                out.append(by_court[c])
            text = f["text"]
            if f["keys"][0].startswith("until|") and benches:
                b = benches[0]
                bv = b["courts"][0]
                if bv != c:
                    m = re.search(r" at (\d{1,2}:\d{2} [AP]M)", b["text"])
                    text += " (Special Bench in Court {}{})".format(bv, " at " + m.group(1) if m else "")
                else:
                    text = text[0].lower() + text[1:]
            by_court[c]["parts"].append(text)
            by_court[c]["keys"] += f["keys"]
            if f.get("sb"):
                by_court[c]["sb"] = f["sb"]
    notes = []
    for g in out:
        n = {"courts": g["courts"], "text": "; ".join(g["parts"]), "keys": g["keys"]}
        if g["sb"]:
            n["sb"] = g["sb"]
        notes.append(n)
    if unknown:
        cs = sorted(set(courts_in(" ".join(unknown))) | ({section} if section else set()), key=int) or list(fallback_courts or [])
        if cs:
            rest = _sentence_case(" ".join(unknown))
            if len(rest) > 500:
                cut = rest[:500].rsplit(". ", 1)[0]
                rest = (cut if len(cut) > 200 else rest[:500].rsplit(" ", 1)[0]) + " …"
            notes.append({"courts": cs, "text": rest, "keys": ["raw|" + re.sub(r"[^A-Z0-9]", "", rest.upper())[:80]]})
    return notes


def bench_summaries(specials):
    """The venue court's own line for each special bench read from the causelist ("Special
    Bench sits here after the normal work of Courts 4, 10 & 16 is over — Justices M.M.
    Sundresh, Manoj Misra and Satish Chandra Sharma"). Keyed bench|<venue>, so a notice about
    the same bench replaces it."""
    out = []
    for b in specials:
        after = b.get("after") or []
        if after:
            cs = after if len(after) == 1 else after[:-1]
            when = "after the normal work of {} is over".format(
                "Court " + after[0] if len(after) == 1 else "Courts " + ", ".join(cs) + " & " + after[-1])
        elif b.get("at"):
            when = "at " + (fmt_clock(b["at"]) or b["at"])
        else:
            when = "today"
        parts = ["Special Bench to sit {}{}".format(when, " — " + names_phrase(b["judges"]) if b.get("judges") else "")]
        parts += [_sentence_case(x) for x in (b.get("extra") or [])]
        out.append({"courts": [b["venue"]], "text": "; ".join(parts), "keys": ["bench|" + b["venue"]]})
    return out


def merge_notes(existing, new):
    """Add `new` facts to a day's notes; any older note that states one of the same facts for
    the same court is replaced — a notice is the later, fuller word."""
    nk = {c + "#" + k for c in new["courts"] for k in new.get("keys", [])}
    keep = []
    for n in existing:
        ok = {c + "#" + k for c in n["courts"] for k in n.get("keys", [])}
        if ok and ok & nk:
            rest = [c for c in n["courts"] if not ({c + "#" + k for k in n.get("keys", [])} & nk)]
            if rest:
                n = dict(n, courts=rest)
                keep.append(n)
            continue
        keep.append(n)
    keep.append(new)
    return keep


def finalize_notes(notes):
    """Drop a judge's "to sit in the Special Bench here" line where that court already has the
    bench's own line naming him — it says nothing new."""
    bench_text = {}
    for n in notes:
        for c in n["courts"]:
            if "bench|" + c in n.get("keys", []):
                bench_text[c] = n["text"]
    out = []
    for n in notes:
        ks = n.get("keys", [])
        if ks and all(k.startswith("sbjoin|") for k in ks):
            j = ks[0].split("|")[1].replace("Justice ", "")
            if all(c in bench_text and j in bench_text[c] for c in n["courts"]):
                continue
        out.append(n)
    return out


def notice_paragraphs(data):
    """A notice PDF's paragraphs, by layout: each paragraph's first line is indented (x0
    ~110pt) past the body margin (~74pt); centred/right lines (title, "Dated", "Contd...2/-",
    "-2-", "By order", the signatory) sit further right and are skipped. [] when the PDF has no
    text layer (a scan) — the caller then uses the homepage title."""
    try:
        import pdfplumber
        lines = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for pg in pdf.pages:
                lines += [(ln["x0"], ln["text"]) for ln in pg.extract_text_lines()]
    except Exception:
        return []
    body = [x for x, tx in lines if len(tx) > 40]
    if not body:
        return []
    margin = min(body)
    drop = re.compile(r"^(SUPREME COURT OF INDIA|NOTICE$|Dated\s*:|By order|sd/?-|Copy to|Contd|-\s*\d+\s*-|"
                      r"(?:Additional|Assistant|Deputy)\s+Registrar|Registrar\b)", re.I)
    paras = []
    for x, tx in lines:
        tx = tx.strip()
        if not tx or drop.match(tx) or x > margin + 120:
            continue
        if x >= margin + 15 or not paras:
            paras.append(tx)
        else:
            paras[-1] += " " + tx
    return [p for p in (re.sub(r"\s+", " ", q).strip() for q in paras) if len(p) > 20]


def parse_day_notes(text):
    """[{'text': ..., 'courts': [...]}] — deduped operational notes from NOTE:- blocks.

    A NOTE:- block can carry several bracketed notes separated by "." lines, and a note can be
    followed by the judges it names ("[LEFT OVER MATTERS ... WILL BE TAKEN UP BY THE FOLLOWING
    BENCH AT 2.00 P.M.] . HON'BLE MRS. JUSTICE B.V. NAGARATHNA / HON'BLE MR. JUSTICE MANMOHAN")
    — those judges are appended to that note. Attribution: always the section court it is
    printed in; a special-bench SITTING note goes ONLY there (the judge's own court), any other
    note also to the courts it names. A block inside a special bench's own section header
    ("[ SPECIAL BENCH ] . [ THIS BENCH WILL ASSEMBLE AFTER ...]") is skipped here — that court
    is described by parse_special_benches() instead."""
    out, seen = [], set()
    cur = None            # section court
    in_block = False      # inside a NOTE:- block
    sb_block = False      # this block is a special bench's own section header
    acc = None            # current note text being accumulated
    bracketed = False     # the open note began with "[" — it runs to its "]", whatever follows
    taken = 0
    last = None           # last emitted note (to append trailing judge names)
    struct = re.compile(r"^(MISCELLANEOUS\s+HEARING|REGULAR\s+HEARING|SUPPLEMENTARY\s+LIST|SNo\.|"
                        r"Petitioner\s*/\s*Respondent|Advocate$)", re.I)

    def flush():
        nonlocal acc, last
        t = re.split(r"\bDROP\s+NOTE\b", re.sub(r"\s+", " ", acc or ""), maxsplit=1, flags=re.I)[0].strip(" []-·.")
        acc = None
        last = None
        if not t or len(t) < 15:
            return
        if re.fullmatch(r"\s*SPECIAL\s+BENCH\s*", t, re.I):
            return
        if sb_block:
            return
        if NOTE_SKIP_RE.search(t) or not NOTE_KEEP_RE.search(t) or IGNORABLE_NOTE_RE.search(t):
            return
        named = set(str(int(c)) for c in NOTE_COURT_RE.findall(t))
        if cur:
            courts = {cur} if SB_SIT_NOTE_RE.search(t) else ({cur} | named)
        else:
            courts = named
        courts = sorted(courts, key=int)
        key = ",".join(courts) + "|" + re.sub(r"[^A-Z0-9]", "", t.upper())
        if key in seen:
            return
        seen.add(key)
        last = {"text": t[:600], "courts": courts, "section": cur}
        out.append(last)

    def end_block():
        nonlocal in_block, sb_block, last
        if acc is not None:
            flush()
        in_block = sb_block = False
        last = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        sec = _section_of(line)
        if sec is not None:
            end_block()
            cur = sec
            continue
        m = NOTE_LINE_RE.match(line)
        if m:
            end_block()
            in_block, taken = True, 0
            frag = (m.group(1) or "").strip()
            if frag:
                acc, bracketed = frag, frag.startswith("[")
                if "]" in frag:
                    acc = frag[:frag.find("]")]
                    if re.fullmatch(r"\[?\s*SPECIAL\s+BENCH\s*", acc, re.I):
                        sb_block = True
                    flush()
            continue
        if not in_block:
            continue
        # A wrapped note line can START with a number ("[... WILL BE TAKEN UP IN COURT NO." /
        # "18 AT 2.00 P.M. BY THE FOLLOWING BENCH]", 8 Oct 2026) — inside an open bracket that is
        # note text, not an item row; reading it as an item cut the note off mid-sentence.
        if NOTE_END_RE.match(line) or struct.match(line) or NOTE_JUNK_RE.search(line) or \
                (ITEM_LINE_RE.match(line) and not (acc is not None and bracketed)):
            end_block()
            continue
        if acc is not None:
            # an unbracketed note ends at a "." separator, a new bracket or a new judge
            # sentence — they used to be glued together ("... AT 2.00 P.M. . HON'BLE MR. ...")
            if line in (".", "-", "*") or line.startswith("[") or \
                    (JUDGE_RE.match(line) and NOTE_KEEP_RE.search(line)):
                flush()
                if line in (".", "-", "*"):
                    continue
            else:
                close = line.find("]")
                if close >= 0:
                    acc += " " + line[:close]
                    flush()
                elif taken >= 6:
                    end_block()
                else:
                    acc += " " + line
                    taken += 1
                continue
        # between notes inside the block
        if line in (".", "-", "*"):
            continue
        if line.startswith("["):
            body = line[1:]
            if re.match(r"\s*SPECIAL\s+BENCH\s*\]?\s*$", body, re.I):
                sb_block = True
                continue
            acc, taken, bracketed = body, 0, True
            if "]" in body:
                acc = body[:body.find("]")]
                flush()
            continue
        if JUDGE_RE.match(line) and not NOTE_KEEP_RE.search(line):
            if last is not None:
                last["text"] = (last["text"] + " — " + re.sub(r"\s+", " ", line)).strip()[:400]
            continue
        # an unbracketed note sentence ("HON'BLE MR. JUSTICE K.V. VISWANATHAN WILL SIT ...")
        acc, taken, bracketed = line, 0, False
    if acc is not None:
        flush()
    # interpret each raw note into plain per-court lines; the same FACT printed in several
    # courts' sections (or in main and supplementary lists) collapses to one
    final, done = [], set()
    for r in out:
        for n in interpret_paragraph(r["text"], section=r.get("section"), fallback_courts=r["courts"]):
            ks = {c + "#" + k for c in n["courts"] for k in n["keys"]}
            if ks <= done:
                continue
            done |= ks
            final.append(n)
    return final


def _judge_name(line):
    n = re.sub(r"^HON'?BLE\s+(?:THE\s+)?(?:MR\.?|MRS\.?|MS\.?|DR\.?)?\s*", "", line.strip(), flags=re.I)
    n = re.sub(r"^JUSTICE\s+", "", n, flags=re.I).strip(" ,.")
    if re.match(r"^CHIEF\s+JUSTICE$", n, re.I):
        return "The Chief Justice"
    return "Justice " + n.title()


def parse_special_benches(text):
    """Special benches described by their OWN section header in the venue court — e.g.
    COURT NO. : 4 / HON'BLE MR. JUSTICE M.M. SUNDRESH / ... MANOJ MISRA / ... SATISH CHANDRA
    SHARMA / NOTE:- [ SPECIAL BENCH ] . [ THIS BENCH WILL ASSEMBLE AFTER THE NORMAL WORK OF
    THIS COURT, COURT NO. 10 AND COURT NO. 16 IS OVER ]. Returns
    [{venue, judges, at, after, extra}] — `after` is every court whose normal work must finish
    first (THIS COURT = the venue), `at` a clock time when one is declared, `extra` any other
    note printed in that header ("LEFT OVER MATTERS OF THIS COURT WILL BE TAKEN UP ... BY THIS
    SPECIAL BENCH"). Page headers repeat, so results are deduped."""
    out, seen = [], set()
    struct = re.compile(r"^(MISCELLANEOUS\s+HEARING|REGULAR\s+HEARING|SUPPLEMENTARY\s+LIST|SNo\.|"
                        r"Petitioner\s*/\s*Respondent)", re.I)
    region, court = None, None

    def analyse():
        if not region or not court:
            return
        blob = re.sub(r"\s+", " ", " ".join(region))
        if not re.search(r"\[\s*SPECIAL\s+BENCH\s*\]|THIS\s+SPECIAL\s+BENCH|NOTE\s*:-\s*SPECIAL\s+BENCH", blob, re.I):
            return
        judges = []
        for l in region:
            if JUDGE_RE.match(l) and not NOTE_KEEP_RE.search(l):
                judges.append(_judge_name(l))
            elif judges:
                break
        tm = TIME_RE.search(blob)
        at = re.sub(r"\s+", " ", tm.group(1)).strip().upper() if tm else None
        after = []
        am = re.search(r"AFTER\s+THE\s+NORMAL\s+WORK\s+OF\s+(.*?)\s+(?:IS|ARE)\s+OVER", blob, re.I)
        if am:
            clause = am.group(1)
            after = set(courts_in(clause))
            if re.search(r"THIS\s+COURT", clause, re.I):
                after.add(court)
            after = sorted(after, key=int)
        extra = []
        for b in re.findall(r"\[([^\]]+)\]", blob):
            b = re.sub(r"\s+", " ", b).strip(" .")
            if re.fullmatch(r"SPECIAL\s+BENCH", b, re.I) or re.search(r"AFTER\s+THE\s+NORMAL\s+WORK", b, re.I):
                continue
            if NOTE_SKIP_RE.search(b) or IGNORABLE_NOTE_RE.search(b) or len(b) < 15:
                continue
            extra.append(b[:300])
        key = (court, tuple(judges), at, tuple(after))
        if key in seen:
            return
        seen.add(key)
        out.append({"venue": court, "judges": judges, "at": at, "after": after, "extra": extra})

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        sec = _section_of(line)
        if sec is not None:
            analyse()
            court, region = sec, []
            continue
        if region is None:
            continue
        if struct.match(line) or ITEM_LINE_RE.match(line) or len(region) > 25:
            analyse()
            region = None
            continue
        region.append(line)
    analyse()
    return out


# --- homepage "Listing Notices" (mentioning lists, bench changes, cancellations) --------
# The DAILY operational notices are indexed on the sci.gov.in HOMEPAGE's "Listing Notices"
# strip, NOT on the notices-and-circulars archive (which carries only occasional circulars)
# — owner supplied two live examples, 25 Sep 2026: "List of oral mentioning matters before
# Hon'ble Courts on 25.09.2026" and "Notice regarding cancellation of Special Bench in
# Court No.9 and Single Judge Bench in Court No. 8". The upload URLs are unpredictable
# (an upload counter), so the homepage anchors are the one stable discovery point: title +
# PDF link, with the effective DATE in the title.
SC_HOME = "https://www.sci.gov.in/"
# A mentioning list numbers matters "<court>.<801+>" ("2.801", "16.801") — court and
# 800-series item in one self-identifying token at the start of the entry's line.
MENT_ITEM_RE = re.compile(r"^\s*([0-9]{1,2})\.(8[0-9]{2})\b\s*(.*)$")


def parse_home_notices(html):
    """[{'title':..., 'url':...}] — every homepage anchor to an uploaded notice PDF."""
    out, seen = [], set()
    for m in re.finditer(r'<a[^>]+href="(https://cdn[^"]+/uploads/[^"]+\.pdf)"[^>]*>(.*?)</a>',
                         html, re.S | re.I):
        url = m.group(1)
        title = re.sub(r"<[^>]+>", " ", m.group(2))
        title = title.replace("&#8217;", "'").replace("&#8216;", "'").replace("&amp;", "&")
        title = re.sub(r"\s+", " ", title).strip()
        title = re.sub(r"^Listing\s+Notices\s*", "", title, flags=re.I)
        title = re.sub(r"\s*-\s*\d{1,2}\s+\w+,\s*\d{4}\s*$", "", title).strip()
        if not title or url in seen:
            continue
        seen.add(url)
        out.append({"title": title, "url": url})
    return out


# www.sci.gov.in's firewall answers 403 to the bot User-Agent the rest of this script uses
# (api.sci.gov.in and the upload CDN accept it) — verified 5 Oct 2026: the first live run of
# the homepage fetch silently came back empty, so that day's mentioning list and "change in
# Court No.2" notice never reached the app. The homepage alone gets a browser User-Agent.
HOME_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                              "(KHTML, like Gecko) Chrome/126 Safari/537.36"}


NOTICE_TITLE_KEEP_RE = re.compile(
    r"\bchanges?\b|cancel|not\s+(?:be\s+)?(?:sit|sitting|holding)|composition|re-?constitut|"
    r"special\s+bench|\bsitting\b", re.I)
NOTICE_TITLE_SKIP_RE = re.compile(r"helpline|advance\s+list", re.I)


def fetch_home_notices():
    try:
        req = urllib.request.Request(SC_HOME, headers=HOME_HEADERS)
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = parse_home_notices(resp.read().decode("utf-8", "replace"))
        if not out:
            print("WARNING: sci.gov.in homepage fetched but no listing notices parsed")
        return out
    except Exception as e:
        # loud, not silent — a quiet [] here is exactly how the first failure went unnoticed
        print("WARNING: sci.gov.in homepage fetch failed: {}: {}".format(type(e).__name__, e))
        return []


def title_dates(title):
    """ISO dates a notice title names — '25.09.2026', '25.9.26', '25-09-2026' all count."""
    out = set()
    for d, mn, y in re.findall(r"\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b", title):
        y = int(y) + (2000 if int(y) < 100 else 0)
        try:
            out.add(datetime.date(y, int(mn), int(d)).strftime("%Y-%m-%d"))
        except ValueError:
            pass
    return out


def parse_mentioning(text):
    """{court: {'801': 'case line...'}} from a mentioning-list PDF's text."""
    out = {}
    for line in (text or "").splitlines():
        m = MENT_ITEM_RE.match(line)
        if m:
            court, item = str(int(m.group(1))), m.group(2)
            rest = re.sub(r"\s+", " ", m.group(3)).strip()
            out.setdefault(court, {}).setdefault(item, rest[:80])
    return out


def courts_in(text):
    """Every court a notice names — handles 'Court Nos. 9, 13 & 15' runs and the Chief
    Justice's Court (court 1), which is never given a number."""
    courts = set()
    for run in re.findall(r"COURT\s*NOS?\.?\s*:?\s*((?:\d{1,2}\s*[,&]?\s*(?:and\s+)?)+)", text, re.I):
        for c in re.findall(r"\d{1,2}", run):
            courts.add(str(int(c)))
    if CJ_RE.search(text):
        courts.add("1")
    return sorted(courts, key=int)


# Page-header boilerplate repeated at the top of every page. When an item's
# "Versus" sits at the foot of a page, this line is the first thing after it and
# was wrongly captured as the respondent ("… VERSUS DAILY CAUSE LIST FOR DATED …").
# Skip it wholesale so the real respondent (further down the next page) is used.
HEADER_SKIP = re.compile(r"DAILY\s+CAUSE\s+LIST", re.I)


def is_coram(line):
    if SKIP_CORAM.search(line):
        return False
    return bool(JUDGE_RE.match(line) or REGOFF_RE.search(line))


def fetch_pdf(url):
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as resp:
            ct = resp.headers.get("Content-Type", "").lower()
            if resp.status == 200 and ct.startswith("application/pdf"):
                return resp.read()
    except Exception:
        pass
    return None


def probe_size(url):
    """Cheap change-detection: a 1KB ranged GET. Returns the PDF's total size,
    or None if the list isn't published (the server answers 200/HTML for
    missing files). Lets a frequent schedule re-download a multi-MB list ONLY
    when the court actually re-published it."""
    try:
        req = urllib.request.Request(url, headers={**HEADERS, "Range": "bytes=0-1023"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            ct = resp.headers.get("Content-Type", "").lower()
            if not ct.startswith("application/pdf"):
                return None
            m = re.search(r"/(\d+)\s*$", resp.headers.get("Content-Range", ""))
            if m:
                return int(m.group(1))
            cl = resp.headers.get("Content-Length")   # server ignored Range
            return int(cl) if cl else len(resp.read())
    except Exception:
        return None


def pdf_to_text(data):
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            return "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception:
        pass
    try:
        from pypdf import PdfReader
        return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages)
    except Exception as e:
        print("  PDF extraction failed:", e)
        return ""


# The SC list is a two-column table: party text on the left, the ADVOCATE on the
# right (a fixed column starting at x0 ~= 426 on a 595pt page). Plain extract_text
# flattens the columns onto one line, so the advocate name bleeds into the cause
# title ("VIRENDRA SINGH NAGAR RAJ KISHOR CHOUDHARY"). We can't tell party from
# advocate by text alone, but we can by x-position. So for ITEM rows we drop every
# word at/after the advocate column; header/coram rows are kept whole (a right-
# positioned officer line like "ADDITIONAL REGISTRAR" must not be truncated).
ADV_COL_X = 415   # advocate column left edge (words at/after this are the advocate)
SNO_COL_X = 60    # an item row's serial number sits in the far-left margin
ITEM_SNO_RE = re.compile(r"^[0-9]{1,4}(?:\.[0-9]{1,3})?[.\)]?$")
ADV_SNO_RE = re.compile(r"^([0-9]{1,4}(?:\.[0-9]{1,3})?)[.\)]?$")  # same, capturing the number


def pdf_texts(data):
    """(column_text, full_text) from ONE pdfplumber pass. column_text drops the advocate
    column from item rows (for cause titles); full_text keeps every row whole. NOTE:- blocks
    and special-bench headers must be read from full_text: a long note line printed after an
    item row spills past the advocate-column edge and was being cut off mid-sentence (7 Oct
    2026: "HON'BLE MR. JUSTICE PRASHANT KUMAR MISHRA WILL SIT IN SPECIAL BENCH IN" — the rest,
    "THIS COURT AT 3.00 P.M.", sat in the dropped column). (None, None) without pdfplumber."""
    try:
        import pdfplumber
    except Exception:
        return None, None
    try:
        out, whole = [], []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                rows = {}
                for w in page.extract_words(use_text_flow=True):
                    rows.setdefault(round(w["top"] / 2), []).append(w)
                in_items = False
                for key in sorted(rows):
                    ws = sorted(rows[key], key=lambda w: w["x0"])
                    full = " ".join(w["text"] for w in ws)
                    whole.append(full)
                    if REG_RE.search(full) or COURT_RE.search(full) or CJ_RE.search(full):
                        in_items = False           # a court header — coram follows
                    elif ws[0]["x0"] < SNO_COL_X and ITEM_SNO_RE.match(ws[0]["text"]):
                        in_items = True            # a serial-numbered item row
                    if in_items:
                        out.append(" ".join(w["text"] for w in ws if w["x0"] < ADV_COL_X))
                    else:
                        out.append(full)
        return "\n".join(out), "\n".join(whole)
    except Exception as e:
        print("  column extraction failed:", e)
        return None, None


def pdf_to_column_text(data):
    """Rebuild the PDF text, dropping the advocate column from item rows only (see
    pdf_texts). Returns None if word-level extraction isn't available."""
    return pdf_texts(data)[0]


# an item number, optionally a sub-item ("37" or "37.1"). "37.1 Connected .."
# sub-items are captured as their own keys so the clerk can enter either the
# main item or a specific sub-item.
ITEM_LINE_RE = re.compile(r"^([0-9]{1,4}(?:\.[0-9]{1,3})?)[.\)]?\s+(.+)$")
# Regular (F_J) lists number connected matters differently from Misc: the main
# item is "102 SLP(Crl) No. ..." and each connected matter is written as
# "102. Connected <PARTY>" followed by a line whose leading number is the
# sub-index, e.g. "2 SLP(Crl) No. 8718/2021" -> sub-item 102.2. We must capture
# every one of these so a clerk entering item 102.2 gets its cause title.
CONNECTED_RE = re.compile(r"^([0-9]{1,4})\.\s+Connected\s+(.+)$", re.I)
SUBINDEX_RE = re.compile(r"^([0-9]{1,3})\b\s*(.*)$")


def parse_courts(text):
    """Text of one list PDF ->
       {court(str): {coram, total, fresh, items:{item(str): case-line},
                      times:{item(str): time-or-note-text}}}.
    The item line carries the case number + parties, so the app can auto-fill a
    matter's title from just court + item. `times` is only ever populated for
    items inside a declared SPECIAL BENCH section (see SPECIAL_BENCH_RE above)."""
    courts = {}
    cur = None
    in_header = False
    pending = None      # (court, item) awaiting a "Versus" respondent
    await_resp = False
    pending_conn = None # a "N. Connected <party>" awaiting its sub-index next line
    in_special_bench = False   # currently inside a SPECIAL BENCH section
    cur_time = ""              # that section's declared time (clock time, or a
                                # verbatim relative-timing note) — "" if undeclared
    note_acc = None            # mid-accumulation of a bracketed note split across lines
    last_item = None           # the item the CURRENT line's text belongs to — a "taken up
                                # along with" note appears well after the item/Versus/
                                # respondent lines are already consumed, so this is the only
                                # way to know which item a later note is still about
    with_acc = None            # mid-accumulation of a "...ALONG WITH..." note split across lines

    def record_with_note(text):
        if not last_item:
            return
        mi = WITH_ITEM_RE.search(text)
        if mi:
            ref = mi.group(1)
            wi = courts[cur].setdefault("withItem", {})
            # A serial number can legitimately repeat for two DIFFERENT matters within the
            # same court/list (real example, Court 6 supp: two unrelated items both "54") —
            # the same irregularity courts[cur]["items"] already resolves by keeping the
            # FIRST occurrence's case title. Overwriting here would pair that kept title with
            # the SECOND occurrence's note instead, so first occurrence wins here too.
            if ref != last_item and last_item not in wi:
                wi[last_item] = ref

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if HEADER_SKIP.search(line):      # page-header boilerplate — never data
            continue
        court = None
        m = REG_RE.search(line) or COURT_RE.search(line)
        if m:
            court = m.group(1)
        elif CJ_RE.search(line):
            court = "1"
        if court is not None:
            same_court = (court == cur)
            cur = court
            courts.setdefault(cur, {"coram": "", "total": "", "fresh": "", "items": {}, "times": {}, "withItem": {}})
            # collect the bench only until we have it; page headers repeat the
            # court + coram on every page, so re-collecting would duplicate it.
            in_header = not courts[cur]["coram"]
            # A repeated court header can be a genuinely NEW bench sitting (same
            # court, later in the day, different judges/time) — real example:
            # Court 4's page 2 has Justice Kotiswar Singh in place of Justice
            # Sanjay Kumar. Reset special-bench scope and the time so the new
            # section's own signals (or lack of one) are what items get tagged
            # with, never a stale value carried over from the previous page.
            in_special_bench = False
            cur_time = ""
            note_acc = None
            # last_item/with_acc are NOT reset on a same-court repeat — unlike the
            # special-bench state above, an item's own block routinely SPANS a page break
            # (real example, Court 2 item 54: "...Versus" / page-header repeat / "COURT NO.
            # : 2" / the respondent / then its "ALONG WITH ITEM NO." note). Clearing
            # last_item there silently dropped that note — item 53 right above it, whose
            # block didn't cross a page boundary, kept its identical one. Only a genuine
            # transition to a DIFFERENT court means the note that follows can't be about
            # the previous item anymore.
            if not same_court:
                last_item = None
                with_acc = None
            continue
        if cur is None:
            continue
        # Finish a bracketed relative-timing note that opened on an earlier line —
        # takes priority over everything else until its closing "]" shows up.
        if note_acc is not None:
            close = line.find("]")
            if close >= 0:
                note_acc += " " + line[:close]
                cur_time = re.sub(r"\s+", " ", note_acc).strip().rstrip(",")
                note_acc = None
            else:
                note_acc += " " + line
            continue
        # Same accumulation for a "...ALONG WITH..." note — independent of the timing note
        # above (the two never nest; a bracket is one or the other).
        if with_acc is not None:
            close = line.find("]")
            if close >= 0:
                with_acc += " " + line[:close]
                record_with_note(with_acc)
                with_acc = None
            else:
                with_acc += " " + line
            continue
        ws = WITH_NOTE_START_RE.search(line)
        if ws:
            frag = ws.group(1)
            close = frag.find("]")
            if close >= 0:
                record_with_note(frag[:close])
            else:
                with_acc = frag
            continue
        if SPECIAL_BENCH_RE.search(line):
            in_special_bench = True
        # The declared TIME is captured regardless of in_special_bench — real
        # example: "(TIME : 2:00 PM)" prints right under the judges' names,
        # BEFORE the "SPECIAL BENCH" label appears at all. Only tagging items
        # (further below) is gated on in_special_bench, which by then is
        # correctly set, since items always come after both.
        if not cur_time:
            tm2 = TIME_RE.search(line)
            if tm2:
                cur_time = re.sub(r"\s+", " ", tm2.group(1)).strip().upper()
            else:
                bs = BRACKET_NOTE_START_RE.search(line)
                if bs:
                    frag = bs.group(1)
                    close = frag.find("]")
                    if close >= 0:
                        cur_time = re.sub(r"\s+", " ", frag[:close]).strip().rstrip(",")
                    else:
                        note_acc = frag   # unclosed — keep building on the next line(s)
                    continue
        tm = TOTAL_RE.search(line)
        if tm and not courts[cur]["total"]:
            courts[cur]["total"] = tm.group(1)
        fm = FRESH_RE.search(line)
        if fm and not courts[cur]["fresh"]:
            courts[cur]["fresh"] = fm.group(1)
        # Regular-list connected matter: "102. Connected <party>" — the sub-index
        # is on the following line; record the party and wait for it.
        cm = CONNECTED_RE.match(line)
        if cm:
            in_header = False
            pending_conn = {"main": cm.group(1), "party": cm.group(2).strip()}
            continue
        if pending_conn is not None:
            sm = SUBINDEX_RE.match(line)
            if sm:
                key = pending_conn["main"] + "." + sm.group(1)
                last_item = key
                caseline = (sm.group(2).strip() + " " + pending_conn["party"]).strip()
                if key not in courts[cur]["items"]:
                    courts[cur]["items"][key] = re.sub(r"\s+", " ", caseline).strip()[:70]
                    if cur_time and in_special_bench:
                        courts[cur]["times"][key] = cur_time
                    pending = (cur, key); await_resp = False
                pending_conn = None
                continue
            pending_conn = None   # next line wasn't a sub-index — abandon
        # an item line — record its number -> petitioner side (first occurrence
        # only; page-header repeats won't overwrite). The respondent is captured
        # from the line after "Versus" so the title reads "Petitioner vs Resp".
        im = ITEM_LINE_RE.match(line)
        if im and re.search(r"[A-Za-z]{3}", im.group(2)):
            in_header = False
            it = im.group(1)
            last_item = it
            if it not in courts[cur]["items"]:
                courts[cur]["items"][it] = re.sub(r"\s+", " ", im.group(2)).strip()[:70]
                if cur_time and in_special_bench:
                    courts[cur]["times"][it] = cur_time
                pending = (cur, it); await_resp = False
            else:
                pending = None
            continue
        if pending is not None:
            if re.match(r"^versus$", line, re.I):
                await_resp = True
                continue
            if await_resp and re.search(r"[A-Za-z]{3}", line) \
                    and not re.match(r"^[\[{(]", line):   # skip [CAVEAT] etc.
                resp = re.sub(r"\s+", " ", line).strip()[:50]
                pc, pit = pending
                courts[pc]["items"][pit] += " VERSUS " + resp
                pending = None; await_resp = False
                continue
        if in_header:
            if is_coram(line):
                piece = re.sub(r"\s+", " ", line).strip()
                courts[cur]["coram"] = (courts[cur]["coram"] + " " + piece).strip()[:200]
            else:
                in_header = False
    for c in courts.values():
        if not c["total"]:
            c["total"] = str(len(c["items"]))   # SC lists have no total line
    return courts


# --- Advocate-on-Record capture -------------------------------------------------
# The AoR sits in the advocate column (x >= ADV_COL_X). Party names, case numbers,
# IA descriptions and the bench are ALL to the LEFT of that column, so by taking
# only x >= ADV_COL_X words nothing "nearby" can leak into the name (owner's hard
# requirement Jul 2026). We then validate every value is a bare name.
VERSUS_ONLY_RE = re.compile(r"^versus$", re.I)
# Words that mean it is NOT an AoR name — a header/officer/party/bench/IA token.
ADV_NAME_BAD = re.compile(
    r"REGISTR|COURT|BENCH|HON'?BLE|JUSTICE|PETITIONER|RESPONDENT|\bADVOCATE\b|"
    r"VERSUS|MATTER|HEARING|\bNOTE\b|SNO|CASE\s*NO|IA\s*NO|DIARY|EMAIL|"
    r"SUBMISSION|JUDGMENT|AMICUS|IN-?PERSON", re.I)


def _clean_adv(s):
    s = re.sub(r"\[[^\]]*\]", " ", s)                       # drop [R-1], [INT], [PET] ...
    s = re.sub(r"\([^)]*\)", " ", s)                        # drop (AMICUS CURIAE), (NP) ...
    s = re.sub(r",?\s*\bADV(?:OCATE|\.)?\b", " ", s, flags=re.I)   # drop the role word
    return re.sub(r"\s+", " ", s).strip(" ,.;-")


def _valid_adv(s):
    """STRICTLY an advocate / firm NAME: letters plus . , & / ' - and spaces only,
    short, no digits, and none of the party/case/bench/officer words."""
    if not s or len(s) > 45 or not re.search(r"[A-Za-z]", s):
        return False
    if re.search(r"[0-9]", s):
        return False
    if ADV_NAME_BAD.search(s):
        return False
    if len(re.sub(r"[A-Za-z .,&/'\-]", "", s)) > 1:        # stray non-name chars -> reject
        return False
    return True


def parse_advocates(data, real_items):
    """{court: {item: {pet?, resp?}}} — the AoR for each side, taken only from the
    advocate column and validated. `real_items` = {court: set(item)} from
    parse_courts, so a note/header line mis-read as an item is dropped (intersection).
    Empty / invalid values are omitted."""
    try:
        import pdfplumber
    except Exception:
        return {}
    out = {}
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages:
                rows = {}
                for w in page.extract_words(use_text_flow=True):
                    rows.setdefault(round(w["top"] / 2), []).append(w)
                court = item = None
                seen_v = pet_lock = resp_lock = False
                for key in sorted(rows):
                    ws = sorted(rows[key], key=lambda w: w["x0"])
                    left = [w for w in ws if w["x0"] < ADV_COL_X]
                    lt = " ".join(w["text"] for w in left).strip()
                    adv = _clean_adv(" ".join(w["text"] for w in ws if w["x0"] >= ADV_COL_X))
                    m = REG_RE.search(lt) or COURT_RE.search(lt)
                    if m:
                        court = m.group(1); item = None; continue
                    if CJ_RE.search(lt):
                        court = "1"; item = None; continue
                    if court is None:
                        continue
                    if left and left[0]["x0"] < SNO_COL_X and ADV_SNO_RE.match(left[0]["text"]):
                        cand = ADV_SNO_RE.match(left[0]["text"]).group(1)
                        if court in real_items and cand in real_items[court]:
                            item = cand; seen_v = pet_lock = resp_lock = False
                            out.setdefault(court, {}).setdefault(item, {"pet": "", "resp": ""})
                            if adv:
                                out[court][item]["pet"] = adv     # petitioner AoR on the serial row
                        else:
                            item = None
                        continue
                    if not (court and item):
                        continue
                    rec = out[court][item]
                    if VERSUS_ONLY_RE.match(lt):
                        seen_v = True; continue
                    if not seen_v:
                        if pet_lock:
                            continue
                        if adv and not rec["pet"]:
                            rec["pet"] = adv
                        elif adv and not lt:                    # empty-left continuation = same name wrapping
                            rec["pet"] = (rec["pet"] + " " + adv).strip()
                        else:
                            pet_lock = True                     # left content / blank -> stop
                    else:
                        if resp_lock:
                            continue
                        if adv and not rec["resp"]:
                            rec["resp"] = adv
                        elif adv and not lt and rec["resp"]:
                            rec["resp"] = (rec["resp"] + " " + adv).strip()
                        elif rec["resp"] and (lt or not adv):   # a blank/annotation row ends respondent capture
                            resp_lock = True
    except Exception as e:
        print("  advocate extraction failed:", e)
    clean = {}
    for c, its in out.items():
        for it, rec in its.items():
            pet = rec["pet"] if _valid_adv(rec["pet"]) else ""
            resp = rec["resp"] if _valid_adv(rec["resp"]) else ""
            if pet or resp:
                d = {}
                if pet:
                    d["pet"] = pet
                if resp:
                    d["resp"] = resp
                clean.setdefault(c, {})[it] = d
    return clean


def upcoming_days(n):
    ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
    days, d, step = [], ist.date(), 0
    while len(days) < n and step < n * 2 + 4:
        if d.weekday() < 5:
            days.append(d.strftime("%Y-%m-%d"))
        d += datetime.timedelta(days=1)
        step += 1
    return days


def n_matters(items):
    """Count only serially-numbered matters. Connected matters are captured as
    sub-items ("4.1", "102.2") so a clerk can look them up, but the court lists
    them UNDER their main item — they are not separate serial matters, so they
    must NOT inflate a court's total/main/supp counts (Court 5's 30 matters were
    reading 32 because of two connected sub-items)."""
    return sum(1 for k in items if "." not in k)


def build_for_date(date_str, prev_day=None, prev_sizes=None):
    """Returns (lists_found, lists, notes, specials, sizes, reused). Probes every list URL with a
    1KB ranged GET first; if the sizes all match the previous run, the previous
    parse is reused wholesale — no PDF is downloaded."""
    sizes = {}
    for human, variants in LIST_TYPES.items():
        for suffix, variant in variants:
            s = probe_size(DAILY_BASE.format(date=date_str, suffix=suffix))
            if s:
                sizes[suffix] = s
            time.sleep(0.15)
    if prev_day is not None and sizes == (prev_sizes or {}):
        # COPIES, not the cached objects themselves: main() later merges the homepage notices
        # into these lists in place, and handing back the same objects meant prev_by was edited
        # too — so by_date always compared equal to it, "No change since last run" fired, and a
        # notice that arrived after the causelist PDFs stopped changing was never written
        # (5 Oct 2026: Court 2's "Justice Sandeep Mehta will not be holding the Court" fetched
        # fine and was then thrown away).
        prev_day = copy.deepcopy(prev_day)
        return (prev_day.get("lists_found", []), prev_day.get("lists", {}),
                prev_day.get("notes", []), prev_day.get("specialBenches", []), sizes, True)
    lists_found, lists = [], {}
    notes, note_keys = [], set()
    specials, sb_keys = [], set()
    for human, variants in LIST_TYPES.items():
        merged = {}
        for suffix, variant in variants:
            if suffix not in sizes:
                continue
            data = fetch_pdf(DAILY_BASE.format(date=date_str, suffix=suffix))
            if not data:
                continue
            col, full = pdf_texts(data)
            text = col or pdf_to_text(data)  # drop advocate column (cause titles)
            if not text.strip():
                continue
            notes_text = full or text        # notes/benches read whole — see pdf_texts()
            lists_found.append("{} ({})".format(human, variant))
            # operational NOTE:- blocks (a judge sitting elsewhere, a changed bench, a
            # court not sitting) — deduped across every list and variant of the day
            # (not from the Chamber / Single Judge lists at all — owner doesn't track those)
            for b in ([] if human in ("Chamber", "Single Judge") else parse_special_benches(notes_text)):
                k = (b["venue"], tuple(b["judges"]), b["at"], tuple(b["after"]))
                if k not in sb_keys:
                    sb_keys.add(k)
                    specials.append(b)
            for n in ([] if human in ("Chamber", "Single Judge") else parse_day_notes(notes_text)):
                ks = {c + "#" + k for c in n["courts"] for k in n.get("keys", [])}
                if ks and ks <= note_keys:
                    continue
                note_keys |= ks
                notes.append(n)
            parsed = parse_courts(text)
            advs = parse_advocates(data, {c: set(parsed[c]["items"]) for c in parsed})
            for court, info in parsed.items():
                # a supplementary list ADDS matters to the same court — union the
                # items (do NOT replace, or the main list's items are wiped, e.g.
                # court 1's item 30 vanished behind the supp's items 46-51). Keep
                # the main bench; only fill coram/fresh from supp if main lacked it.
                # Track how many of the court's matters came from main vs supp so the
                # printout can show the breakup ("Main 50 · Supp 10").
                ex = merged.setdefault(court, {"coram": "", "total": "", "fresh": "",
                                               "items": {}, "advocates": {}, "times": {},
                                               "withItem": {}, "main": 0, "supp": 0})
                before = n_matters(ex["items"])
                ex["items"].update(info.get("items", {}))
                ex["times"].update(info.get("times", {}))
                # a "taken up with item N" note is self-contained (N is just a number, not
                # a lookup into the OTHER list) — union it the same way, even though the
                # noted item and the item it references can live in different lists (real
                # example: item 58's note is in the supplementary PDF, item 23 it points to
                # is in the main one).
                ex["withItem"].update(info.get("withItem", {}))
                # count only the NEW serial matters this list added (not sub-items)
                ex[variant] = ex.get(variant, 0) + (n_matters(ex["items"]) - before)
                # merge the AoR names for this court's items (don't overwrite a name
                # already captured from the main list with an empty from the supp)
                for it, ad in advs.get(court, {}).items():
                    cur = ex["advocates"].setdefault(it, {})
                    if ad.get("pet") and not cur.get("pet"):
                        cur["pet"] = ad["pet"]
                    if ad.get("resp") and not cur.get("resp"):
                        cur["resp"] = ad["resp"]
                if not ex.get("coram") and info.get("coram"):
                    ex["coram"] = info["coram"]
                if not ex.get("fresh") and info.get("fresh"):
                    ex["fresh"] = info["fresh"]
        # SC lists carry no total line — total is the merged serial-matter count
        for c in merged.values():
            c["total"] = str(n_matters(c["items"]))
        if merged:
            lists[human] = merged
    return lists_found, lists, bench_summaries(specials) + notes, specials, sizes, False


def main():
    dates = [sys.argv[1]] if len(sys.argv) > 1 else upcoming_days(WINDOW_DAYS)
    print("Checking dates:", ", ".join(dates))
    prev = {}
    try:
        with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
            prev = json.load(f)
    except Exception:
        pass
    # If the parser was upgraded since this file was written, discard the cached
    # parses so every date is re-parsed with the new logic (otherwise a fixed
    # parser never reaches dates whose PDFs haven't changed size).
    stale_parser = prev.get("parser_version") != PARSER_VERSION
    if stale_parser and prev:
        print("Parser version changed ({} -> {}) — forcing a full re-parse."
              .format(prev.get("parser_version"), PARSER_VERSION))
    # The file this run actually found on disk, UNCONDITIONALLY — kept regardless of
    # stale_parser, as the fallback below needs it. A forced re-parse (or a probe that
    # simply can't reach api.sci.gov.in this run) does real network fetching with no cache
    # shortcut, and a bad run once wrote an all-but-empty file straight over good cached
    # data live (25 Sep 2026: a version bump's forced re-parse hit an hour of fetch
    # trouble, came back with 0 dates, and — because stale_parser skipped the "nothing
    # changed, leave the file alone" check below — that emptiness got committed and pushed
    # to the live app). A date whose live fetch comes back with nothing, where the file
    # already had real content for it, now keeps that old content instead of losing it.
    prev_by_raw, prev_src_raw = prev.get("by_date", {}), prev.get("sources", {})
    prev_by, prev_src = ({}, {}) if stale_parser else (prev_by_raw, prev_src_raw)
    by_date, sources = {}, {}
    for date_str in dates:
        lists_found, lists, notes, specials, sizes, reused = build_for_date(
            date_str, prev_by.get(date_str), prev_src.get(date_str))
        if sizes:
            sources[date_str] = sizes
        if lists_found or lists:
            by_date[date_str] = {"lists_found": lists_found, "lists": lists, "notes": notes,
                                 "specialBenches": specials}
            ncourts = sum(len(v) for v in lists.values())
            print("  {}: {} list(s), {} courts, {} note(s){}".format(
                date_str, len(lists), ncourts, len(notes), "  [unchanged — reused]" if reused else "  [FETCHED]"))
        elif prev_by_raw.get(date_str, {}).get("lists"):
            by_date[date_str] = prev_by_raw[date_str]
            if date_str in prev_src_raw:
                sources[date_str] = prev_src_raw[date_str]
            print("  {}: fetch came back with NOTHING — keeping the file's existing data "
                  "for this date rather than losing it".format(date_str))
    # Homepage "Listing Notices" — the daily mentioning list and bench-change /
    # cancellation notices. Fetched fresh every run (they arrive intraday and their PDFs
    # are immutable once uploaded); a notice joins the notes of every date its TITLE
    # names, deduped against what the causelist PDFs' own NOTE:- blocks already said.
    web = fetch_home_notices()
    if web:
        print("Homepage listing notices:", len(web))
    pdf_cache = {}      # url -> (bytes, text)
    for date_str in dates:
        day = by_date.get(date_str)
        if day is None:
            continue
        want = [n for n in web if date_str in title_dates(n["title"])]
        if not want:
            continue
        notes = day.setdefault("notes", [])
        sbs = day.setdefault("specialBenches", [])
        for n in want:
            if n["url"] not in pdf_cache:
                # A notice PDF that fails to download used to fall back silently to its title —
                # 5 Oct 2026, Court 2's "Justice Sandeep Mehta will not be holding the Court"
                # became just "Notice regarding change in Court No.2" on one run. Retry, and if it
                # still fails keep what the previous run read from the same PDF (it never changes).
                data, text = None, ""
                for attempt in range(3):
                    data = fetch_pdf(n["url"])
                    text = pdf_to_text(data) if data else ""
                    if text and text.strip():
                        break
                    time.sleep(2 * (attempt + 1))
                if not (text and text.strip()):
                    print("WARNING: notice PDF unreadable after 3 tries — {}".format(n["url"]))
                pdf_cache[n["url"]] = (data, text)
                time.sleep(0.2)
            data, text = pdf_cache[n["url"]]
            if not (text and text.strip()):
                old_day = prev_by_raw.get(date_str, {})
                kept = [x for x in old_day.get("notes", []) if x.get("url") == n["url"]]
                if kept and any(x["text"] != n["title"] for x in kept):
                    notes[:] = [x for x in notes if x.get("url") != n["url"]] + kept
                    print("  {}: kept last run's text for {}".format(date_str, n["title"][:60]))
                    continue
            if re.search(r"oral\s+mentioning", n["title"], re.I):
                ment = parse_mentioning(text)
                if ment:
                    day["mentioning"] = ment
                    print("  {}: mentioning list — {} matters across {} courts".format(
                        date_str, sum(len(v) for v in ment.values()), len(ment)))
                continue
            # Only bench-change / sitting notices become court notes. The same homepage strip
            # also carries the daily "Helpline numbers of Court Masters" circular (it names
            # every court, so it would have stuck a VC-helpline note on all sixteen) and
            # "Advance List of Chamber Matters" (a case table that parses to noise) — both seen
            # live on 5 Oct 2026.
            if not NOTICE_TITLE_KEEP_RE.search(n["title"]) or NOTICE_TITLE_SKIP_RE.search(n["title"]):
                continue
            # re-running with the same notice replaces what it produced last time
            notes[:] = [x for x in notes if x.get("url") != n["url"]]
            sbs[:] = [b for b in sbs if b.get("url") != n["url"]]
            # read PARAGRAPH by paragraph (each is one self-contained change) and interpret it
            paras = (notice_paragraphs(data) if data else []) or ([text] if text and text.strip() else [n["title"]])
            for para in paras:
                for fact in interpret_paragraph(para, fallback_courts=courts_in(n["title"])):
                    sb = fact.pop("sb", None)
                    fact["url"] = n["url"]
                    notes[:] = merge_notes(notes, fact)
                    print("  {}: notice — {} | {}".format(date_str, ",".join(fact["courts"]), fact["text"][:90]))
                    if sb and sb.get("at"):
                        # the notice is the later word: its time replaces a causelist bench's
                        same = [b for b in sbs if b["venue"] == sb["venue"] and not b.get("url")]
                        if same:
                            same[0]["at"] = sb["at"]
                            same[0]["noticeUrl"] = n["url"]
                            if sb.get("judges"):
                                same[0]["judges"] = sb["judges"]
                        else:
                            sb["src"] = "web"
                            sb["url"] = n["url"]
                            sbs.append(sb)
    for day in by_date.values():
        if day.get("notes"):
            day["notes"] = finalize_notes(day["notes"])

    # Nothing new anywhere -> leave the file untouched so the workflow commits
    # nothing and Pages doesn't rebuild. (generated_at = time of last CHANGE.)
    if prev and not stale_parser \
            and json.dumps(by_date, sort_keys=True) == json.dumps(prev_by, sort_keys=True) \
            and json.dumps(sources, sort_keys=True) == json.dumps(prev_src, sort_keys=True):
        print("No change since last run — output left untouched.")
        return
    result = {
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "parser_version": PARSER_VERSION,
        "window": dates,
        "by_date": by_date,
        "sources": sources,
        "note": "Per-court bench + per-item case line from the SC published lists. "
                "Drafting aid only — the court's published list is authoritative.",
    }
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("Wrote {} — {} day(s) with lists.".format(OUTPUT_FILE, len(by_date)))


if __name__ == "__main__":
    main()
