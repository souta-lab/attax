import { createHash } from "node:crypto";
import { appendFile, open, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createChampionDriver } from "./champion-driver.mjs";
import {
  createDefaultGpuDecider,
  createDefaultPersistentGpuDecider,
  createGpuAttaxDecider,
  createPersistentGpuAttaxDecider,
  gpuEngineInfo,
  gpuEngineTimingSummary,
  gpuPersistentEngineInfo,
} from "./gpu-player.js";
import {
  applyTransition,
  controller,
  createS2AmountOnlyDecisionState,
  fullStateKey,
  lab,
  labRoot,
  parameters,
  profile,
  resolvePlacementRules,
} from "./lab.mjs";
import { cellKey, placementCells, wrapGpuDecider } from "./lab-decision.js";

const { createGame, extendSeededQueue, toS2GuiState } = await lab("cc2-gui/game.mjs");
const { guiStateToCanonical } = await lab("src-js/gui-state.mjs");
const { placementGeometry } = await lab("src-js/triangle/placement-geometry.mjs");
const { generateReachablePlacements } = await lab("src-js/triangle/move-generation.mjs");
const { matchOutcome, ppsForCc2Parameters } = await lab("src-js/bot-match-options.mjs");
const { canonicalize } = await lab("src-js/cs1-core.mjs");
const { values } = parseArgs({
  options: {
    "opponent-profile": { type: "string" },
    "opponent-id": { type: "string" },
    "debug-log": { type: "string" },
    games: { type: "string", default: "1" },
    seed: { type: "string", default: "42" },
    "seat-offset": { type: "string", default: "0" },
    out: { type: "string" },
    "max-locks": { type: "string", default: "1000" },
    concurrency: { type: "string", default: "1" },
    "champion-vs-champion": { type: "boolean", default: false },
  },
});
function integer(value, name, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (name === "seed" ? 0 : 1) || n > max) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return n;
}
const games = integer(values.games, "games", 10000);
const seed = integer(values.seed, "seed", 0xffffffff);
const maxLocks = integer(values["max-locks"], "max-locks", 100000);
if (seed + games - 1 > 0xffffffff) throw new Error("seed range overflows uint32");
if (!values.out) throw new Error("--out <file.jsonl> is required (records are appended)");
await (await open(values.out, "a")).close();
if (!!values["opponent-profile"] !== !!values["opponent-id"])
  throw new Error("opponent profile and id must be supplied together");
if (values["champion-vs-champion"] && values["opponent-profile"])
  throw new Error("opponent profile conflicts with champion-vs-champion");
// Plan carry-over (item 100) needs SearchResult.lineStates, which the GPU
// engine's wire format does not carry. Since the TS engine's removal
// (Phase C, 2026-11-19) no path can produce it, so the request is refused
// loudly instead of being silently dropped.
const carryEnv = process.env.ATTAX_S2_PLAN_CARRYOVER;
if (carryEnv !== undefined && carryEnv !== "0" && carryEnv !== "1")
  throw new Error(`expected "0" or "1" in ATTAX_S2_PLAN_CARRYOVER, got ${carryEnv}`);
if (carryEnv === "1")
  throw new Error(
    "ATTAX_S2_PLAN_CARRYOVER=1 is unavailable: plan carry-over needs lineStates, " +
      "which the GPU engine's wire format does not carry (GPU front-end pending)",
  );
