# Copy for https://s0u7a.f5.si/attax/

The live page is `lang="en"` and its strings are English (`src/brand.ts`, `index.html`), so
the blocks below are English. A Japanese version of each block is at the end, in case the
site wants one.

Every number comes from `~/workspace/tetris-speed/REPORT.md` (Hoiko) or
`~/workspace/attax-gauntlet/REPORT.md` (clys section).

The intetrigence matchup originally approved in these blocks has been withdrawn (the owner
judged intetrigence not a valid benchmark opponent), and its copy is removed below.

On 2026-11-15 the page was reframed around the Cold Clear 2 measurements: the official
upstream Cold Clear 2 (79–21 over 100 games) is the headline, chouhy's fork (27–13 over
40) runs alongside, and Hoiko and clys remain as listed results. Blocks A–E below are
the current copy; the hero lede in Block B is new in this revision.

---

## Block A: tagline (replaces `BRAND.tagline` in `src/brand.ts` and the meta description in `index.html`)

> A versus AI for the falling-block game. It won 79 of 100 games against the official Cold Clear 2 and 27 of 40 against a Cold Clear 2 fork.

## Block B: hero (headline, lede and the line under the stat tiles)

Headline: "Attax beats the official Cold Clear 2 in 79 of 100 games."

Lede:

> Same pieces, both seats, guideline versus rules over the Tetris Bot Protocol. Cold Clear 2 had a 100 ms window per move at 5 PPS paired turns; Attax played its field-40 profile with exact bag speculation. Cold Clear 2 generated more attack per piece (0.9279 to 0.8951); Attax won on survival. Win rate 79.0% (95% interval 70.0%–85.8%) on seeds 13001–13050 — fresh seeds, never used for tuning.

Line under the stat tiles:

> Measured head-to-head in guideline versus rules against the official Cold Clear 2, a Cold Clear 2 fork, Hoiko and clys.

## Block C: new results section (goes directly after the stat tiles, before the live arena)

### Results

| Opponent | Games | W–L | Win rate (95% Wilson CI) | Attack / piece (Attax vs opponent) |
|---|---|---|---|---|
| Cold Clear 2 (official upstream, by MinusKelvin) | 100 | 79–21 | 79.0% (70.0–85.8%) | 0.8951 vs 0.9279 |
| Cold Clear 2 fork (by chouhy) | 40 | 27–13 | 67.5% (52.0–79.9%) | 0.9218 vs 0.8298 |
| Hoiko (Rust/WASM replica of Hoiko.exe) | 200 | 195–5 | 97.5% (94.3–98.9%) | 0.70 vs 0.46 |
| Hoiko, Attax limited to Hoiko's 2-piece preview | 100 | 89–11 | 89.0% (81.4–93.7%) | 0.58 vs 0.46 |
| clys (by citrus610) | 100 | 88–12 | 88.0% (80.2%–93.0%) | 0.7346 vs 0.7791 |

**Cold Clear 2.** The official upstream engine by MinusKelvin (commit ed8b193) played
over the Tetris Bot Protocol under guideline rules, with a 100 ms window per move and
5 PPS paired turns; the engine process is suspended while Attax searches, so both sides
get the same wall-clock window. Attax played its field-40 profile with exact bag
speculation. Seeds 13001–13050 were played from both seats; Attax won 44/35 by seat,
with no draws. Cold Clear 2 generated more attack per piece (0.9279 to 0.8951); Attax
won on survival, clearing 7,600 lines to Cold Clear 2's 6,528. All recorded games were
replay-verified.

**Cold Clear 2 fork.** chouhy's fork of Cold Clear 2, measured the same way on seeds
2701–2720, played from both seats; Attax won 12/15 by seat, with no draws. Attax
generated more attack per piece (0.9218 to 0.8298). The fork cleared more lines
(11,512 to 10,639); Attax won more games. All recorded games were replay-verified.

**Hoiko.** Hoiko used preset `we`, beam 150, depth 14 and a 2-piece preview, with
adaptation off. Both sides got the same pieces and locked one piece per 120 ms. Seeds
1001–1200 were never used for tuning. Swapped seats replayed the same game, so each seed
counts once.

**clys.** citrus610's Monte Carlo beam search bot ran its default configuration
(width 500, depth 32, branch 3, one thread). Seeds 7001–7050 were played from both
seats; Attax won 46/42 by seat, with no draws. clys generated more attack per piece;
Attax won on survival, clearing 7,948 lines to clys's 6,267. The external-bot referee
uses the guideline attack table without combo or perfect-clear attack, 5 previews,
hold and 5 PPS paired turns. clys gets a 100 ms search window; Attax completes fixed
work without a deadline. Lanes use dedicated CPU cores, with one bot thinking at a
time per lane. Neither bot sees pending garbage over TBP. All recorded games were
replay-verified.

## Block E: "Not measured" (new short block, after Fairness notes)

### Not measured

- Direct games against the real Hoiko.exe. The benchmark machine has no Wine. The replica
  matched the .exe on 500/500 moves (seed 1) and 200/200 each (seeds 2 and 7).
- Hoiko with its wall-clock adaptation on.
- Cold Clear 2 and its fork outside the 100 ms window, 5 PPS pace and this rules
  profile. The game-level Wilson interval is descriptive: independent units are the
  seed pairs. Realtime inputs and network latency were not measured.
- clys outside its default configuration, 100 ms window and this rules profile.
  Its evaluator values combo/perfect clears that the referee does not score. This is
  not an equal-compute ranking. Attax sees only 20 rows and ignores bag state; clys sees
  40 rows and can use bag state. The game-level Wilson interval is descriptive:
  independent units are 50 seed pairs. Stochastic search and time slicing can change
  fresh scores. No game reached the 1,000-turn cap. Realtime inputs and network latency
  were not measured.

---

