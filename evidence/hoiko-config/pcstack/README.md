# `usePCstack` — exe equivalence (Phase 1)

Option under test: `ConfigAI.usePCstack` (shipping `config.dll` has it `false`).
Enabled on the exe by the `ScpDriverStub` input key `usepcstack=1` (raw write of
ConfigAI RVA `0x66339` before `SearchAI.ReadConfig`), on the replica by
`use_pcstack` in `HSearchInput` / `HOIKO_USE_PCSTACK=1` for `eval_dump`.

Implemented in `rust/hoiko-core/src/evaluate/pc.rs`:
`pc_stack` = binary `lambda1_pcStack` (IL 11660), `pc_stack_valid` = binary
`lambda1b_valid` (IL 11697); gated exactly as IL 11649 (`SearchPcBoard`).

Harness: `tools/hoiko-oracle/diff/config.ts --pcstack [--n=N] [--viewnext=V] [--search]`.
It runs, per corpus position:

1. exe `eval=2` (depth-2 breadth, every child's state + all eval terms) with the
   option **off** and **on**;
2. the replica `eval_dump eval_bfs` with the option on;
3. every `E`/`EB` node's state (`x,y,rot,m,act,delay,combo,btb,stack,nextBase,
   trustEnd,win`), `fall`/`lock`/`ch`, rows, and all eval terms
   (`minH,height,well,wellCol,wellDepth,updown,under,ground,res,tsd,tst,pc,cont,
   action,board,fscore,score`) compared field-by-field;
4. with `--search`, the exe `SearchAI.Search` first move + `GetDelay` + depth vs
   the replica search (depth 10, no adaptation).

## Results

`report-viewnext2.json` (default `viewNext=2`, `--n=12 --search`):

- **14/14 cases match** (positions: empty, stub-default, 12 random boards with
  stack heights 0..7), **29,575 exe-evaluated nodes**, **0 diffs**.
- `pc != 0` on **4,192** of those nodes — the gated branch is actually exercised,
  not just inert-agreeing.
- `optionChangedNodes` (exe on vs off) > 0 for every case (19–79 nodes changed),
  proving the exe-side override flips the branch.
- **14/14 search decisions match** (x/rot/m, depth, GetDelay).

`report-viewnext12.json` (the README's "PC stack valid when next is 12",
`--n=6 --viewnext=12`):

- **8/8 cases match**, **18,716 exe-evaluated nodes**, **0 diffs**.

Note: at `viewNext>=5` the exe/replica must both receive a full 27-piece real
queue (`m[i] = realNext[i]` pinning up to `viewNext-1`); a short queue makes the
replica pin `None` where the exe pins bag predictions. The harness now always
sends 27 pieces.

`report.json` is the last harness run; the raw per-case logs
(`*-exe-on.log`, `*-exe-off.log`, `*-replica.txt`) belong to the `viewNext=12`
run that was executed last. Re-run the commands below to regenerate either.

## How to reproduce

```bash
# working oracle prefix/run staged under /tmp/opencode/oracle
cd /home/s0u7a/browser-tetris
cargo build --release --example eval_dump --manifest-path rust/Cargo.toml
bun tools/hoiko-oracle/diff/config.ts --pcstack --n=12 --search
bun tools/hoiko-oracle/diff/config.ts --pcstack --n=6 --viewnext=12
```

Raw per-case logs: `*-exe-on.log`, `*-exe-off.log`, `*-replica.txt`.

## Default config unchanged

`bun tools/hoiko-oracle/diff/diff.ts` is still **9/9 first-move + GetDelay
(depth 10)** with the new wasm; the option defaults to `false` in the TS engine
and the FFI field is `0` unless requested.
