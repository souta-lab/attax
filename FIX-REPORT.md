# CC2 rematch investigation

Branch: improve/cc2-rematch. Work in progress. No success claim yet. Opponent and historical artifacts are read-only; no PR is reopened or merged. Existing untracked owner files are preserved.

## Phase 0: mechanisms and review

### chouhy CC2 (b20a92b)

Read src/bot.rs, bot/freestyle.rs, dag.rs, dag/{known,speculated}.rs, lib.rs, allspin.json and default.json. The executable defaults to allspin.json, not upstream default.json. Relative to upstream, height changes -0.4 to -5, excess above 10 changes -1.5 to -10, excess above 15 changes -5 to -45. Singles/doubles/triples become positive rewards (0.8/1.6/2.3 versus -2/-1.5/-1). PC drops 15 to 1. This is a survival/digging policy, not simply higher attack valuation. Hole count and depth of covered cells both cost points; T cutouts are limited by T availability in bag/reserve.

The think loop uses one background worker; do_work selects an unexpanded DAG node, generates all placements, evaluates and backpropagates. Known layers use state maps as transpositions, sharing child evaluation among parents; rank-biased random exploration prevents exclusive greedy expansion. Advancing retains the next layer. The external referee supplies the 100 ms window; it is not a fixed beam inside CC2. Speculative layers enumerate remaining bag pieces, use a best move per realized piece, then average those values; missing moves receive -1000. Thus a board requiring a lucky future piece loses value even if one continuation is excellent.

Transfer: spend extra work preserving alternative roots and evaluating bag-conditioned futures, not just widening a greedy beam. Penalize risk before the final leaf: a line that goes high and later digs down is vulnerable to unseen incoming attacks. Use a separate survival check where immediate death overrides an otherwise attractive attack line. Attax's current leaf-only board score cannot see intermediate exposure.

### 61bi s2-bot-lab engineering

Read bot/cold-clear-2-s2/src/f14_compat/mod.rs ranking/rescue and transport.rs retained rerank compatibility. It exposes a bounded candidate list, computes canonical features and selection scores, uses stable identity/rank tie breaks, and separately rescues a negative-solvency control when a solvent candidate exists. Retained reranking permits updated incoming/time only after compatibility checks; it is not permission to reuse candidates on another board. Transfer: retain candidate identities, re-evaluate survival with authoritative transitions, preserve stable ordering, test rescue separately from ordinary scoring. S2 conversion bonuses and combat rules do not transfer.

### PR #35 maintainer review

Read full gh pr diff/view. Author closed it unmerged; adopt independently only after tests/probes.

* Dedup: adding combo, lift and canHold is correct: they affect future attack/legal continuations. Board/queue/hold/b2b alone are insufficient. A generic exported selector makes unit tests possible. Root identity is deliberately absent, so equivalent states reached by distinct roots can still collapse; diversity is therefore bounded rather than guaranteed.
* Root slots: reasonable bounded exploration heuristic. The 4*width pool can exclude a useful root before quota selection; quota is at most eight, not full diversity. Quality requires A/B evidence, unavailable in the PR. Tests prove the synthetic quota only, not game improvement.
* Unknown garbage truncation: continuing on the old board is physically wrong. However mixing terminal depth-one values with longer discounted reward sums changes the objective. It may favor cancellation or attack for purely horizon reasons. No information about garbage holes is added. TBP adapter always supplies pending=0, so this cannot explain improvement in this rig. Defer shipping this policy until separately evaluated.
* Tests: dedup and quota examples are useful but need canHold/b2b/queue coverage and true duplicate checks. Truncation test establishes depth, not correct decision quality. Existing move reachability tests must remain intact.
* Cross-seed gate: paired accounting is useful, but storing results only after the entire run loses interrupted evidence; missing expected seed identities are not checked, only pair count. A 100%-required exit status is a chosen gate, not statistical proof. Not needed for this task's fixed fresh-seed protocol.

## Phase 1: recorded-loss diagnosis

