# board-engine.js stress tests

The proximity engine is the heart of CourtReach, so it is checked against a
simulator of a court's day rather than against hand-picked examples. Run with
JavaScriptCore (this Mac has no Node):

    cd engine-tests
    JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
    $JSC sim-day.js          # ~600,000 checks: sequences (none / partial / full permutation),
                             # passovers recalled at the end of the list or at the announced
                             # "passovers" point, with and without a Regular list, every item
                             # tracked at every tick — engine distance must equal the true one
    $JSC sim-round2.js       # unannounced mid-list recalls (invariants), explicit "after item X"
                             # marks, a board that never posts OVER, parser + position checks,
                             # the owner's Court 8 worked example
    $JSC sim-fixed-time.js   # time-fixed matters: clock parsing and the minutes-based tiers

Truth in the simulator is the KNOWABLE truth: a passover that has not happened
yet cannot be foreseen, so before it happens the item is expected at its
ordinary slot; once it has, its recall is expected where the court will take it
(after a named item, at the sequence's "passovers" point, else the end of the
Miscellaneous list) in the order the matters were passed over.

All three must print 0 fails before board-engine.js is shipped — and the copy
embedded in worker.js must be re-embedded afterwards (see PUSH-SETUP.md).
