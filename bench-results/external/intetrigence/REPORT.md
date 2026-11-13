# Attax vs intetrigence — head-to-head report

Date: 2026-11-13. Nothing published; all artefacts are local in `~/workspace/intetrigence-vs/`.

## Headline

**Final counted result: Attax 100 – 0 intetrigence** (100 games = 50 held-out seeds 5001–5050 × both seats, 0 draws).
Attax win rate 100 %, **Wilson 95 % CI 96.3 %–100 %**. Seed pairs: Attax swept 50/50, split 0, intetrigence swept 0.

| side | attack / piece | lines / game | pieces / game | garbage rows received (total) |
|---|---|---|---|---|
| Attax | **0.559** | 83.5 | 142.3 | 3,146 |
| intetrigence | 0.317 | 96.2 | 141.3 | 6,573 |

(Source: `runs/final-5001-5050.summary.json`, produced by `analyze.py`.)

## Route taken

Route (a) from the brief: intetrigence's own referee, `intetrigence external-arena`, hosts the games and drives
Attax as an external **TBP** (Tetris Bot Protocol) process through the adapter `attax-tbp.ts` (launched by `attax-tbp.sh`).
The adapter keeps track of board, queue, hold, combo and B2B from the TBP messages (`start`, `play`, `new_piece`). On each
`suggest` it builds an Attax `GameSnapshot` and calls Attax's own fighter (`createBot().findBestMove`, from
`~/workspace/tetris-speed/deepseek-tetris/src/ai/bot/fighter.ts`, commit `4b2c724`). It returns the chosen placement
translated into TBP coordinates. No Attax logic is reimplemented.

Host engine: intetrigence `e816913`, `--rules guideline`. That means the public multiplayer attack table (Single 0 / Double 1 /
Triple 2 / Tetris 4, T-Spin S/D/T 2/4/6, B2B +1), **no combo or perfect-clear attack**, incoming garbage cancelled and then
fully inserted after each lock, SRS placement legality, and a 7-bag randomizer (see `intetrigence/docs/validation.md`). The
referee checks every move with `Game::legal` and plays it itself.

The replay labels the external bot `cold_clear_2`, because that name is hard-coded in `src/arena.rs:690`. **In these runs that
label means Attax.** The opponent path in every replay header is `./attax-tbp.sh`, and Attax's decision log has exactly one
entry per `cold_clear_2` move (14,230 = 14,230).

## Exact conditions