const planCarryover = false;
// GPU engine form selection (latency floor audit 2026-11-24, P1):
// "basic" (vkrunner_s26 serve) is the default and remains the form the
// canonical numbers and gates run on; "persistent" (pfserve, the r15
// serve engine) is opt-in per run and is named in the match record's
// attaxEngine.form. The persistent form's verification contract is
// selection agreement with the basic form — records from the two forms
// are not interchangeable evidence.
const engineForm = process.env.ATTAX_LAB_ENGINE ?? "basic";
if (engineForm !== "basic" && engineForm !== "persistent") {
  throw new Error(`expected "basic" or "persistent" in ATTAX_LAB_ENGINE, got "${engineForm}"`);
}
const persistent = engineForm === "persistent";
// GPU engine startup probe: verifies the pinned assets and the device
// before the first game. There is no fallback — a machine without a usable
// Vulkan device stops here (Souta's ruling, 2026-11-19).
const engineInfo = persistent ? await gpuPersistentEngineInfo() : await gpuEngineInfo();
const opponent = values["opponent-profile"]
  ? wrapGpuDecider(
      persistent
        ? await createPersistentGpuAttaxDecider(values["opponent-profile"])
        : await createGpuAttaxDecider(values["opponent-profile"]),
    )
  : null;
const attax = wrapGpuDecider(
  persistent ? await createDefaultPersistentGpuDecider() : await createDefaultGpuDecider(),
);
const pps = ppsForCc2Parameters(parameters);
const digest = createHash("sha256").update(canonicalize(profile)).digest("hex");
const wasmPath =
  process.env.CC2_F14_WASM ??
  `${labRoot}/bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm`;
const wasmSha256 = createHash("sha256")
  .update(await readFile(wasmPath))
  .digest("hex");

