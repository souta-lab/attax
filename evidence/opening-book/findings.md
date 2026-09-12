# Opening book (PCO) — measurement and decision

**Decision: NOT adopted. The book stays behind `openingBook` (default off).**

## What was built

A small Perfect Clear Opener (PCO) book for DeepSeek v2:

- `src/ai/opening-book.ts` — runtime book. It engages **only** in the true
  opening (empty board, first decision, `hold` unused, no pending garbage,
  `lines === 0`) and replays a precomputed assembly as faithful
  `placeAt`/hold `AiMove`s. Every step re-validates the live board, active
  piece, hold and `canHold`; any deviation or garbage permanently disables the
  book for the match and the normal v2 search takes over.
- `src/ai/opening-book-data.ts` — generated lines for **3360/5040** first bags
  (66.7%), keyed by the exact seven first-bag pieces.
- `scripts/gen-opening-book.ts` — deterministic generator. For every bag it
  exact-covers the PCO first-bag shape (4x4 I/J/L/O square + T/S/Z stack) and
  schedules a legal assembly (hard drops + SRS kicks, at most one hold) that
  clears no line. Re-run with `bun scripts/gen-opening-book.ts`.
- `scripts/gate-book.ts` — the measurement harness (below).
- `tests/opening-book.test.ts` — 5 tests: real-engine full PCO assembly,
  fallback+disable on deviation, no engagement off an empty board, and
  book-on/book-off debug telemetry.

The book is compiled into the TS v2 only. Hoiko (`rust/hoiko-core`,
`rust/hoiko-wasm`) and the v2 search/eval are untouched.

## Method

Fixed fresh seeds, declared up front and never changed:
`401,409,419,421,431,433,439,443,449,457,461,463`.
Not the 32-seed corpus, not earlier held-out seeds (301–367).

```
bun scripts/gate-book.ts        # both configs, 6 shards, TICK_MS=16, cap 12000
```

Both the "without" and "with" configs run the same TS v2 (depth 7 / width 24)
against the same Rust Hoiko (`we`, beam 500) on the same seed, so the only
difference is the book. `DSV2_RUST` is forced off whenever the book is on.

## Results (12 seeds)

| config  | W-L-D/cap | lines F-A | sent F-A | avg ticks | atk/piece | tetris | exec fails |
|---------|-----------|-----------|----------|-----------|-----------|--------|------------|
| without | 12-0-0/0  | 401-95    | 248-37   | 762       | 0.246     | 14     | 0          |
| with    | 12-0-0/0  | 379-90    | 240-32   | 723       | 0.251     | 9      | 0          |

The book fired on the 8 covered seeds (`409,431,433,439,443,457,461,463`);
`401,419,421,449` are uncovered and therefore byte-identical between configs.

Per-seed attribution (`without -> with`):

| seed | covered | ticks | lines for | sent |
|------|---------|-------|-----------|------|
| 409  | yes     | 420 -> 720   | 17 -> 27 | 15 -> 20 |
| 431  | yes     | 645 -> 615   | 26 -> 26 | 18 -> 17 |
| 433  | yes     | 1050 -> 758  | 48 -> 36 | 22 -> 20 |
| 439  | yes     | 765 -> 833   | 34 -> 36 | 23 -> 23 |
| 443  | yes     | 1050 -> 983  | 44 -> 45 | 21 -> 17 |
| 457  | yes     | 638 -> 443   | 28 -> 18 | 14 -> 17 |
| 461  | yes     | 660 -> 608   | 27 -> 26 | 15 -> 15 |
| 463  | yes     | 1125 -> 930  | 51 -> 39 | 33 -> 24 |

No seed changed winner and no execution mismatch or expected-board failure was
observed in either config.

## Why not adopted

Wins are unchanged (12-0 both) and nothing regressed, but the result is **mixed**:

- efficiency signals improved slightly — attack-per-piece `0.246 -> 0.251`
  (+2%) and average ticks `762 -> 723` (-5%);
- pressure output fell — total lines `401 -> 379`, total sent `248 -> 240`, and
  the lines margin `+306 -> +289`.

The per-seed deltas go both ways (e.g. 409 is slower and weaker, 457/463 are
faster but clear fewer lines), so the book does not clearly improve the
strength/efficiency metric. Under the strict "only keep if it measurably
improves" rule a mixed result is a negative. The book is therefore committed
**disabled by default**; no default or Rust/app path was changed.

## Reproduce

```
bun scripts/gen-opening-book.ts                 # regenerate the book data
bun scripts/gate-book.ts                        # before/after table
DSV2_BOOK=1 HOIKO_SEEDS=409,463 bun scripts/gate-v2.ts   # raw book run
bunx tsc --noEmit && bun test && bun run build && bun run lint
```
