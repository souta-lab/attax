# Phase 3 assessment — Hoiko opener subsystem (`TemplateAI` / `OpSearch`)

Date: 2026-09-13. Binary: `Hoiko.exe` (`Hoiko_PPT_v0-beta1`), Wine + .NET 4.8 oracle
(`tools/hoiko-oracle/ScpDriverStub.cs`). Sources of truth:
`monodis` IL dump `/home/s0u7a/.local/share/hoiko-re/hoiko.il` (88,175 lines) and the
regenerated ILSpy decompile `/home/s0u7a/.local/share/hoiko-re/Hoiko.all.cs` (28,392 lines).

## 1. Verdict

**The whole opener subsystem is present as IL and is reconstructible.** Every method called by
`SearchAI.OpSearch` has an IL body (no native-only black boxes): `TemplateAI.ReadConfig/OpEvaluate/
OpEvaluateFirst/SearchTDOpeners` + its 20 `<lambda_*>` pattern matchers, `TDOpenersCmp`,
`OriginNextCmp`, `DecisionTemplate`, `DecisionLoopTemplate`, `UseTemplate/UseTDOpeners/InTemplate/
BreakTemplate/FailTemplate(bool)/BreakCheck`, `OpDropCount{,Plus,Save,Load}`,
`ExpandAI.OpExpandNode/OpExpandDeriveNode/OpTryDeriveMoveL/MoveR`, `SearchAI.OpSearch`.