async function play(gameIndex) {
  const started = performance.now();
  const gameSeed = seed + gameIndex;
  // Seat offset 1 swaps the parity, so a seed block can be played in both
  // seats (the registered pairing the campaign-2 probe lacked).
  const seatOffset = values["seat-offset"] === "1" ? 1 : 0;
  const attaxSide = values["champion-vs-champion"]
    ? null
    : (gameIndex + seatOffset) % 2 === 0
      ? "left"
      : "right";
  const scenario = createGame(gameSeed);
  const initial = guiStateToCanonical(toS2GuiState(scenario));
  const rules = resolvePlacementRules(initial.rulesetId);
  const geometry = placementGeometry(rules);
  let match = controller.createBotMatch({
    bots: ["left", "right"].map((id, i) => ({ id, gameId: i + 1, state: initial })),
    mode: "paced",
    ppsByBotId: { left: pps, right: pps },
    garbageDelayFrames: 0,
  });
  const queueSeeds = { left: scenario.bagSeed, right: scenario.bagSeed };
  const kinds = Object.fromEntries(
    ["left", "right"].map((side) => [
      side,
      side === attaxSide ? "attax" : opponent ? "attax-opponent" : "champion",
    ]),
  );
  const lastDecisionStates = Object.fromEntries(
    match.bots.map((b) => [b.id, structuredClone(b.state)]),
  );
  const drivers = new Map();
  const attaxGame = attax;
  const opponentGame = opponent;
  const receipts = { left: null, right: null };
  const lastTankTopout = { left: false, right: false };
  let outcome = null;
  let error = null;
  let locks = 0;
  let rejectedRoots = 0;
  try {
    for (const side of ["left", "right"]) {
      if (kinds[side] === "champion") drivers.set(side, await createChampionDriver());
    }
    while (true) {
      outcome = matchOutcome(
        match.bots.map((b) => ({
          id: b.id,
          toppedOut: lastTankTopout[b.id] || /[^_]/.test(b.state.board.cells.slice(200)),
        })),
        match.turnNumber,
        null,
      );
      if (outcome.complete || locks >= maxLocks) break;
      // Referee alone owns generators; neither decision function receives seeds/tails.
      for (const bot of match.bots) {
        const queue = [bot.state.pieces.current, ...bot.state.pieces.known];
        const extended = extendSeededQueue(queue, queueSeeds[bot.id], 28);
        queueSeeds[bot.id] = extended.bagSeed;
        match = controller.extendBotMatchQueue(match, bot.id, extended.queue);
      }
      const due = controller.botMatchNextStep(match);
      if (locks + due.botIds.length > maxLocks) break;
      const submissions = [];
      for (const side of due.botIds) {
        const bot = match.bots.find((b) => b.id === side);
        const gui = controller.botMatchToGuiState(match, side);
        let result = null;
        if (values["debug-log"]) lastDecisionStates[side] = structuredClone(bot.state);
        if (kinds[side] !== "champion") {
          const visible = {
            ...bot.state,
            pieces: {
              ...bot.state.pieces,
              known: bot.state.pieces.known.slice(0, parameters.queueDepth - 1),
            },
          };
          const decision = createS2AmountOnlyDecisionState(visible);
          // Reproject every decision from the post-lock/cancel/tank referee state.
          // Receipts stay on the controller side: they can include private hole data.
          const reachable = generateReachablePlacements(visible, {
            kickTable: rules.kickTable,
            // The ruleset's public rules allow 180 (allow180: true); the
            // stage-2 harness ran with it off as a conservatism, which
            // filtered legal roots the referee itself would witness.
            allow180: true,
          });
          const witnesses = new Map();
          for (const p of reachable) {
            const cells = cellKey(
              geometry.blocks[p.piece][p.rotation].map(([x, y]) => [p.x + x, p.y + y]),
            );
            const key = `${p.piece}:${p.usedHold}:${p.rotationEvidence.lastInputWasRotation}:${cells}`;
            if (!witnesses.has(key)) witnesses.set(key, p);
          }
          const witnessKey = (p, usedHold) =>
            `${p.kind}:${usedHold}:${p.lastSrs > 0}:${cellKey(placementCells(p))}`;
          const searched = await (kinds[side] === "attax" ? attaxGame : opponentGame).decideAsync(
            decision,
            (p, usedHold) => {
              const accepted = witnesses.has(witnessKey(p, usedHold));
              if (!accepted && kinds[side] === "attax") rejectedRoots++;
              return accepted;
            },
          );
          if (searched === null)
            throw new Error("attax has no witnessed move before referee top-out");
          const placement = witnesses.get(
            witnessKey(searched.best.placement, searched.best.usedHold),
          );
          if (!placement) throw new Error("selected attax root lost its lab witness");
          const transition = applyTransition(
            bot.state,
            { kind: "placement", placement },
            bot.state.rulesetId,
          );
          if (values["debug-log"]) {
            const stages = transition.attackStages;
            const clear = transition.lockResult;
            await appendFile(
              values["debug-log"],
              `${JSON.stringify({
                seed: gameSeed,
                side,
                lockIndex: bot.stats.turns,
                frame: decision.lockTime?.logicalFrame ?? null,
                predictedAttack: searched.best.attack,
                refereeRaw: stages?.raw ?? null,
                refereeAfterMultiplier: stages?.afterMultiplier ?? null,
                refereeAfterRounding: stages?.afterRounding ?? null,
                refereeSpecialBonus: stages?.specialBonus ?? null,
                refereePcBonus: stages?.perfectClearBonus ?? null,
                lines: clear?.lines ?? null,
                spin: clear?.spin ?? null,
              })}\n`,
            );
          }
          result = { transition, comparison: { positionFingerprint: fullStateKey(bot.state) } };
        } else {
          result = await drivers.get(side).decide(bot.state, gui, side);
        }
        if (!result.transition.legality.legal)
          throw new Error(`illegal placement: ${result.transition.legality.reason}`);
        receipts[side] = result.transition;
        lastTankTopout[side] = result.transition.tankResult?.toppedOut === true;
        submissions.push({ botId: side, result });
      }
      match = controller.advanceBotMatch(match, submissions);
      locks += submissions.length;
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
    if (values["debug-log"])
      await writeFile(
        `${values["debug-log"]}.errors.json`,
        JSON.stringify({ seed: gameSeed, error, states: lastDecisionStates }, null, 2),
      );
  } finally {
    for (const driver of drivers.values()) await driver.close();
  }
  const complete = !error && outcome?.complete === true;
  const record = {
    schema: "attax-s2-lab/1",
    seed: gameSeed,
    side: attaxSide,
    contestants: Object.fromEntries(
      ["left", "right"].map((s) => [
        s,
        s === attaxSide ? "attax" : opponent ? `attax:${values["opponent-id"]}` : "cc2-s2-champion",
      ]),
    ),
    status: error ? "error" : complete ? "finished" : "unfinished",
    winner: complete ? outcome.winnerBotId : null,
    reason: error ? "harness-error" : complete ? outcome.reason : "max-locks",
    topOutReason: complete
      ? Object.fromEntries(
          match.bots
            .filter((b) => lastTankTopout[b.id] || /[^_]/.test(b.state.board.cells.slice(200)))
            .map((b) => [
              b.id,
              lastTankTopout[b.id] ? "garbage-tank-topout" : "occupied-buffer-lab-placement-rule",
            ]),
        )
      : null,
    locks: Object.fromEntries(match.bots.map((b) => [b.id, b.stats.turns])),
    attack: Object.fromEntries(match.bots.map((b) => [b.id, b.stats.attack])),
    stats: Object.fromEntries(match.bots.map((b) => [b.id, b.stats])),
    finalFingerprints: Object.fromEntries(match.bots.map((b) => [b.id, fullStateKey(b.state)])),
    finalReceipts: Object.fromEntries(
      Object.entries(receipts).map(([side, t]) => [
        side,
        t === null
          ? null
          : {
              lock: t.lockResult,
              attack: t.attackStages,
              cancel: t.cancelResult,
              tankedRows: t.tankResult?.inserted?.reduce((n, p) => n + p.amount, 0) ?? 0,
            },
      ]),
    ),
    wallMs: performance.now() - started,
    logicalFrames: match.clock.logicalFrame,
    error,
    rejectedRoots,
    protocolErrors: error ? 1 : 0,
    settings: {
      opponentProfileId: values["opponent-id"] ?? null,
      mode: "paced",
      pps,
      garbageDelayFrames: 0,
      queueModel: "legacy-lcg",
      publicQueueIncludingCurrent: parameters.queueDepth,
      maxLocks,
      championParameters: parameters,
      championProfile: profile,
      championProfileSha256: digest,
      wasmSha256,
      attaxWidth: 96,
      planCarryover,
      attaxEngine: {
        id: "gpu",
        form: engineInfo.form,
        device: engineInfo.device,
        tablesSha256: engineInfo.tablesSha256,
      },
      attaxWeights: "config-o",
      attaxWeightsSource: "gpu-engine-fixed",
      labRoot,
    },
  };
  await appendFile(values.out, `${JSON.stringify(record)}\n`);
  console.log(
    JSON.stringify({
      seed: record.seed,
      status: record.status,
      side: attaxSide,
      winner: record.winner,
      locks: record.locks,
      attack: record.attack,
      wallMs: record.wallMs,
      error,
    }),
  );
  // Per-game errors stay data (amendment 2026-11-15 03:27 JST): the record
  // above carries them into the driver compat/exclusion accounting (C3);
  // rethrowing here aborted the remaining games and bypassed that policy.
}
// Games may run concurrently (--concurrency N): each game is independent, the
// shared deciders serialize engine requests per server, and records append in
// completion order. Default 1 = the historical sequential behavior.
const concurrency = Math.max(1, Math.min(games, Number(values.concurrency) || 1));
let nextGame = 0;
async function worker() {
  while (true) {
    const index = nextGame++;
    if (index >= games) return;
    await play(index);
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
attax.close();
opponent?.close();
{
  const timing = gpuEngineTimingSummary();
  console.error(
    `engine: gpu (${engineInfo.device}); host-reported mean ${timing.meanMs.toFixed(2)} ms/decision over ${timing.count} attax decisions (max ${timing.maxMs.toFixed(2)} ms)`,
  );
}