| | Attax | intetrigence |
|---|---|---|
| search | fixed beam search, width 48, current piece + 5 preview (`BOT_DEFAULTS = {preview: 5, width: 48}`), default weights; reached depth 6 on 98.7 % of moves | Cold-Clear-2-derived MCTS, time-based `--ms 100`, default worker count (up to 8 workers; 4 CPUs on this host), default weights |
| per-move budget given by the harness | **none** (non-strict mode: the referee sends `suggest` and blocks until Attax answers; Attax's search is fixed-work, not time-limited) | **100 ms nominal** (`--ms 100`) |
| measured think time per move | mean 38.3 ms, median 35.0, p95 69.2, max 297.6 ms (69 of 14,230 moves > 100 ms) | mean 200.2 ms, median 150.9, p95 406.0, max 766.6 ms (the `--ms` target is overrun, as the README warns) |
| preview | 5 | 5 (referee queue = active + 5) |
| hold | yes (`canHold: true`; used regularly) | yes |
| incoming-garbage info | none (TBP has no garbage message; adapter sends `pendingGarbage: 0`) | sees the referee's pending queue |
| board height | 20 visible rows (adapter maps the TBP 40-row board; 0 turns had cells above row 20) | 40 rows |

Shared settings: `--pps 5` (turn pacing: one piece per 200 ms wall clock per side), `--turns 1000` cap (never reached),
seat swap on (each seed is played twice with the seats swapped). The two seats use fixed piece/garbage-hole sequences derived from the seed
(`seed` and `seed ^ 0x9e37…`), so across a seed pair each AI plays both sequences. Seeds 5001–5050 are held out: neither
project's docs or benchmarks use them (intetrigence's published runs use 101, 1200001, 9001, etc.; Attax's REPORT uses 1001–1200).

The 100 ms / 5 PPS profile is one of intetrigence's own published evaluation profiles
(`results/comparisons/cold-clear2/external-retained-100ms-5pps-100.json`, a non-strict external TBP game against Cold Clear 2;
intetrigence won 77–23 there). intetrigence therefore ran at a documented normal-strength setting.

## Settings audit (done before trusting the partial result)

1. **The "0W 47L" in `runs/main-5001.progress` is counted from intetrigence's side.** In `src/main.rs`
   (external-arena loop), `wins` is incremented when the winner is the *local* intetrigence player
   (`Some(p) if (p == 0) != result.swapped => wins += 1`). The replay agrees: every `result` record in
   `runs/main-5001.jsonl` has `"winner_agent":"cold_clear_2"`, which is the external bot, i.e. Attax. So the partial
   scoreline was **Attax 47 – intetrigence 0**, not the reverse. The hand-off brief read it the wrong way round.
2. **Attax was not starved.** Non-strict `TbpClient::choose` (`src/tbp_client.rs`) sends `suggest` and does a blocking
   `read_line`. Attax computes synchronously, so its beam-48 search always ran to completion. `runs/main-5001.attax.log`
   has 6,941 entries and 0 errors or empty answers. Depth was 6 on 6,852 moves and 5 on 89 moves (searches where the
   lookahead ran out of pieces, e.g. after a hold). Time: mean 38.4 ms, max 172.5 ms. Its first choice was accepted
   exactly on 6,941/6,941 moves, with **0 fallbacks** to alternative cells, orientations or spin labels. The same holds
   for the full 100-game set (14,230/14,230).
3. **intetrigence was not starved either.** It got its configured 100 ms target and actually used more: median 151 ms,
   p95 406 ms. The local search runs while the Attax process is idle, waiting on stdin (Attax does not ponder), so there
   was no CPU contention between the two. All shards ran one after another; nothing else ran in parallel.
4. **Preview, hold:** both sides got 5 previews and could hold.
5. **Information asymmetry, which works against Attax:** Attax never sees pending garbage, and intetrigence does. Under
   guideline rules, garbage is inserted right after each lock, so at decision time the pending queue is usually empty
   (max pending seen by intetrigence: 5).
6. **Integrity:** `intetrigence verify-replay` re-executes the replays and confirms 46 + 28 + 26 = 100 complete matches.

**Verdict: the settings were fair.** If anything, the time budget favoured intetrigence: it used about 5× Attax's
median wall time per move. No budget change was needed, so the measurement was completed rather than restarted.

## Partial observation vs. final counted result

- **Partial (previous lane, not counted on its own):** `runs/main-5001.*`, seeds 5001–5024, run killed during game 48/50.
  It finished 47 games, all won by Attax (Attax 47 – 0). Game 47 (seed 5024, unswapped) has no seat-swapped partner, so
  it is dropped from the count.
- **Final counted set:** the 23 complete seed pairs of the partial shard (5001–5023, 46 games, extracted unchanged into
  `runs/main-5001.pairs5001-5023.{jsonl,attax.log}`), plus two new shards using the identical command line: 5024–5037
  (28 games, `runs/main-5024.*`) and 5038–5050 (26 games, `runs/main-5038.*`). **Total 100 games, 50 pairs: Attax 100 – 0.**
  Each shard independently: 46–0, 28–0, 26–0. Attack/piece per shard (Attax / intetrigence): 0.57/0.33, 0.55/0.32,
  0.54/0.29 (`runs/*.summary.json`).

## Sanity check: is intetrigence playing at its usual strength here?

SANITY_PLACEHOLDER

## Reproduce

```sh
cd ~/workspace/intetrigence-vs
(cd intetrigence && cargo build --release)            # intetrigence e816913
# Attax lives at ~/workspace/tetris-speed/deepseek-tetris (override with ATTAX_REPO); needs bun.
./run-main.sh      # original 4×50-game plan (shard 5001 is the partial one above)
./run-finish.sh    # the two completion shards: seeds 5024-5037 and 5038-5050, both seats
# one shard by hand:
ATTAX_TBP_LOG=$PWD/runs/main-5024.attax.log ./intetrigence/target/release/intetrigence external-arena \
  --rules guideline --opponent ./attax-tbp.sh --games 28 --seed 5024 --ms 100 --pps 5 --turns 1000 \
  --output runs/main-5024.json --replay runs/main-5024.jsonl
# combine + analyse
cat runs/main-5001.pairs5001-5023.jsonl runs/main-5024.jsonl runs/main-5038.jsonl > runs/final-5001-5050.jsonl
cat runs/main-5001.pairs5001-5023.attax.log runs/main-5024.attax.log runs/main-5038.attax.log > runs/final-5001-5050.attax.log
python3 -I analyze.py runs/final-5001-5050.jsonl runs/final-5001-5050.attax.log
./intetrigence/target/release/intetrigence verify-replay --input runs/main-5024.jsonl
./run-sanity-cc2.sh  # intetrigence vs real Cold Clear 2, same settings, seeds 6001-6005
```

Note: in the shard JSON files (`runs/main-*.json`), `wins`/`losses` are from intetrigence's point of view, so `"wins": 0`
means intetrigence won nothing.

## Caveats

- **The result is surprisingly one-sided. The weakest link is the rules/eval match, not the harness.** Attax's attack
  efficiency (0.56 APP) is ~1.75× intetrigence's (0.32). Attax is a downstack/attack beam searcher tuned on a
  tetris/T-spin-heavy versus game. intetrigence's Guideline search is younger (validation.md describes it as a recent
  addition). These numbers describe *this* rules profile at *this* budget only. The supplementary arena-rules run
  (`run-arena.sh`, combo + PC attack) was **not run**.
- **Timing is not strictly symmetric.** Non-strict mode gives Attax unlimited time per move. In practice it used much
  less than intetrigence did, but this is not an equal-budget test in the strict sense. intetrigence's
  `--strict-external-time` mode was not used. It SIGSTOPs the child, and a synchronous bot like Attax would simply
  finish its search after the window, so it would not change Attax's search either.
- **One budget only.** Only intetrigence 100 ms/move, 5 PPS, default workers on a 4-CPU VM was tested. Longer budgets or
  more cores might help intetrigence. That is unmeasured.
- **TBP cannot carry garbage information.** Attax is blind to pending garbage, and the adapter also caps it to a 20-row
  view (never hit in practice).
- **Seeds within a pair are correlated** (same two piece sequences). Even counted as 50 independent pairs, 50–0 gives
  Wilson 95 % CI 92.9 %–100 % for the per-pair win rate.
- intetrigence search is stochastic, so exact replays of the match will differ. `verify-replay` re-checks the recorded games.
