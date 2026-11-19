# Stage 2: attax / Sold Slear lab integration

Implemented an in-process headless **placement** harness under `tools/s2-lab/`.
The full mechanics smoke finishes by the lab's top-out rule with no protocol or
fingerprint errors. This is integration evidence, not a strength measurement or
an assertion of complete official S2 fidelity. No weights were tuned; no
`src/`, Rust, lab source, or stage-1 rules were changed.

Authoritative inputs read: `../attax-s2/LAB-RECON.md`,
`../attax-s2/S2-SPEC.md`, `S2-STAGE1-REPORT.md`, and repo `AGENTS.md`.
Lab source revision: `79505ca93bd15f7bcbd58724cb2a6ba312e09434` (also verified
with `git rev-parse HEAD`). The setup job completed the champion artifact and
dependencies before these smokes. `git -C ../s2-bot-lab-ref status --short`
remains empty.

## Run a match set

From `/home/hatch/workspace/attax-s2-impl`:

```sh
bun tools/s2-lab/run-match.mjs --games N --seed S --out /absolute/path/results.jsonl
```

Replace N and S with integers. This Bun entry imports the TypeScript player;
plain Node without a TS build/loader is not the supported invocation. Defaults:
1 game, seed 42, 1000 total locks maximum. Output is appended, not truncated;
the output path is opened before expensive work to check writability. Its parent
must exist. `S2_LAB_ROOT` selects another lab checkout; `CC2_F14_WASM` selects
another champion artifact. The lab must have its dependencies and champion
WASM built. No server, browser, native champion executable, or lab patch is
required.

Attax starts left in game zero, right in game one, and continues alternating.
Game seeds are S+i; both players start with the same seeded legacy queue.
A set with odd N has one additional left game. Side IDs and contestant names
are explicit in every JSONL record. Only the orchestrator should run long sets.

## Harness and authority

- `lab.mjs` loads the lab's own modules from the configured checkout.
- `champion-driver.mjs` creates
  `createChampionProfile(defaultBotParameters('cc2-s2-champion'))`, then a
  `createCc2WasmWorkerSession` for each champion seat in each game. Every decision
  uses `createChampionRequest`, worker `decideF14`, and
  `resolveChampionDecision`, including the lab's response, GUI-state, selected
  identity and rotation-witness checks. Sessions persist through a game for tree
  reuse, and close in `finally`; they never carry a tree between games.
- `run-match.mjs` initializes using the lab's `createGame` / `toS2GuiState` /
  `guiStateToCanonical`, then uses `createBotMatch`, `botMatchNextStep`, and
  `advanceBotMatch`. Queue extension is the server's `extendSeededQueue` to 28
  retained pieces, tracked separately per player, outside the decision boundary.
- Attax's placement is applied with the lab's `applyTransition`. Every submission
  carries `comparison.positionFingerprint = fullStateKey(sourceState)`.
  `advanceBotMatch` rejects stale/illegal submissions; errors never score wins.
- The referee's post-lock board, exact chain, queue, hold, incoming packets and
  receipts replace the state before every next decision. Attax is stateless
  between searches: it never advances or trusts a predicted private board.
  Actual lock/attack/cancel/tank receipts are retained by the controller and
  final public summaries are recorded. Their effects feed the next public board,
  chain and incoming projection; raw tank receipts (which contain holes) are not
  passed to the search. Cumulative attack comes from referee stats, never the
  search's predicted attack. No bot requires access to opponent state.

The existing `src/ai/bot/search.ts` hardcodes guideline awards and a boolean
B2B state, and has no scoring injection point. `tools/s2-lab/search.ts` is its
local S2 specialization, preserving the same beam algorithm and default weights
while calling the stage-1 `awardLock('tetrio-s2', ...)` and `classifyS2Spin`.
It directly reuses production move generation, board features and piece geometry.
This avoids a production search/controller refactor or changing headline-policy
code. Its differences are numeric B2B, S2 awards/classification, amount-only
root tank timing, and independent root validation. Keep this copy reconciled
with future production search changes; it is not a separately tuned policy.

