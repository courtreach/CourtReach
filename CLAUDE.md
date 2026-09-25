# CourtReach — Claude Code handover

Read this first in any CourtReach session. It is the memory of ~two months of work;
the owner (Adith, an Advocate-on-Record) expects it to be current, so keep it so.

## What this app is

**CourtReach** (https://courtreach.app) tells a lawyer, from the Supreme Court of India's
live display board, how far away each of their cases is and when to walk to which court.
Users: individual advocates, and whole chambers (an *organisation*) sharing one board,
plus *collaborations* (a briefing lawyer tracking a senior's board). It is a product with
paying users, distributed at scale — which is why the server side is kept out of the repo.

Sister apps (separate repos, separate Firebase projects): **SD-Chamber** (the owner's own
chamber-management app, `~/Projects/SD-Chamber`, whose day sheet is mirrored INTO
CourtReach by a GitHub Action), **DisplayBoard** (the older board app), and
**Chamber-Shell** (a neutral copy of SD-Chamber for other chambers). Nothing in
CourtReach imports from them; `board-engine.js` originated in DisplayBoard and is now
CourtReach's own.

## Files

| File | Purpose |
|---|---|
| `courtreach.html` | THE app — one file, vanilla JS, Firebase v10.12.2 ESM. `const DEMO=false;` |
| `index.html` | **Byte-identical mirror** of courtreach.html (`cp courtreach.html index.html && diff -q`). Always mirror before committing. |
| `board-engine.js` | The pure proximity engine (no DOM, no Firestore). Loaded by the app; **embedded verbatim** in worker.js. |
| `engine-tests/` | The engine's stress tests (`sim-day.js`, `sim-round2.js`, `sim-fixed-time.js`). Run all three (must print 0 fails) before shipping an engine change. |
| `worker.js` | **Not in the repo (gitignored)** — lives only at `~/Projects/CourtReach/worker.js`. CourtReach's Cloudflare Worker: board relay + push + cron watcher. Pasted by hand into the Cloudflare dashboard. |
| `firestore.rules` | **Gitignored.** Source of truth for what is pasted into the Firebase console (project `courtreach-ee02b`). |
| `sw.js` | Service worker: push/notificationclick only — no caching layer by design. |
| `manifest.json` | PWA manifest. `start_url` is `./courtreach.html` — the Pages build must publish both files or installed apps break. |
| `sync_daysheet.py` + `.github/workflows/daysheet-sync.yml` | Mirrors SD-Chamber's day sheet into the owner's chamber board. Six fixed times a day (08:00, 10:25, 18:00, 20:00, 22:00, 23:59 IST) — owner's explicit list, do not change to an interval. |
| `fetch_causelist.py` + `.github/workflows/causelist.yml` | Fetches SC cause lists → `court-updates.json` (bench, totals, item lines, Special Bench times). |
| `.github/workflows/deploy-pages.yml` | Builds the `gh-pages` branch from an explicit **allow-list** of browser files, comment-stripped with Terser (`--module`!). Triggered on push, on the cause-list bot's `workflow_run`, and a 3-hourly backstop. Never publishes worker.js, rules, tests. |
| `PUSH-SETUP.md`, `DAYSHEET-SYNC-SETUP.md`, `CAUSELIST-SETUP.md` | Owner-facing setup guides. |

## Architecture in one paragraph

One `<script type="module">`. `DEMO` flag switches an in-memory store (deep-merges nested
maps like prod, so `null` tombstones behave the same) for the Firebase branch. The board is
fetched through the worker relay (`BOARD_PROXY` = `courtreach.sdentertainmentservices.workers.dev`):
`?ctype=c` (live board), `?seq` (the old board's sequence marquee), `?remarks=<token>`
(a court's remark column: OVER / PASS OVER / "list on …"). Polling is **adaptive**
(`pollIntervalMs()`: 6 s only while something is within reach, 20/45 s otherwise, 2 min
outside sitting hours, paused when hidden) — cut Cloudflare traffic ~10×; keep it so.
Rendering is imperative: `render()` → `renderBoard()` (islands + route rail) /
`renderMine()` / chat / settings; the court sheet is `openCourtModal()`.

## The engine (board-engine.js) — the heart

`ENG.classify(e, bc, ctx)` → `{tier, label, short, gap, over, done, po, fixed, …}`.
`courtCtx()` in the app builds the ctx once (sequence, remarks, live-observed passovers
`boardPO`/`recalledPO`, `itemHi`, status marks, Misc totals); `classify(e)` adds
`fixedTimes` for that item. Rules the owner set, in order:

1. A user's status mark (over ✓ / over ✗ / not taken) wins.
2. A **time-fixed** case is measured in **minutes, never items** ("at 2:30 PM" / "in 25
   min" / NOW; alert rungs at 20/15/10/5/0 min). Board OVER remark still wins over it.
3. The board's own remark, quoted (`remarkEndsToday`: over/dismissed/disposed/list on/
   after N weeks = finished; PASS OVER and part-heard are NOT).
4. Otherwise position along the **call order** = declared sequence first, then everything
   unmentioned in ascending order (`callPos`/`orderPos`). Gap convention: item on now = 0,
   next = 1.
5. **Passovers** are still to come: recalled after a named item, else at the sequence's
   "passovers" point, else at the end of the Misc list — **in the order they were passed
   over** (`passoverPlan`, `recallPos`, `passoversBeforeOurs`). Once the court is visibly
   recalling, distance = place in the queue. Misc passovers come before the Regular list.
6. Being past the item in call order with nothing posted = over (`over:true`, `approx` when
   no sequence exists).

**Causelist-published item links** ("TO BE TAKEN UP ALONG WITH ITEM NO. 23" — a fact the
SC's own list states, not a passover, nothing typed in; owner: "our app needs to take into
account such information", 25 Sep 2026 real example, Court 1 item 58). `classify()` is a
thin wrapper (`classifyRaw` underneath, untouched) that reads `ctx.withItem["court_item"]`
and, if set, measures the matter entirely as the REFERENCED item — its remark, position,
passover status all govern — then tags the result `withItem:"23"`. This sits ABOVE rule 1
in effect but not in authority: the user's own mark on their OWN item (58) is checked
FIRST and wins outright before any redirect, so marking your own linked matter done can
never be silently overridden by the other item's live status. Only the "ITEM NO. X" form
is resolved this way; a causelist note linking by CASE NUMBER instead ("...ALONG WITH
SLP(C) No. 32577/2026") is parsed but left unresolved — the stored item text often doesn't
carry the case number at all (SC lists sometimes print it on its own wrapped line that
`parse_courts` drops), so matching it back to an item number isn't reliable yet. Misc list
only for now; the Regular list's own such notes aren't wired into the app's ctx.

**Sequence-declared item links** — the SAME idea, second source: the court's own SEQUENCE
announcement can say two items are linked too, not just the causelist ("...14 TO 23 WITH
58...", Court 1's actual published sequence, 25 Sep 2026; owner: "both will be at similar
position despite being far away in numbers ... 58 [should not be] a separate item for the
purposes of ... how far away calculation and also ... the progress bar"). `seqInfo()` now
returns a third field, `withMap` (`{"58":"23"}`) — an item named right after the word
"WITH" is recorded there and does NOT get pushed into `seq` as its own call-order slot, so
every OTHER item's position and the progress bar's `reach` naturally compress by one slot
per linked pair, with no separate fix needed anywhere reach/doneN is computed (they all
derive `seq` from `seqInfo()`, one source of truth). `classify()`'s wrapper checks this
BEFORE `ctx.withItem`, deriving it from the exact same `seqTxt` `classifyRaw` uses
internally (`bc.sequence` then `ctx.seqByCourt`) — so it can never disagree with what the
rest of classify() sees for that court, and needs no extra courtreach.html/worker.js
wiring: both already pass `seqByCourt` into ctx for other reasons.

**Mentioning series (800s) as OUR item** — a tracked 800-series matter is measured inside
its own series (owner: "the mentioning series ... will be always taken up before the
miscellaneous and regular lists and after pronouncement"): series arithmetic while the
board is in the 800s, "after the pronouncements" while it is in the 1500s, and finished
once the board is into the numbered lists. The court sheet carries a "Mentioning" row
(`mentioningLine()`) saying where the series stands — live-board-derived only, since the
SC publishes no separate daily mentioning list any more (last "List of oral mentioning
matters" notice: Jan 2026; verified 25 Sep 2026). The sheet's `onRegular` check gates on
`curNum<800` for the same reason the progress bar always did — item 803 is a phase, not a
Regular-list position.

**Operational day notes — two sources, one channel** (`by_date[date].notes`,
`[{text, courts}]`, quoted verbatim in the sheet's gold `.cs-notice` box under the coram,
today's and picked-date sheets both):
1. The causelist PDFs' own "NOTE:-" blocks (`parse_day_notes()`, parser v11), attributed
   to the courts named or the section they sit in ("THIS COURT").
2. The sci.gov.in **HOMEPAGE's "Listing Notices" strip** — NOT the notices-and-circulars
   archive, which only carries occasional circulars (a wrong earlier conclusion; the owner
   supplied the live links). `fetch_home_notices()` reads the homepage anchors (title +
   uploaded-PDF url — the urls themselves are an unpredictable upload counter, the
   homepage is the only stable index), matches each notice to the date(s) its TITLE names,
   and `notice_note()` stores the PDF's body text (or the title, if the PDF is a scan)
   with every court it names (`courts_in()` handles "Court Nos. 9, 13 & 15" runs and the
   Chief Justice's Court = 1). Bench cancellations / "will not sit" notices arrive here.
   Fetched fresh every run in main() — notices land intraday; their PDFs never change.

**The daily MENTIONING LIST is real and published** — same homepage strip, "List of oral
mentioning matters before Hon'ble Courts on <date>". Its entries are numbered
"<court>.<801+>" ("2.801", "16.801") — court and 800-series item in one token —
parsed by `parse_mentioning()` into `by_date[date].mentioning = {court: {item: line}}`.
The sheet's Mentioning row appends "· N listed" from it.

**Court sheet case order** — the sheet's "Your/Chamber cases here" list is sorted along
the call order, nearest first (owner: "The cases closer should be on top even though their
item number is greater"); time-fixed cases follow (soonest clock first), finished ones
sink struck to the bottom. The island TILE keeps its constant item-number order — that
was a separate, earlier decision and still stands.

**Passover "after item X"** — `passoverPlan()`'s `after` field (the item the sequence's own
"passovers" marker sits right after, e.g. "1-10, 25-50 and then passovers" → after item 50)
used to be set ONLY on the `at:"sequence"` branch — the moment the court actually reached
that point and the plan fell to `at:"end"` instead (which, since the marker routinely sits
right at the end of the declared list, happens almost immediately), the already-known fact
silently vanished from the court sheet (owner: "the passover section in the Court island
not showing when the passovers will be taken up"). Now computed once from `passIdx`/`seq`
and carried on every branch; `passoverPlanText()`'s "end" message shows it the same way the
"sequence" one always did.

The simulator (`engine-tests/`) found five real defects in Sep 2026 and is the only
acceptable proof for an engine change. After ANY engine edit: run the three tests, then
**re-embed the whole file into worker.js** between the `>>> BEGIN board-engine.js >>>` /
`<<< END board-engine.js <<<` markers programmatically (a hand-maintained partial copy is
exactly how the worker once drifted three fixes behind).

Sequence parser gotchas fixed so far (each from real published lines the owner supplied —
25 Sep 2026 batch): "Item Nos.1 to 4" — a digit glued to a letter must be split
(`([A-Za-z])\.?(\d)`) or items vanish; "62.1" must NOT be split. "...59 60." — a bare
trailing period after the last item failed the number regex and dropped that item (`\.\d+`
→ `\.\d*`). "1 T 17" — TO published truncated as bare "T", else items 2–16 fall out of the
order. "item 41 AT 2 PM" / "at 3.30 pm" — a clock time inside the line passes the number
test and injects a phantom item; a number after "AT" or before an AM/PM token is a time.
"Court C7: …" — the marquee labels courts with a C prefix, and parseSequenceLine's anchor
missed it, parsing the whole line to NOTHING. Prose-only lines ("Bail and fresh matters …
taken up immediately") have no items and correctly degrade to no sequence.

## Firestore model (project courtreach-ee02b)

- `users/{uid}` — profile, `orgId`, `orgRole`, trial/entitlement fields. Deleting an
  account TOMBSTONES the doc (`deleted:true`), never removes it (trial-reset hole).
- `usermatters/{uid}` — `{matters:[{id,court,item,date,listType,appearingFor,scope,title,bench,aor}]}`.
  Only the owner writes it; `scope:"personal"|"chamber"`.
- `matterstatus/{scopeId}` (scopeId = orgId for chamber matters, uid for personal) — the
  SHARED daily bag any member may write. Three maps on it, all keyed
  `date_court_item` (dots → dashes) or `date_court`:
  `marks{}` (status: over_att / over_absent / passover / not_taken), `courts{}` (typed-in
  sequence + passovers per court), `times{}` (a time fixed for a case). Clearing writes an
  explicit **null**, never a delete (prod deep-merges nested maps). This design exists so
  that NO rules change is needed for new per-day facts — a rules paste is the slowest,
  most error-prone step in this app's history.
- `orgs/{orgId}`, `orgcodes/{code}` — chambers and join codes; `orgdms`, org chat channels.
- `links/{fromUid_toUid}` — collaborations (with a per-day matter list); link chat threads.
- `config/accessCode` — the shared access code (verified server-side in rules).
- Day-sheet-synced matters carry `source:"daysheet"` — read-only in the app, markable.

Rules were hardened in Aug 2026 (four holes closed). They are not in git; the owner pastes.
If a change needs a rules edit, say so loudly and give the complete file to paste.

## The worker (Cloudflare) — what to know

Endpoints: relay (`?ctype`, `?seq`, `?remarks`), `/cr-push-subscribe`,
`/cr-push-unsubscribe`, `/cr-push-chat` (all push endpoints verify a Firebase ID token
against Google's JWKS). `scheduled()` = `crTick`: cron `*/1 3-11 * * MON-FRI` (Cloudflare
cron treats 1 as Sunday — `1-5` skipped Friday once), reads subscribers from KV `CR_SUBS`,
fetches the board + sequence line + court-updates.json, reads each user's matters and
matterstatus (marks, courts, times) via Firestore REST with the service-account key,
runs the embedded engine and pushes when a case gets closer (never repeats a distance).
Secrets: `CR_VAPID_PUBLIC/PRIVATE/SUBJECT`, `CR_FIRESTORE_SA_KEY`. Chat push is
event-driven (`/cr-push-chat`), case alerts are polled — deliberate.

**Every worker edit ends with handing the owner the file to paste** (SendUserFile, attach)
— he does not use a terminal. State plainly that push maths lag until it is pasted.

Known cost issue (designed, not built): `crTick` does a KV `list({prefix:"cr:sub:"})`
per minute — ~54% of the free KV list quota; replace with an index key.

## Deploy

Push to `main` → `deploy-pages.yml` builds `gh-pages` → GitHub Pages → courtreach.app
(CNAME). Repo is **public** (private Pages needs a paid plan the owner dropped). Verify a
deploy with `gh run list --limit 3`. Old `worker.js` blobs are still reachable at old SHAs
on GitHub despite a history purge (needs GitHub Support to GC) — do not rely on the
purge for secrecy; the worker's real protection is that the current file is untracked.

## Testing conventions (proven here — follow them)

- **No Node on this Mac.** Syntax: extract the module script to a `.mjs` in the
  scratchpad and run `checkModuleSyntax(readFile(...))` with
  `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`. Engine
  tests likewise with jsc (`load("../board-engine.js")`).
- **Behaviour:** `sed 's/^const DEMO = false;/const DEMO = true;/' courtreach.html >
  courtreach-demo.html` (gitignored name), append a `window.__t={...}` hook exposing what
  the test needs (stopPolling, setBoard, setSeq, setRemarks, openCourtModal, courtPlan,
  classify…), serve with the `courtreach-dev` launch entry (port 8811), sign in with
  `window.__demoSetUser("u_ch_jr" | "u_ch_owner" | "u_demo" | …)`. **Delete the demo
  file and hook before committing.**
- **Contamination traps (each cost a session once):** (1) a hidden Browser pane reports
  `innerWidth 0` and screenshots blank — front the tab first; (2) the LIVE board keeps
  arriving — call `stopPolling()` before injecting state, and inject + read in the same
  tick; a real poll that slips in leaves `itemHi`/remarks from the real court in your
  test; (3) SD-Chamber's service worker serves the app shell for any path on its origin —
  preview static files from another port.
- Python's certificate store is broken here — use `curl` for downloads.

## Owner — how to work with him

Direct, expert, allergic to "tested" meaning "looked plausible". Show the check. Prefers
Finder/GUI instructions over Terminal ("I dont understand what run terminal means").
Rejects design that is "slave to the old design"; wants space used for information. Wants
the truth about what is and isn't done — say what was left out and why. Decisions he has
made (don't relitigate): icon badge counts MESSAGES only; no camera icon on islands (VC
links only inside the court sheet); "no result" is not a status — quote the board, or say
over when past in sequence; a passed-over case is never over; time-fixed cases show time,
not distance; the day-sheet sync runs at his six times only.

## Pending (as of 25 Sep 2026)

1. **worker.js paste** (owner) — last handed over 25 Sep (second batch of the day): the
   sequence-parser hardening, both item-link forms, the passover "after item X" fix, AND
   the mentioning-series (800s) classification. Until pasted, push alerts use old maths.
2. KV list-op → index key in `crTick` (designed, not built).
3. SD-Chamber's `sd-board` worker still has an unauthenticated `/push-send` (other repo).
4. GitHub Support request to GC the purged worker.js objects.
5. Optional: move contact fields out of `users` into a lookup collection (enumeration).
6. Regular-list numbering assumes Misc < 101 items (`REG_BASE`); a 100+ Misc list would
   collide — known, unaddressed.
7. "Taken up along with" notes that link by CASE NUMBER rather than item number ("...ALONG
   WITH SLP(C) No. 32577/2026") aren't resolved to a position — parsed and then dropped,
   `fetch_causelist.py` comments explain why. ~3 of the ~26 real examples in the 25 Sep
   causelist were this form; the rest resolved fine.
8. `fetch_causelist.py`'s `PARSER_VERSION` bump (10) forces a full re-parse on the next
   `causelist.yml` run to pick up the item-link fields for already-cached dates.
