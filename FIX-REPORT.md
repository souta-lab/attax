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
