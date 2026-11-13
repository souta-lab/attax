import "./style.css";
import { BRAND } from "./brand.js";
import { RESULTS } from "./data/results.js";
import { createArenaView } from "./ui/arena-view.js";
import { h } from "./ui/dom.js";
import { createEvidence, createHero } from "./ui/evidence-view.js";
import { createPlayView } from "./ui/play-view.js";

const arena = createArenaView();

const method = h("section", { class: "method", attrs: { id: "method" } }, [
  h("h2", { text: "How the comparison is kept fair" }),
  h("ul", {}, [
    h("li", {}, [
      h("strong", { text: `${BRAND.rivalName} is the real thing. ` }),
      "It runs as a Rust/WebAssembly port of the shipping Hoiko binary whose moves were checked against the original executable: 500 of 500 moves identical in full games, including its garbage-timing logic.",
    ]),
    h("li", {}, [
      h("strong", { text: "Same rules, audited. " }),
      `The engine awards exactly the clear ${BRAND.rivalName} itself predicts for its own moves (${RESULTS.rulesAudit.agree} of ${RESULTS.rulesAudit.locks} audited locks agree). An earlier rules bug scored ${BRAND.rivalName}'s T-spin doubles as minis; it is fixed and every number here was measured after the fix.`,
    ]),
    h("li", {}, [
      h("strong", { text: "Same pace. " }),
      "Both sides lock one piece per 120 ms of game time no matter how long they think, so speed cannot win games — only decisions can.",
    ]),
    h("li", {}, [
      h("strong", { text: "Same pieces, both seats. " }),
      "Each seed is played twice, once from each side, on seeds the bot was never tuned on.",
    ]),
    h("li", {}, [
      h("strong", { text: "Plain, explainable AI. " }),
      `${BRAND.botName} searches the 5-piece preview (plus hold) with a beam of 48 positions and scores boards with a dozen named terms — holes, height, bumpiness, wells, T-slots — plus rewards for the garbage each clear sends. No neural network, no opening book.`,
    ]),
  ]),
  h("p", { class: "fine" }, [
    "Reproduce: ",
    h("code", { text: "bun scripts/benchmark.ts --seeds 1001-1200 --sides both --jobs 4" }),
    ` · data generated ${RESULTS.generatedAt.slice(0, 10)} at commit ${RESULTS.commit}.`,
  ]),
]);

const header = h("header", { class: "site" }, [
  h("a", { class: "brand", text: BRAND.title, attrs: { href: "#top" } }),
  h("nav", {}, [
    h("a", { text: "Watch", attrs: { href: "#watch" } }),
    h("a", { text: "Evidence", attrs: { href: "#evidence" } }),
    h("a", { text: "Method", attrs: { href: "#method" } }),
    h("a", { text: "Play", attrs: { href: "#play" } }),
  ]),
]);

const watch = h("section", { class: "watch", attrs: { id: "watch" } }, [
  h("h2", { text: "Watch them play" }),
  h("p", {
    text: `Both AIs run live in your browser on the same seed. Benchmark games replay exactly as recorded.`,
  }),
  arena.root,
]);

const play = h("section", { class: "playground", attrs: { id: "play" } }, [
  h("h2", { text: "Your turn" }),
  h("p", { text: "The same engine, under your fingers." }),
  createPlayView(),
]);

document.title = BRAND.title;
document.getElementById("app")?.replaceChildren(
  header,
  h("main", {}, [createHero(), watch, createEvidence(arena.load), method, play]),
  h("footer", {}, [
    h("p", {
      text: `${BRAND.title}. ${BRAND.rivalName} is the work of its original author; the port reproduces its decisions for comparison.`,
    }),
  ]),
);

const first = RESULTS.games[0];
arena.load(first?.[0] ?? 1001, first?.[1] === 1 ? "right" : "left");