## State conversion contract

| Field | Conversion and reason |
| --- | --- |
| Board | Canonical lab cell row 0 is bottom. Search row 0 is top. Row y maps to 39-y; x is unchanged. All 400 cells, including the buffer, are retained. Every nonempty piece/garbage cell becomes its occupancy bit. Search features do not require colors; referee retains garbage identity for its special bonus. |
| Current / spawn | Current piece name is unchanged. Search uses its existing 40-row spawn origin (x=3, y=19, rotation 0) and its existing retry. This is a planning origin, not a claim of engine-frame Clutch fidelity. |
| Queue | Explicitly truncate canonical `known` to 13 NEXT before projecting the lab's public decision state: 14 including current, matching default champion search queue. `championVisibleState(...,14)` alone does NOT truncate the canonical tail; its downstream request builder truncates `start.queue`. Attax's projection also rejects a longer queue. No queue seed, generator tail, bag RNG or hidden future piece crosses its decision boundary. Speculation/bag inference is disabled. |
| Hold | Piece name and `holdAvailable` map directly to `hold` / `canHold`. Existing search handles full-hold swap or consuming the first NEXT into an empty hold. The referee advances the actual queue/hold after the lock. |
| B2B | Preserve the exact canonical difficult-clear chain d as a number, unchanged, throughout the S2 search. Stage-1 awards use precisely this one-based difficult-chain convention (displayed x=d-1). No boolean collapse or invented charge cap. |
| Combo | Canonical 0 inactive becomes search -1; canonical 1 first clear becomes search 0; generally subtract exactly one. The S2 award receives the displayed post-clear combo. Stage-1 native snapshot's zero-inactive convention is bypassed: this entry calls its award function directly. |
| Incoming | Use lab `createS2AmountOnlyDecisionState`, which delegates to its amount-only incoming snapshot. Only total pendingRows and dueThisLockRows pass through. Search `pending` gets pendingRows; `dueThisLock` gets dueThisLockRows. At the root, a blank lock estimates lift bounded by due rows; clear locks do not tank (combo blocking). It does not construct future hole boards or guess later packet arrivals. Cancellation, opener bonuses and all actual tank rows remain authoritative lab operations. |
| Time / piece count | Public lockTime is generated by the lab; search has no wall-time-dependent budget or margin model. The referee uses its actual logicalFrame / piecesPlaced for attack, opener and dynamic garbage calculations. |
| Placement | Convert the core's four absolute cells to bottom-origin cells. Match the cell set against the lab's runtime `placementGeometry`, including piece and usedHold. This derives all origin/rotation offsets rather than assuming matching anchors. |
| Rotation evidence | Independently run lab `generateReachablePlacements` with the referee's SRS+ kick table and attax's quarter-turn-only moves. Before ranking, reject any root without a matching cell/hold/last-rotation witness. Submit the generator's complete kickId/index/offset evidence, never attax's spin label. Lab `applyTransition` judges the actual spin. This is a placement kickset witness, not an INPUT/frame schedule. |

The public decision object contains only the lab's allowlisted board, pieces,
chain, public lock time and amount-only incoming. The closure used for root
validation depends only on this visible board/piece prefix and static geometry.
It does not inspect a future generated queue or packet hole.

## Timing and fairness settings

Champion defaults are untouched: 2048 selections, queue 14 including current,
tree reuse on with floor 256, THINK TIME off, MULTITHREAD off, RG off. The
complete profile and parameter object, profile SHA-256 and WASM SHA-256 are
included in each record, since profile ID alone does not identify the generation.

Profile SHA-256:
`b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c`.
WASM SHA-256:
`facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731`.

