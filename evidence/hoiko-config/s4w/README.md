# `useS4W` — exe equivalence (Phase 2)

Option under test: `ConfigAI.useS4W` (shipping `config.dll` has it `false`).

The port's S4W body previously implemented a richer CPP variant (`0x387` pattern,
`h*h*UpDown2`, `*2`). It now matches the binary's `GetResource` lambda exactly
(`SPEC_EvaluateAI.md` entry #6): only `line[y] == 0x3F` / `0x3F0` are recognised and it
returns only a `comboTable` bonus. `useS4W=false` previously hid the divergence (both
sides evaluate to `+0`), so this only matters once the option is enabled.

Enabled on the exe by the stub input key `uses4w=1` (raw write of the `ConfigAI` field
before `SearchAI.ReadConfig`), on the replica by `use_s4w` in `HSearchInput` /
`HOIKO_USE_S4W=1` for `eval_dump`.

## Results

`report.json` (default `viewNext=2`, `--n=12 --search`):

- **18/18 cases match** (12 random boards + 4 S4W-shaped positions), **0 field diffs**
  across all exe-evaluated nodes (state, board, and every eval term).
- **18/18 search decisions match** (x/rot/m, depth, GetDelay).
- The S4W-shaped positions (`s4w-h5/h8/h12/combo4`) flip the branch
  (`optionChangedNodes` 110–676), so the option is genuinely exercised rather than
  inert-agreeing.

The raw per-node dumps (`*-replica.txt`, `*-exe-*.log`) are gitignored (bulky);
regenerate them with the command below.

## Reproduce

```bash
cargo build --release --example eval_dump --manifest-path rust/Cargo.toml
bun tools/hoiko-oracle/diff/config.ts --s4w --n=12 --search
```