Read-only mining script: tools/cc2-rematch/diagnose.py; output saved with this report. The glob includes 48 games, broader than the owner's stopped 39-game subset: 10 wins, 32 losses, 6 draws. These must not be substituted for the owner's 9–30 result.

Across these records Attax attack/piece is 0.75040 (16989/22640) versus CC2 0.75064 (17011/22662). Cancellation totals 2644 versus 2645: no evidence of aggregate cancellation imbalance. Attax mean height 7.08 versus 7.63 and holes 2.26 versus 2.81 refute a simple hypothesis that Attax always stacks higher or dirtier. Late Attax APP is 0.7793 versus 0.7800, refuting declining late attack throughput. Late mean height rises to 7.46, but records are survivor-biased.

Every one of the 32 losses ends with a null Attax move at height 19–23. Last-ten-lock histories show repeated 4–5-row rises driving playable medium stacks into the spawn zone. TBP gives Attax no incoming state, so proposed timing-aware cancellation cannot be implemented honestly from this protocol. 201 logged decisions have occupied cells above the represented 20 rows. This representation limitation is real, but not the whole cause: many deaths stop at height 19 with nothing above row 20. Historical decision median is 95.54 ms, p95 186.7 ms across 25292 logs, not the isolated ~35 ms number; machine contention must be controlled when profiling.

Length bins (turns, games/wins): <250 17/3; 250–499 9/2; 500–749 12/4; 750–1000 10/1. Failure is not exclusive to marathons. Priority: intermediate-board exposure and spawn safety, then breadth/bag uncertainty.

## Phase 2 and 3

Pending. Fresh 12001–12020 remain untouched. Every completed or interrupted probe will be recorded here. No published Hoiko headline has been changed.

Probe risk12 (2101 start) was interrupted before any completed game: initial typecheck found a shadowed `options` local that made exposure default to zero. Partial artifacts retained; excluded from performance evidence. Fixed before restarting under a new label. The first full test suite passed 100 tests, including unmodified movegen reachability.

### Implementation checkpoint

Competition options are explicit and disabled for the shipped web default: width, root/attack-economy preservation, intermediate danger cost, and one-ply 7-bag chance evaluation after previews. Chance evaluation averages best legal continuations for every remaining piece; a dead possibility receives a large negative value rather than being omitted. Bag tracking observes queue overlap, counts each preview once, resets at bag boundaries and disables itself on contradictory/discontinuous observations. Authoritative TBP resync bag state is supported because garbage restarts are mid-bag. No hidden future piece or incoming data is invented.

Probe risk12-fixed: seeds 2101–2110, both seats, width 96, diversity enabled, exposure 12, speculation disabled, running. Separate width96-control: 2201–2210, both seats, width 96, no diversity/exposure/speculation, running. These are development seeds only; the fresh final set remains untouched. Independent rig processes share four CPUs; each opponent retains its strict 100 ms window. Timing is descriptive under this contention.

Additional correctness checks pass: authoritative mid-bag resync avoids consuming previews twice; chance continuation obeys the max/average bound and never exposes guessed moves in the executable plan. All 105 tests passed before the added chance test; the six-test new suite also passes. Full rules audit/benchmark remain running. Competition exposure and diversity are still opt-in, so neither exploratory candidate silently changes the web headline.

### External spawn/field defect

Referee engine/src/movegen.rs spawns north at pivot (4,19), retries at (4,20) on collision, and retains a 40-row board. The old adapter maps the highest north cell to row 19, one row lower for non-I pieces, has no retry, and search rejects every result reaching height 20. This can create null decisions even when the referee has legal escapes. Added dynamic board length in bot movegen/features/snapshot conversion, preserving the normal 20-row path. External 40-row spawn is explicit and gets the referee's one-row retry. Original reachability tests remain unchanged. New tests compare low-stack placements and clear outcomes under coordinate translation and exercise elevated spawn/cell preservation. These changes are gated separately via ATTAX_ROWS=40; ongoing 20-row probes retain their old field model.

