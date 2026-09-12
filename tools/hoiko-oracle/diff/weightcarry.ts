/**
 * `EvaluateAI.weight` input-carry probe.
 *
 * `TransitionWeight` reads the previous weight row (IL 13548 sets
 * transitionHeight 13 when the current row is >= 2; IL 13618/13632 keep row 1
 * "sticky"), and the row global is only written by TransitionWeight /
 * EvenOrOdd / ReadEvalWeight-at-Init — never reset per turn. This probe feeds
 * the exe a discriminating position with `weightindex=0` vs `weightindex=2` and
 * shows the selected row (and move) differ, i.e. the harness must carry the
 * previous row across searches.
 *
 *   bun weightcarry.ts
 *
 * Evidence: evidence/hoiko-inputs/weight/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { runExe } from "./exe.js";

const EVIDENCE = new URL("../../../evidence/hoiko-inputs/weight/", import.meta.url);
mkdirSync(EVIDENCE, { recursive: true });

interface Case {
  readonly name: string;
  readonly board: readonly number[];
  readonly next: readonly number[];
  readonly weightIndex: number;
}

function boardLine(rows: readonly number[]): string {
  const board = [...rows];
  while (board.length < 32) board.push(0);
  return board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",");
}

const NEXT = [0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2];

/** Columns 3..6 at height 14 (0x78), the rest low -> center4Height+1 = 15. */
function tallCenter(): number[] {
  const rows = new Array(32).fill(0);
  rows[0] = 0x3ff;
  for (let y = 1; y <= 6; y += 1) rows[y] = 0x2ff;
  for (let y = 7; y <= 13; y += 1) rows[y] = 0x78;
  return rows;
}

function cases(): Case[] {
  const base = NEXT;
  const tall = tallCenter();
  return [
    { name: "center13-others6", board: [...tall], next: base, weightIndex: 0 },
    { name: "center13-others6-w2", board: [...tall], next: base, weightIndex: 2 },
    { name: "center14", board: [...tall, 0x78], next: base, weightIndex: 0 },
    { name: "center14-w2", board: [...tall, 0x78], next: base, weightIndex: 2 },
    { name: "center15", board: [...tall, 0x78, 0x78], next: base, weightIndex: 0 },
    { name: "center15-w2", board: [...tall, 0x78, 0x78], next: base, weightIndex: 2 },
  ];
}

interface Decision {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly weightIndex: number;
}

function parse(text: string): Decision | null {
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const wi = text.match(/weightIndex=(-?\d+)/);
  if (fm === null) return null;
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    weightIndex: wi === null ? -1 : Number(wi[1]),
  };
}

for (const c of cases()) {
  const input = [
    `# weightcarry ${c.name}`,
    `board=${boardLine(c.board)}`,
    `next=${c.next.join(",")}`,
    "timer=1",
    "depthlimit=10",
    `weightindex=${c.weightIndex}`,
    "",
  ].join("\n");
  const run = runExe(input);
  writeFileSync(new URL(`${c.name}.log`, EVIDENCE), run.text);
  const d = run.ok ? parse(run.text) : null;
  console.log(
    `${c.name.padEnd(18)} in=${c.weightIndex} out=${d?.weightIndex} move=${d?.x}/${d?.rot}/${d?.m}`,
  );
}
