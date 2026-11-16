# Attax search port: first verification

Verified on 2026-11-14, starting from WIP HEAD `0a38e86`. No compile errors or
failing existing tests were found. No policy values or search behavior needed fixing.
The incorrect claim that `powf` always matches Bun bit for bit was corrected.

## Scope

`attax-search` ports the TS hot path, keeping rules, search policy and adapters separate:

- `pieces.rs`: native piece cells, shape masks and ordered SRS kick tables.
- `movegen.rs`: engine-input BFS, open-air seeds, ordered resting placements,
  T-spin classification, equivalent-cell deduplication, lock and line clear.
- `features.rs`: all 11 integer board features, including garbage lift and T slots.
- `weights.rs`: the default policy table and feature dot product.
- `search.rs`: known-queue beam search, hold, rewards, guideline lock-out and attack,
  pending garbage, stable sorting, deduplication, optional root diversity/exposure,
  fallback on top-out, candidate values and planned lines.
- The SPECULATE uniform chance ply **is implemented**, including dead-branch cost.
  It was tested separately below; it is not a missing feature.
- `attax-search-cli` provides the JSONL `attax-agree` verifier and native timing.

Not ported/integrated here: fighter/controller scheduling, executable TBP match adapter,
web-worker/WASM search interface, browser execution, or self-play tuning orchestration.
No Rust search was used in matches. Hoiko, the TS reference and published results were
left untouched. Non-guideline, 20-row, custom-weight and diversity/exposure modes exist
but have not received recorded-corpus agreement coverage in this round.

## Weights as plain data

All 24 parameters match `src/ai/bot/weights.ts` value for value: 11 board terms,
attack, nine clear terms, B2B break, wasted T and discount. There was no drift.
`defaults_match_ts_reference` now checks the source table independently during
`cargo test`; the agreement CLI loads the TS weights supplied by each case and
therefore could not itself detect drift in Rust defaults.

`Weights` has public fields and no embedded policy overrides. `param_names()`,
`to_params()` and `from_params()` expose a deterministic 24-element vector;
`board.<feature>` and `clear.<kind>` names match the TS JSON paths. A future
self-play tuner can set `SearchOptions.weights` directly or supply the TS-shaped
weights object through the CLI. No search-source edits are required to tune policy.

## Corpus and decision agreement

Source: `tools/cc2-rematch/evidence/width96-control.tar.gz`, seeds 2201–2210,
both recorded games per seed. Archive SHA-256:
`bbfc9a580b492d4882f1acbfc22b54d4b65a1bc6431d2f28b40bf3796aeca71b`.
`rust/verify.mjs` verifies Hoiko WASM primitives, not Attax search decisions.
The existing `tools/search-port/dump-cases.ts` reconstructs boards and runs the
current TS reference; historical played moves are not used as search expectations.

The archive contains 6,137 Attax move records. This round samples turns divisible
by 20, excluding the first record and null moves as the dumper specifies:
298 distinct inputs, each with and without speculation, giving **596 cases**.
This is a sampled corpus, not an exhaustive replay sweep. Frozen options:
40 rows, guideline enabled, width 96, diversity disabled, exposure 0, default weights.
Inputs use the recorded hold/preview, spawn (3,19), reconstructed B2B, combo -1,
pending 0, and the reconstructed bag remainder for speculation.

| Mode | Decision agreement | Full exact agreement |
| --- | ---: | ---: |
| Known queue | 298/298 (100%) | 298/298 (100%) |
| Chance ply | 298/298 (100%) | 133/298 (44.63%) |
| Combined | **596/596 (100%)** | 431/596 (72.32%) |

No disagreeing decisions or fixable behavioral divergences were observed. All 165
non-exact cases differ only in final/candidate floating-point values: best steps,
whole planned lines (including rewards), node counts, depth and candidate order
match exactly. Largest absolute leaf or candidate value difference: 2.2737367544323206e-13.
98 cases differ in the winning value; 67 differ only in other candidate values.