Both seats use `ppsForCc2Parameters(defaults)`, which is **1 PPS** here because
PPS is enabled by default. The 2.5 PPS selection-derived fallback applies only
with PPS disabled; it is not used. Mode is `paced`, 60 logical frames per lock,
zero controller delivery delay, one-cell garbage holes, no handicap. Equal-rate
seats lock simultaneously from the same pre-event snapshot. Both decisions
finish before the offline controller advances; wall latency does not grant more
simulated locks. The champion gets no wall-time truncation. This is not the GUI
`fairComparison` preset (which would change budgets), or realtime INPUT, or
attax's shipping 120-ms versus controller.

The lab's legacy-LCG queue model and placement top-out are preserved. The
runner uses lab `matchOutcome` with the GUI's occupied-buffer predicate (any
nonempty canonical row >=20), also honoring explicit tank top-out receipts.
Both top out in one event => finished draw. The cap is total locks, does not
split simultaneous events, and yields unfinished with no winner. A no-move,
worker failure, illegal transition or fingerprint rejection is a harness error
with no winner and nonzero exit, not an opponent win.

## Smoke results

Committed raw JSONL under `tools/s2-lab/evidence/`; no page/headline evidence was
modified. These are short integration checks only.

| Smoke | Seed / attax seat | Result | Locks left/right | Attack left/right | Logical frames | Wall ms |
| --- | --- | --- | --- | --- | --- | --- |
| Champion vs champion via lab's own factories, WASM verifier and match controller | 42 / none | finished, simultaneous top-out draw | 300 / 300 | 414 / 414 | 18000 | 128683.099 |
| Attax vs champion, full mechanics game | 42 / left | finished, champion/right wins, attax occupied buffer | 90 / 90 | 66 / 89 | 5400 | 54020.704 |
| Cap / seating check | 43 / left | unfinished, null winner | 1 / 1 | 0 / 0 | 60 | 892.146 |
| Cap / seating check | 44 / right | unfinished, null winner | 1 / 1 | 0 / 0 | 60 | 555.075 |

All successful records have `error: null`, `protocolErrors: 0`; the controller
accepted every fingerprint. The full attax smoke rejected 33 candidate roots
before ranking because they lacked the requested lab witness; none became an
illegal submission. Some wall times include concurrent verification work and
are not latency/strength benchmarks.

Commands used:

```sh
bun tools/s2-lab/run-match.mjs --games 1 --seed 42 --champion-vs-champion --out /tmp/s2-champion-smoke.jsonl
bun tools/s2-lab/run-match.mjs --games 1 --seed 42 --out /tmp/s2-attax-final-smoke.jsonl
bun tools/s2-lab/run-match.mjs --games 2 --seed 43 --max-locks 2 --out tools/s2-lab/evidence/cap-smoke.jsonl
```

Before the root filter, two development attempts stopped at 65 locks per side
with a witness mismatch. Investigation found an L tuck whose only lab witness
ended with rotation, while production movegen intentionally discards non-T
rotation evidence (`lastSrs=0`). The final root filter excludes such candidates
instead of fabricating a nonrotation witness or changing production movegen.
This under-generates some legitimate non-T rotations; broader all-spin policy
coverage is future work, not a claim of completed strength engineering.

An additional HTTP check was attempted but could not start: the sandbox denies
`listen` on 127.0.0.1:4177 with EPERM (and denies local `connect`). The completed
champion-vs-champion smoke instead used the documented in-process lab path,
including the same profile/request/session/resolver and referee factories as
the server. No HTTP smoke is claimed.

## Gates and remaining fidelity blockers

- `bun x tsc --noEmit`: passed (`bunx` shell executable is absent; `bun x` is its
  available equivalent).
- `bun test`: final full-suite run passed, 128 tests / 0 failures, including
  unchanged `tests/bot-movegen.test.ts` and all six new contract tests.
  `bun test tools/s2-lab/contracts.test.ts` also passed independently.