Gates checkpoint: typecheck passes using `/opt/hatch-image/bin/bun x tsc --noEmit` (bunx shim is absent from PATH); 105-test full suite passes, subsequent new chance/extended-board tests pass; full rules audit seeds 3001–3020 agrees on all 843 locks. Production build passes. Rust is untouched. Full 400-game standard benchmark was launched with HOIKO_ADAPT=0; its default-policy worker predates the external-height patch, so an additional final-source regression check is required. Headline source data remains unchanged.

Third development probe bag40-survival: 2301–2310 both seats; width64, diversity, exposure6, one-ply bag continuation, 40-row representation, `survival-weights.json` (height -24, danger -60, small-clear penalties removed). This is a combined candidate, not an attribution claim about any single mechanism. All three probe batches must finish and be reported, including regressions. Early verified pairs: risk12-fixed 0W/1L/1D, width96-control 0W/4L. Do not infer a final win rate from these partial batches.

Further diagnosis (burned historical positions only): `check-deaths.ts` reconstructs all 32 terminal null boards and active/hold options. Under the old adapter's exact y=0 spawn, 5 have any generated placement, but none has a placement below its height-20 rejection threshold. Under corrected 40-row spawn/retry, 27 have a generated placement. This establishes avoidable model failure, not that those 27 positions are ultimately survivable. The TBP audit glob has 24379 accepted index-0 suggestions and 913 empty responses (the referee can retry empties); no nonempty suggestion required a fallback. Therefore rejected primary placements are not supported as the historical loss mechanism.

Probe interpretation: field/bag/survival's early APP is lower (about 0.54 over the first few hundred locks versus about 0.75 for the other development candidates). This is provisional, not a completed-probe result. Do not attribute any improvement to speculation or heavier survival weights without an isolated comparison. The corrected field model has independent position-level evidence; combined policy changes may still regress.

### Referee attack-profile alignment

Referee game.rs explicitly uses a zero combo table and no PC attack in Guideline mode. The unchanged web engine includes both. Added an opt-in external search profile that suppresses those imaginary attacks and PC clear shaping, and rejects placements wholly above the visible field (the referee's lock-out rule). Core rules and Hoiko remain untouched. Test checks a PC double at combo 5: web predicts 14 attack, external profile predicts 1. Fourth 20-game probe field40-aligned (2401–2410, both seats): width96, diversity, no exposure/speculation, default weights, corrected field/spawn and aligned attack profile. Subsequent probes snapshot all source and adapter files before play, preventing later edits from changing a running candidate.

Quantification of profile mismatch on the same 48 complete historical games: the 22640 Attax locks would accrue 6055 extra combo attack and 400 extra PC attack under the web model, beyond the actual 16989 referee attack. These are counterfactual reward terms, not attack that was sent. This does not by itself prove how many decisions change; it does justify aligning the search model before spending more compute on that model. Both the default web attack calculation and its published results remain intact.

Latest source gates: 109 tests pass (9534 assertions), lint and typecheck pass. Final-source ordinary-policy Hoiko development check (2501–2510, both seats, HOIKO_ADAPT=0) completes 16W/4L, APP 0.70944 versus 0.55854, recorded in bench-results/rematch-final-source-check.jsonl. This is a regression check, not a replacement headline. Full standard held-out run remains in progress. No competition candidate was selected using these held-out results; the ordinary web policy remains the baseline.

A/B pre-registration: after width96-control finishes, run field40-no-diversity on the same 2401–2410 seed pairs as field40-aligned, changing only the diversity/complete-state selector. Both use aligned combat, corrected field, width96, no exposure/speculation and ordinary weights. This isolates the PR-derived search selector rather than attributing the combined risk probe to it. Compare full 20-game paired batches; select the final profile using tuning results only, then freeze before touching 12001–12020. CC2 search is wall-clock/randomized, so seat/seed matching reduces variance but does not make opponent choices identical.
