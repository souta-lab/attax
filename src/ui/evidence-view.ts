/**
 * The evidence: headline claim, the matchup table, and every benchmark game as a cell that
 * loads that exact game into the arena.
 */
import { BRAND } from "../brand.js";
import { RESULTS } from "../data/results.js";
import type { Side } from "../sim/arena.js";
import { fixed, h, pct } from "./dom.js";

export function createHero(): HTMLElement {
  const cc2 = RESULTS.rows.find((row) => row.id === "cc2") ?? RESULTS.headline;
  const fork = RESULTS.rows.find((row) => row.id === "cc2-fork");
  const tile = (value: string, label: string, note: string): HTMLElement =>
    h("div", { class: "tile" }, [
      h("strong", { text: value }),
      h("span", { text: label }),
      h("small", { text: note }),
    ]);
  const record = (row: typeof cc2): string =>
    `${row.wins}–${row.losses}${row.draws > 0 ? `–${row.draws}` : ""} over ${row.games} games`;
  return h("section", { class: "hero", attrs: { id: "top" } }, [
    h("p", { class: "kicker", text: BRAND.tagline }),
    h("h1", {}, [
      `${BRAND.botName} beats the official Cold Clear 2 in `,
      h("span", { class: "bot-ink", text: `${cc2.wins} of ${cc2.games}` }),
      " games.",
    ]),
    h("p", { class: "lede", text: RESULTS.copy.hero }),
    h("div", { class: "tiles" }, [
      tile(pct(cc2.winRate), "win rate, official Cold Clear 2", record(cc2)),
      tile(
        fork === undefined ? "–" : pct(fork.winRate),
        "win rate, Cold Clear 2 fork",
        fork === undefined ? "" : record(fork),
      ),
      tile(
        `${fixed(cc2.attackPerPiece)} : ${fixed(cc2.rivalAttackPerPiece)}`,
        "attack generated per piece",
        `${BRAND.botName} : Cold Clear 2`,
      ),
    ]),
    h("p", { class: "lede", text: RESULTS.copy.claim }),
  ]);
}

export function createResults(): HTMLElement {
  const table = resultTable();
  return h("section", { class: "evidence", attrs: { id: "results" } }, [
    h("h2", { text: "Results" }),
    h(
      "div",
      {
        class: "results-table",
        attrs: { tabindex: "0", "aria-label": "Measured opponent results" },
      },
      [table],
    ),
    ...RESULTS.copy.profiles.map((text) => h("p", { text })),
  ]);
}

function resultTable(): HTMLElement {
  return h("table", { class: "matchups" }, [
    h("thead", {}, [
      h("tr", {}, [
        h("th", { text: "Opponent" }),
        h("th", { text: "Games" }),
        h("th", { text: "W–L" }),
        h("th", { text: "Win rate (95% Wilson CI)" }),
        h("th", { text: "Attack / piece (Attax vs opponent)" }),
      ]),
    ]),
    h(
      "tbody",
      {},
      ["cc2", "cc2-fork", "bot", "preview2", "clys"]
        .flatMap((id) => RESULTS.rows.filter((row) => row.id === id))
        .map((row) =>
          h("tr", {}, [
            h("td", {}, [
              h("strong", {
                text: row.id === "bot" ? "Hoiko (Rust/WASM replica of Hoiko.exe)" : row.label,
              }),
              h("small", { text: row.detail }),
            ]),
            h("td", { text: String(row.games) }),
            h("td", { text: `${row.wins}–${row.losses}${row.draws > 0 ? `–${row.draws}` : ""}` }),
            h("td", {}, [
              h("span", { text: pct(row.winRate, row.winRate === 1 ? 0 : 1) }),
              h("small", {
                text: `${pct(row.low)}–${pct(row.high, Number(row.high.toFixed(3)) === 1 ? 0 : 1)}`,
              }),
            ]),
            h("td", {
              text: `${fixed(row.attackPerPiece, ["clys", "cc2", "cc2-fork"].includes(row.id) ? 4 : 2)} vs ${fixed(row.rivalAttackPerPiece, ["clys", "cc2", "cc2-fork"].includes(row.id) ? 4 : 2)}`,
            }),
          ]),
        ),
    ),
  ]);
}

export function createEvidence(load: (seed: number, side: Side) => void): HTMLElement {
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
      text: `The Hoiko benchmark uses identical conditions: both sides draw from the same seeded piece sequence, garbage follows the same rules, and each AI locks exactly one piece per 120 ms regardless of how long it thinks — so the result measures decisions, not speed.`,
    }),
    h("h3", { text: `All ${RESULTS.games.length} games` }),
    h("p", {
      class: "fine",
      text: `One square per seed. Blue = ${BRAND.botName} won, orange = ${BRAND.rivalName} won. Click any square to replay that exact game above — it reproduces the recorded result move for move.`,
    }),
    h("div", { class: "games" }, cells),
  ]);
}
