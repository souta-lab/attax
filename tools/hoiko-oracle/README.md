# Hoiko runtime oracle — verify the TS port against the real binary

This directory contains a harness that runs the shipping `Hoiko.exe` search on a
synthetic position and prints the chosen move, so the TypeScript reconstruction in
`src/ai/native/` can be checked 1:1 against the real thing.

The proprietary Hoiko files (`Hoiko.exe`, `config.dll`, the weight DLLs) are **not**
included in this repo. You must supply them (`Hoiko_PPT_v0-beta1`).

## Why this works

`Hoiko.exe` is a C++/CLI mixed-mode .NET assembly whose search entry points are managed
IL methods on the `<Module>` type (`SearchAI.Search`, `RootNode.Init`, `ExpandAI.ExpandNode`,
`EvaluateAI.Evaluate`, …). The search core is game-independent: `RootNode` is a plain
struct. Mixed-mode assemblies can only be loaded as the process **main module** (they
cannot be `Assembly.LoadFrom`'d, and Mono/.NET Core reject the native code), so the harness
runs `Hoiko.exe` directly under Wine + .NET Framework 4.8, after replacing
`ScpDriverInterface.dll` (a separate, pure-managed assembly) with a stub that no-ops the
Xbox-pad layer and hosts a worker which invokes the search on a synthetic board.

## Setup (Linux)

```bash
./setup_prefix.sh                 # wine + winetricks; installs .NET 4.8 into ./prefix (~15 min)
export HOIKO_DIR=/path/to/Hoiko_PPT_v0-beta1
./build_oracle.sh                 # builds the stub, stages ./run
```

## Run

```bash
./run_oracle.sh                   # runs once, prints ./run/oracle_result.txt
```

Edit `run/oracle_input.txt` to change the position:
- `board=` comma-separated hex ints written **directly** into `Board.line[]`
  (row 0 = bottom; column `c` = bit `9-c`; use `board=0x0,0x0,...` for an empty board —
  a bare `board=0x0` leaves the stub's default col-9 rows 1..3 set).
- `next=` 28 native `MinoType` ints (`I=0,J=1,L=2,O=3,T=4,S=5,Z=6`); `next[0]` is the
  current piece.

Output includes `firstMove @456: x=.. y=.. rot=.. m=..`, `depth @444`, `beamLimit @452`
and `GetDelay`.

## Differential comparison (oracle vs TypeScript)

```bash
cd diff
bun diff.ts                 # all positions: first move + delay
bun diff.ts --timer empty   # depth-14 (timer started)
bun twosearch.ts            # beam-size adaptation across two searches
```

Last recorded result (repo state `4102971`): **9/9 depth-10 first-move match, 9/9
two-search beam match, 2/2 depth-14 match**. See `diff/REPORT.md`.

## Reference material

- `REFERENCE.md` — 1-page digest of the binary's config/constants/search loop.
- `SPEC_Search.md`, `SPEC_ExpandAI.md`, `SPEC_EvaluateAI.md`, `SPEC_CalcAtk_IsTspin.md`
  — per-function reconstructions with IL line citations.