**One oracle caveat.** The shipping binary's `OpSearch` path corrupts its own fixed-size child
table when the hold pass runs (mandatory for TD openers), so the *unpatched* exe crashes
nondeterministically under Wine (NRE, ~50% of fresh processes). Re-pointing the table at a larger
zeroed allocation in the stub makes the path fully deterministic (`ecbig=1`, 5/5 identical results).
Exe-vs-replica verification of the opener path is therefore only meaningful against the
capacity-patched exe (the port's unbounded child table is the non-corrupting semantics).

## 2. ExpandTemplateNode gating contradiction — RESOLVED

SPEC_ExpandAI §0 (body) is right; the SPEC header claim ("inert because `useTDOpeners=false`")
is wrong. Evidence:

- `ExpandAI.ExpandNode` (Hoiko.all.cs:14238) and `ExpandAI.OpExpandNode` (14983, 15001) both do
  `!GamePack.IsSafe(parentGame) ? ExpandBaseNode(...) : ExpandTemplateNode(...)` — **no config
  check**.
- `ExpandAI.ExpandTemplateNode` (14872) reads only the three const tables.
- `TemplateAI.ReadConfig` (16524) sets `useTemplate = ConfigAI.UseTDOpeners()`, and `useTemplate`
  only gates `SearchAI.Search` → `SearchAI.OpSearch` (15639). `ExpandNode` is unaffected.
- The Rust port already dispatches on `IsSafe` (`rust/hoiko-core/src/expand.rs:230,238`) and the
  default-config full-game differential matches 500/500, confirming the unconditional template
  expansion is the real behavior.
- Empirical confirmation: `ExpandAI.ExpandNode` on the same board with `viewnext=5` and
  `usetdopeners=0` vs `usetdopeners=1` produces **identical** child dumps (70/70 lines,
  `gating-tdopeners-off.txt` / `gating-tdopeners-on.txt`, harness `expand=1`).

Gate for the opener path: `ConfigAI.UseTDOpeners()` = `viewNext>=5 && useHold && useTDOpeners`
(SPEC_Search §2.1). With the shipping `viewNext=2` it is always false; enabling it requires
`viewNext>=5`, and `useHold=true` is mandatory.

## 3. OpSearch crash evidence (the blocker)

All runs: fresh `wine Hoiko.exe` process, empty board, `next=[Z,S,T,O,J,L,I]*4`,
`viewnext=5, usetdopeners=1`, one `SearchAI.Search`.

| run | hold state | result |
|---|---|---|
| Z-first ×3 | default (`useHold=true`, hold empty) | FAIL, OK, FAIL |
| T-first ×2 | default | FAIL, OK |
| O-first | default | OK |
| Z-first, ASLR off ×2 | default | OK, FAIL |
| Z-first ×3 | `usehold=0` | OK ×3, identical move `x=5 y=2 rot=1 m=6` |
| Z-first ×3 | `hold=4` | FAIL ×3 |
| Z-first ×5 | `ecbig=1` (child table → 256 zeroed buckets) | OK ×5, identical `x=4 y=1 rot=0 m=6`, depth 6 |

Crash stack (raw logs in this directory):
`ExpandAI.ExpandedChild.AddChild` / `ExpandAI.DeleteSameNode [0x65]` ← `ExpandAI.RegistChildNode`
← `ExpandAI.OpExpandNode` ← `SearchAI.OpSearch [0x387]`. The failure occurs in the **hold pass**
(pass 1 completes: bucket counts 8/11/3/3/6/4 = 35 children, then the second pass NREs).

`ExpandAI.Init` allocates `expandedChild = new(6720)` = 40 buckets × 168 B; each bucket is
`{int count; pad; Node* ptr[20]}`, indexed by `lockedBottom*2 + (r&1)`, and `AddChild` has **no
bounds check**. The hold pass overruns it; the symptom depends on heap layout (hence the
nondeterminism). `ecbig` proves the overflow hypothesis: capacity patched → deterministic.

## 4. What is known

- Full control flow, constants and state fields: `opType 1..12`, `opBool 0..5`,
  `opDropCount/prevOpDropCount/failTDOpeners/useDPC/loopTemplate`, phase buckets in `OpSearch`
  (depthLimit 6/…/14, beamSizeLimit 1500/50/500) — Hoiko.all.cs 15920–16225, 16524–20518.
- `SearchTDOpeners` dispatcher + all 20 board/queue pattern lambdas: 16574–20192.
- `TDOpenersCmp` (opening pattern table on board rows 0–3 + hold/next): 20193–20290.
- `OpExpandNode`/`OpExpandDeriveNode`/`OpTryDerive*` (the op-variant derive without the T
  shortcut, plus soft-drop retries): 14952–15336; IL 14952–15336.
- `loopTemplate` handling (`DecisionLoopTemplate`, `BreakCheck` re-arm, `NextMino.IsOriginNext`
  = `bagRemains==5/6`): 20301–20498, 6662–6669.
- Oracle controls already exist: `viewnext=`, `usetdopeners=` (sets ConfigAI + TemplateAI flags
  and re-runs `TemplateAI.ReadConfig`), `looptemplate=`, `optype=`, `opdropcount=`, `opexpand=`
  stepwise probe, `ecbig=1`. Stub constants for every TemplateAI/ExpandAI static are in
  `ScpDriverStub.cs`.

## 5. What is unknown / needs measuring

- Whether the child-table overflow also corrupts the shipping Windows build (same IL, different
  allocator; unverifiable here). The port must model the intended unbounded table.
- `loopTemplate=true` needs multi-search state (`opDropCount` survives within one process). The
  per-move fullgame harness starts a fresh process each move, so an in-process multi-search probe
  is required to verify the loop-template re-arm path.
- Scoring equivalence of `SearchTDOpeners` must be verified phase-by-phase on synthetic GamePacks
  (direct reflection calls), because the full search cannot reach all phases reliably.
- `OpSearch`'s timer-driven depth break is wall-clock dependent; reference runs must use the
  fresh-process/no-timer regime (as the existing `diff.ts` does), or the timer explicitly started
  with a deterministic limit.

## 6. Proposed verification design (per the above)

1. Per-function differential: extend the stub with a `tmpl=` mode that loads synthetic GamePack
   states and calls `TDOpenersCmp`, `OriginNextCmp`, `DecisionTemplate`, `DecisionLoopTemplate`,
   `SearchTDOpeners`, `OpEvaluateFirst` directly; compare with the Rust functions on the same
   states (covers all 20 lambdas across phases 1–14).
2. End-to-end differential: `Search` with `viewnext=5 usetdopeners=1 ecbig=1` on a corpus;
   compare first move/depth/beam against the Rust `OpSearch`.
3. Multi-search sequence probe (`seq=1`) in one process for `loopTemplate=true`, replaying the
   chosen move between searches.

Raw probe logs in this directory: `probe-opexpand-stepwise.log`, `probe-crash-deletesame.log`,
`probe-nohold-ok.log`, `probe-ecbig-run1.log`.

## 7. Implementation results (this session)

Ported and **exe-verified** (25/25, `report.json` + per-case `*-exe.log` / `*-replica.txt`):

| piece | Rust | verification |
|---|---|---|
| `TemplateAi` state machine: `ReadConfig`, `UseTemplate`, `InTemplate`, `BreakTemplate`, `FailTemplate(bool)`, `BreakCheck`, `OpDropCount*` | `rust/hoiko-core/src/template_ai.rs` | unit tests + `DecisionTemplate`/`DecisionLoopTemplate` corpus |
| `TDOpenersCmp` (all 12 patterns) | same | 12/12 pattern states |
| `OriginNextCmp` | same | origin-all / origin-missing |
| `DecisionTemplate` (phases 0–30, useTDOpeners gate) | same | phase-0…phase-30 + td-off |
| `DecisionLoopTemplate` (loop re-arm, `btb` reset) | same | 3 loop cases incl. `loopTemplate=false` |

Harness: `tools/hoiko-oracle/diff/tdopeners.ts` → `bun tdopeners.ts` (exe `tmpl=1` probe vs
`rust/target/release/examples/tmpl_dump`). Stub probe order: `TDOpenersCmp` → `OriginNextCmp` →
`DecisionTemplate` → `DecisionLoopTemplate`.

Not ported yet (see §6, in dependency order):

1. `TemplateAI.SearchTDOpeners` (Hoiko.all.cs 16574–16839) + its 20 lambdas (16841–20192);
   `OpType`/`OpBool` are anonymous native enums, values recovered from usage.
2. `ExpandAI.OpExpandNode` / `OpExpandDeriveNode` / `OpTryDeriveMoveL/R` (14952–15336) and
   `SearchAI.OpSearch` (15920–16225).
3. FFI layout + adapter options + app wiring (`viewNext>=5`, `useTDOpeners`, `loopTemplate`),
   wasm rebuild; full-search differential (`ecbig=1` on the exe).

Gate status after this session: `cargo test` green (58 tests incl. 5 new), `tsc`, `bun test`
(119), `bun run build` green. `bun run lint` was already red at HEAD (4 findings in the
untouched `tools/hoiko-oracle/diff/config.ts`: format + 2 unused vars + regex literal); the new
`tdopeners.ts` is biome-clean. Default config behavior is untouched (the new Rust module is not
referenced by search/FFI; `TemplateAi` is opt-in scaffolding only).

