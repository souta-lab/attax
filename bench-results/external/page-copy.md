# Copy for https://s0u7a.f5.si/attax/

The live page is `lang="en"` and its strings are English (`src/brand.ts`, `index.html`), so
the blocks below are English. A Japanese version of each block is at the end, in case the
site wants one.

Every number comes from `~/workspace/tetris-speed/REPORT.md` (Hoiko) or
`~/workspace/intetrigence-vs/REPORT.md` (intetrigence), or
`~/workspace/attax-gauntlet/REPORT.md` (clys section).

---

## Block A: tagline (replaces `BRAND.tagline` in `src/brand.ts` and the meta description in `index.html`)

> A versus AI for the falling-block game. It won 195 of 200 games against Hoiko, 100 of 100 against intetrigence (derived from MinusKelvin's Cold Clear 2), and 88 of 100 against clys.

## Block B: headline line under the title (keep the existing three Hoiko stat tiles; add this line under them)

> In guideline versus rules, across the three measured opponents — Hoiko, intetrigence (derived from MinusKelvin's Cold Clear 2), and clys — nothing tested comes close.

## Block C: new results section (goes directly after the stat tiles, before the live arena)

### Results

| Opponent | Games | W–L | Win rate (95% Wilson CI) | Attack / piece (Attax vs opponent) |
|---|---|---|---|---|
| Hoiko (Rust/WASM replica of Hoiko.exe) | 200 | 195–5 | 97.5% (94.3–98.9%) | 0.70 vs 0.46 |
| Hoiko, Attax limited to Hoiko's 2-piece preview | 100 | 89–11 | 89.0% (81.4–93.7%) | 0.58 vs 0.46 |
| intetrigence (derived from MinusKelvin's Cold Clear 2) | 100 | 100–0 | 100% (96.3–100%) | 0.559 vs 0.317 |
| clys (by citrus610) | 100 | 88–12 | 88.0% (80.2%–93.0%) | 0.7346 vs 0.7791 |

**Hoiko.** Hoiko used preset `we`, beam 150, depth 14 and a 2-piece preview, with
adaptation off. Both sides got the same pieces and locked one piece per 120 ms. Seeds
1001–1200 were never used for tuning. Swapped seats replayed the same game, so each seed
counts once.

**intetrigence.** Derived from MinusKelvin's Cold Clear 2. In its own published 100-game eval at 100 ms / 5 PPS, intetrigence beat
the official Cold Clear 2 77–23. Here it ran at that same profile, on its own referee
(`--rules guideline`), with Attax connected over TBP. The 50 seeds (5001–5050) were new to
both projects, and each was played from both seats. Attax won both games on all 50 seeds.
Median think time per move: Attax 35 ms, intetrigence 151 ms.

**clys.** citrus610's Monte Carlo beam search bot ran its default configuration
(width 500, depth 32, branch 3, one thread). Seeds 7001–7050 were played from both
seats; Attax won 46/42 by seat, with no draws. clys generated more attack per piece;
Attax won on survival, clearing 7,948 lines to clys's 6,267. The external-bot referee
uses the guideline attack table without combo or perfect-clear attack, 5 previews,
hold and 5 PPS paired turns. clys gets a 100 ms search window; Attax completes fixed
work without a deadline. Lanes use dedicated CPU cores, with one bot thinking at a
time per lane. Neither bot sees pending garbage over TBP. All recorded games were
replay-verified.

## Block D: additions to the existing Fairness notes (append after the current Hoiko bullets)

- **intetrigence settings audit.** The audit was done before the result was trusted, and
  it found the harness fair. Attax's search ran to completion on all 14,230 moves.
  intetrigence used more than its 100 ms target. The two never competed for CPU, and every
  move was checked by intetrigence's own referee. `verify-replay` re-ran all 100 games.
- **Against Attax.** TBP carries no garbage information, so Attax played without seeing
  incoming garbage. intetrigence could see it.

## Block E: "Not measured" (new short block, after Fairness notes)

### Not measured

- Direct games against the real Hoiko.exe. The benchmark machine has no Wine. The replica
  matched the .exe on 500/500 moves (seed 1) and 200/200 each (seeds 2 and 7).
- Hoiko with its wall-clock adaptation on.
- Official Cold Clear 2 itself. That comparison goes through intetrigence, which beat it.
- intetrigence at budgets other than 100 ms / 5 PPS, and rules with combo or perfect-clear
  attack.
- clys outside its default configuration, 100 ms window and this rules profile.
  Its evaluator values combo/perfect clears that the referee does not score. This is
  not an equal-compute ranking. Attax sees only 20 rows and ignores bag state; clys sees
  40 rows and can use bag state. The game-level Wilson interval is descriptive:
  independent units are 50 seed pairs. Stochastic search and time slicing can change
  fresh scores. No game reached the 1,000-turn cap. Realtime inputs and network latency
  were not measured.

---

