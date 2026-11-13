/**
 * The evidence: headline claim, the matchup table, and every benchmark game as a cell that
 * loads that exact game into the arena.
 */
import { BRAND } from "../brand.js";
import { RESULTS } from "../data/results.js";
import type { Side } from "../sim/arena.js";
import { fixed, h, pct } from "./dom.js";

export function createHero(): HTMLElement {
  const r = RESULTS.headline;
  const tile = (value: string, label: string, note: string): HTMLElement =>
    h("div", { class: "tile" }, [
      h("strong", { text: value }),
      h("span", { text: label }),
      h("small", { text: note }),
    ]);
  const old = RESULTS.rows.find((row) => row.id === "old-ai");
  return h("section", { class: "hero", attrs: { id: "top" } }, [
    h("p", { class: "kicker", text: BRAND.tagline }),
    h("h1", {}, [
      `${BRAND.botName} beats ${BRAND.rivalName} in `,
      h("span", { class: "bot-ink", text: `${r.wins} of ${r.games}` }),
      " games.",
    ]),
    h("p", {
      class: "lede",
      text: `Same seeds, same rules, every game played once from each seat. ${BRAND.rivalName} runs as a byte-identical port of its shipping binary. Win rate ${pct(r.winRate)} (95% interval ${pct(r.low)}–${pct(r.high)}) on ${RESULTS.seeds} — seeds never used for tuning.`,
    }),
    h("div", { class: "tiles" }, [
      tile(
        pct(r.winRate),
        "win rate",
        `${r.wins}–${r.losses}${r.draws > 0 ? `–${r.draws}` : ""} over ${r.games} games`,
      ),
      tile(
        `${fixed(r.attackPerPiece)} : ${fixed(r.rivalAttackPerPiece)}`,
        "garbage sent per piece",
        `${BRAND.botName} : ${BRAND.rivalName}`,
      ),
      tile(
        old === undefined ? "–" : pct(old.winRate),
        "previous AI, same test",
        old === undefined ? "" : `${old.wins}–${old.losses} — the code this replaces`,
      ),
    ]),
  ]);
}

export function createEvidence(load: (seed: number, side: Side) => void): HTMLElement {
  const table = h("table", { class: "matchups" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { text: "Matchup" }),
        h("th", { text: "Games" }),
        h("th", { text: "W–L" }),
        h("th", { text: "Win rate (95% CI)" }),
        h("th", { text: "Sent / piece" }),
        h("th", { text: "Lines / game" }),
      ]),
    ]),
    h(
      "tbody",
      {},
      RESULTS.rows.map((row) =>
        h("tr", {}, [
          h("td", {}, [h("strong", { text: row.label }), h("small", { text: row.detail })]),
          h("td", { text: String(row.games) }),
          h("td", { text: `${row.wins}–${row.losses}${row.draws > 0 ? `–${row.draws}` : ""}` }),
          h("td", {}, [
            h("span", { text: pct(row.winRate) }),
            h("small", { text: `${pct(row.low, 0)}–${pct(row.high, 0)}` }),
          ]),
          h("td", { text: `${fixed(row.attackPerPiece)} vs ${fixed(row.rivalAttackPerPiece)}` }),
          h("td", {
            text: `${row.linesPerGame.toFixed(1)} vs ${row.rivalLinesPerGame.toFixed(1)}`,
          }),
        ]),
      ),
    ),
  ]);

  const cells = RESULTS.games.map((g) => {
    const [seed, seat, result, ticks, sent, rivalSent] = g;
    const side: Side = seat === 0 ? "left" : "right";
    const label = result === 1 ? "win" : result === 0 ? "loss" : "draw";
    const button = h("button", {
      class: `game ${label}`,
      attrs: {
        type: "button",
        title: `Seed ${seed}, ${BRAND.botName} ${side}: ${label} at tick ${ticks}, garbage ${sent}–${rivalSent}`,
        "aria-label": `Seed ${seed}, ${side} seat, ${label}. Watch this game.`,
      },
    });
    button.addEventListener("click", () => {
      load(seed, side);
      document.getElementById("watch")?.scrollIntoView({ behavior: "smooth" });
    });
    return button;
  });

  return h("section", { class: "evidence", attrs: { id: "evidence" } }, [
    h("h2", { text: "The evidence" }),
    h("p", {
      text: `Every row is a full set of games under identical conditions: both sides draw from the same seeded piece sequence, garbage follows the same rules, and each AI locks exactly one piece per 120 ms regardless of how long it thinks — so the result measures decisions, not speed.`,
    }),
    table,
    h("h3", { text: `All ${RESULTS.games.length} games` }),
    h("p", {
      class: "fine",
      text: `One square per game (left seat, then right seat, per seed). Blue = ${BRAND.botName} won, orange = ${BRAND.rivalName} won. Click any square to replay that exact game above — it reproduces the recorded result move for move.`,
    }),
    h("div", { class: "games" }, cells),
  ]);
}
