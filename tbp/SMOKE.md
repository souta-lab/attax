# Packaged TBP smoke test

Run on 2026-11-13, offline, with Bun 1.4.4 and the already-built local
intetrigence referee. Method (a): real external-arena games, not a mock handshake.

From the repository root, with Bun on PATH:

```sh
python3 tbp/smoke.py /path/to/intetrigence/target/release/intetrigence
```

The script used Guideline rules, seed 6001 in both seats, 100 ms local search,
5 PPS, and a 1000-turn cap. It launched the repository's shell entry point from
a temporary working directory. Output:

```text
game 1/2: 0W 1L 0D, 153 turns
game 2/2: 0W 2L 0D, 127 turns
verified 2 complete matches
PASS: 2 games, 280 legal Attax moves, 0 fallbacks; replay verified
```

The W/L counters are intetrigence's: Attax won both games. The referee validates
placements with its own legality check. The smoke script also matched all 280
accepted external moves against the adapter's logged first suggestions and found
no decisions with cells above the 20-row view. Replay verification re-executed
both games. Temporary logs/replays are deleted on completion; rerun the command
to regenerate them.

Repository gates:

```text
bunx tsc --noEmit     PASS
bun test             100 pass, 0 fail; 9481 expect() calls across 13 files
bun run lint         PASS
bun run build        PASS
```

Dependencies were copied from an existing local installation; no network was
used. An initial build through a dependency symlink failed because Vite's
temporary config directory was read-only. The build passed with a writable
local dependency copy and produced no tracked dist changes.

No src/ or rust/ files changed; no benchmark rerun or cargo test was required.
The root TypeScript configuration covers src/; the Bun entry point is exercised
by the real-process smoke test and checked by the repository linter.