- `bun run lint`: passed; final harness formatting/check also passed.
- `bun run build`: passed; rebuilt dist is byte-identical (no tracked diff).
- `cargo test --manifest-path rust/Cargo.toml`: passed (including 60 Hoiko core,
  6 search and the recorded TS agreement test).
- Additional strict TypeScript check of the new player and S2 search passed:
  `bun x tsc --noEmit --incremental false --strict --target ESNext --module ESNext --moduleResolution bundler --skipLibCheck tools/s2-lab/search.ts tools/s2-lab/attax-player.ts`.

No production bot/core/versus changes, so the house rule requiring a fresh
Hoiko benchmark for those changes was not triggered. Existing reachability
tests were not weakened. There was no tuning, held-out headline run or long
match set.

All seven stage-1 TODOs remain unresolved for **official** fidelity. None were
assigned invented values:

1. Unpinned #2: official integer surge partition. Search uses stage-1 total
   award; the lab referee performs its own observed chunk staging.
2. #3: official holes/RNG, confirmation/travel and surge delay. Decisions are
   amount-only; the lab alone owns packets and holes. Placement controller
   delivery remains its declared zero-frame delay, not INPUT's 20-frame model.
3. #4: official margin/rounding/opener stage boundaries. Search awards are
   stage-1 multiplier-1 estimates. Actual awards/cancellation come from lab
   receipts. Garbage special bonus, opener and later margin effects are not
   silently added to stage-1 core.
4. #5: rotation/hard-drop/failed-input/180 evidence semantics. Only independent
   lab placement witnesses are submitted, with 180 off for attax. No official
   INPUT equivalence is claimed; T fifth-kick edge cases remain provisional.
5. #6: hidden/hold spawn, Clutch, ARE, blockout ordering. Existing search spawn
   and placement-kickset witnesses are retained. This harness does not certify
   real frame reachability or change the lab's legacy top-out rule.
6. #7: official intake/margin constants and numeric storage limits. Actual lab
   constants remain in the lab. Search receives due rows rather than hardcoding
   a guessed official cap; no B2B/surge charge cap was introduced.
7. #8: exotic spin Quads/higher clears. Stage-1 awards still throw. Such a search
   failure records a harness error and cannot produce a win. No damage-10 row
   or legal-witness claim was invented.

These do not block the placement mechanics smoke, but do block calling this a
complete official S2 engine, INPUT qualification or official strength result.

## Git handoff limitation

The initial `git switch -c s2-stage2` failed: the managed sandbox makes this
worktree's shared metadata at `/home/hatch/workspace/attax-tbp-pack/.git`
read-only, and even its `.git` pointer is protected. Approval is unavailable.
No shared metadata was modified. Work continued using a copied object/ref/index
store at `/tmp/attax-s2-stage2-git`, with its worktree set to this directory.
There `s2-stage2` was created/switched **before code edits**, followed immediately
by WIP checkpoint `4d60ec0` (empty checkpoint). All commits use
`souta-lab <109493063+souta-lab@users.noreply.github.com>`.

The final code/report/evidence commit is on that private `s2-stage2` branch.
The original worktree's shared HEAD necessarily still names `s2-profile` until
an unrestricted orchestrator imports it. No push was made. A self-contained
Git bundle is supplied at `/tmp/attax-s2-stage2.bundle` so the result survives
without relying on an uncommitted patch.

Outside this sandbox, import and attach the already-populated worktree without
rewriting its working files (the initial worktree was clean):

```sh
git -C /home/hatch/workspace/attax-s2-impl fetch /tmp/attax-s2-stage2.bundle s2-stage2:s2-stage2
git -C /home/hatch/workspace/attax-s2-impl symbolic-ref HEAD refs/heads/s2-stage2
git -C /home/hatch/workspace/attax-s2-impl reset --mixed HEAD
```

This attachment step is an environment blocker, not completed shared-repository
branch creation. For inspection now, use
`git --git-dir=/tmp/attax-s2-stage2-git log` / `status`.