The observed source is exponentiation rounding at the additional chance depth:
Rust/libm `0.97f64.powf(6.0)` has bits `3feaa7b4e7f4ea55`, while Bun 1.4.4
`0.97 ** 6` has `3feaa7b4e7f4ea56`. Earlier depths 0–5 match on this host.
No epsilon, weight adjustment or tie-break workaround was added. The full verifier
still exits 1 for these differences. See `search-port-evidence/rounding-differences.json`
for every affected board and its values. Other platforms may round differently.

`search-port-evidence/cases.jsonl.gz` retains all inputs, TS expectations and TS
measurements; `results.jsonl.gz` retains all Rust outputs and timings. Uncompressed
case SHA-256: `16ed7a2f166ac417cc86ae0086b24e929ebb52aeba8fb3e6b067b68e60356c69`.
The eight-board `attax-search-cli/tests/recorded.jsonl` regression subset covers
populated late-game stacks (heights 15–18), both speculation modes, and exact full
agreement. The complete corpus retains the rounding cases rather than dropping them.

## Timing and budget

One release run, one measurement per input, native x86_64 AMD EPYC 9D25 VM,
Rust 1.99.1, Bun 1.4.4. These are local measurements, not browser or match claims.
TS ran first with the dumper's 20 warm-up searches; Rust reused one Searcher.

| Mode | Mean ms | p50 ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: |
| Known queue | 25.27 | 19.08 | 51.26 | 70.90 |
| Chance ply | 44.97 | 40.50 | 72.45 | 86.73 |
| Combined | 35.12 | 27.80 | 68.67 | 86.73 |

15,628,324 attempted expansion nodes total; 26,222 per decision on average;
0.75 million nodes/s (about 1.34 microseconds per attempted node, including whole
search overhead). Maximum node count was 55,204. TS mean was 133.85 ms, p95
236.99 ms, max 422.48 ms; total-time TS/Rust ratio 3.81x.

Goal: run the **same width-96 search within 100 ms per decision on heavy late-game
boards**, preserving decisions. At the observed maximum node count, the total
amortized cost budget is about 1.81 microseconds/node; more demanding boards may
require a lower cost. Every sampled decision met 100 ms on this native host.
This does not establish a worst-case guarantee: broader high-stack/top-out inputs,
repeat runs, and the eventual deployment target still need measurement.
100% decision agreement is required before any match use; this sample meets that
bar, but exhaustive corpus/edge coverage and integration validation remain work.

## Reproduce

From the repository root, replay the retained cases without rerunning TS:

```sh
gzip -dc rust/search-port-evidence/cases.jsonl.gz > /tmp/attax-cases.jsonl
cd rust
cargo test
cargo run --release -p attax-search-cli -- /tmp/attax-cases.jsonl --out /tmp/attax-results.jsonl
```

The last command reports 100% decision agreement but returns **1** because full
exact agreement is stricter. Do not suppress that distinction. The original console
summary is retained in `search-port-evidence/summary.txt`.

To regenerate the TS expectations (the dumper was an existing untracked lane artifact
at the start of this round, and must be retained when orchestrating the commit):

```sh
mkdir -p /tmp/attax-width96
tar --no-same-owner -xzf tools/cc2-rematch/evidence/width96-control.tar.gz \
  -C /tmp/attax-width96 --wildcards '*.jsonl'
ATTAX_ROWS=40 ATTAX_GUIDELINE=1 ATTAX_WIDTH=96 \
  bun tools/search-port/dump-cases.ts /tmp/attax-cases.jsonl \
  --step 20 --speculate both /tmp/attax-width96/[0-9][0-9][0-9][0-9].jsonl
```

Timing fields and path-derived IDs change when regenerating; use the retained corpus
for the exact case hash. Final workspace `cargo test`: 6 search unit tests,
1 CLI integration test (8 recorded boards), 60 Hoiko tests, all passing.
No tests were weakened. No TS edits or commits were made.
