import { createHash } from "node:crypto";
import { appendFile, open, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  cellKey,
  createAttaxDecider,
  decideAttax,
  loadS2Weights,
  placementCells,
} from "./attax-player.js";
import { createChampionDriver } from "./champion-driver.mjs";
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
    out: { type: "string" },
    "max-locks": { type: "string", default: "1000" },
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
const opponent = values["opponent-profile"] ? createAttaxDecider(values["opponent-profile"]) : null;
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
  const attaxSide = values["champion-vs-champion"] ? null : gameIndex % 2 === 0 ? "left" : "right";
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
            allow180: false,
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
          const searched = (kinds[side] === "attax" ? decideAttax : opponent.decide)(
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
      opponentProfileId: opponent?.profileId ?? null,
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
      attaxWidth: 48,
      attaxWeights: loadS2Weights().profileId,
      attaxWeightsSource: loadS2Weights().source,
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
  if (error) throw new Error(error);
}
for (let index = 0; index < games; index++) await play(index);
