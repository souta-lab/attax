/**
 * ExpandAI.ExpandTemplateNode + the three const child tables (SPEC_ExpandAI §7,
 * binary IL 14872, tables at IL 690/692/698). The tables are NOT gated by config:
 * the binary always expands with them when `GamePack.IsSafe` is true, so they are
 * required for a faithful low-stack opening.
 */

import type { Baby } from "./baby.js";
import type { MinoType } from "./shapes.js";

interface TemplateEntry {
  readonly cmds: string;
  readonly delay: number;
  readonly x: number;
  readonly r: number;
}

const CHILD_I: readonly TemplateEntry[] = [
  { cmds: "lll", delay: 90, x: 0, r: 0 },
  { cmds: "ll", delay: 60, x: 1, r: 0 },
  { cmds: "l", delay: 30, x: 2, r: 0 },
  { cmds: "r", delay: 30, x: 4, r: 0 },
  { cmds: "rr", delay: 60, x: 5, r: 0 },
  { cmds: "rrr", delay: 90, x: 6, r: 0 },
  { cmds: "lllall", delay: 150, x: -2, r: 1 },
  { cmds: "lllal", delay: 120, x: -1, r: 1 },
  { cmds: "llla", delay: 90, x: 0, r: 1 },
  { cmds: "lla", delay: 60, x: 1, r: 1 },
  { cmds: "la", delay: 30, x: 2, r: 1 },
  { cmds: "a", delay: 0, x: 3, r: 1 },
  { cmds: "ra", delay: 30, x: 4, r: 1 },
  { cmds: "rra", delay: 60, x: 5, r: 1 },
  { cmds: "rrra", delay: 90, x: 6, r: 1 },
  { cmds: "rrrar", delay: 120, x: 7, r: 1 },
  { cmds: "lllbl", delay: 120, x: -1, r: 3 },
  { cmds: "lllb", delay: 90, x: 0, r: 3 },
  { cmds: "llb", delay: 60, x: 1, r: 3 },
  { cmds: "lb", delay: 30, x: 2, r: 3 },
  { cmds: "b", delay: 0, x: 3, r: 3 },
  { cmds: "rb", delay: 30, x: 4, r: 3 },
  { cmds: "rrb", delay: 60, x: 5, r: 3 },
  { cmds: "rrrb", delay: 90, x: 6, r: 3 },
  { cmds: "rrrbr", delay: 120, x: 7, r: 3 },
  { cmds: "rrrbrr", delay: 150, x: 8, r: 3 },
  { cmds: "llblb", delay: 90, x: 0, r: 2 },
  { cmds: "lblb", delay: 60, x: 1, r: 2 },
  { cmds: "blb", delay: 32, x: 2, r: 2 },
  { cmds: "bb", delay: 32, x: 3, r: 2 },
  { cmds: "ara", delay: 32, x: 4, r: 2 },
  { cmds: "rara", delay: 60, x: 5, r: 2 },
  { cmds: "rrara", delay: 90, x: 6, r: 2 },
];

const CHILD_SZTJL: readonly TemplateEntry[] = [
  { cmds: "lll", delay: 90, x: 0, r: 0 },
  { cmds: "ll", delay: 60, x: 1, r: 0 },
  { cmds: "l", delay: 30, x: 2, r: 0 },
  { cmds: "r", delay: 30, x: 4, r: 0 },
  { cmds: "rr", delay: 60, x: 5, r: 0 },
  { cmds: "rrr", delay: 90, x: 6, r: 0 },
  { cmds: "rrrr", delay: 120, x: 7, r: 0 },
  { cmds: "lllal", delay: 120, x: -1, r: 1 },
  { cmds: "llla", delay: 90, x: 0, r: 1 },
  { cmds: "lla", delay: 60, x: 1, r: 1 },
  { cmds: "la", delay: 30, x: 2, r: 1 },
  { cmds: "a", delay: 0, x: 3, r: 1 },
  { cmds: "ra", delay: 30, x: 4, r: 1 },
  { cmds: "rra", delay: 60, x: 5, r: 1 },
  { cmds: "rrra", delay: 90, x: 6, r: 1 },
  { cmds: "rrrar", delay: 120, x: 7, r: 1 },
  { cmds: "lllb", delay: 90, x: 0, r: 3 },
  { cmds: "llb", delay: 60, x: 1, r: 3 },
  { cmds: "lb", delay: 30, x: 2, r: 3 },
  { cmds: "b", delay: 0, x: 3, r: 3 },
  { cmds: "rb", delay: 30, x: 4, r: 3 },
  { cmds: "rrb", delay: 60, x: 5, r: 3 },
  { cmds: "rrrb", delay: 90, x: 6, r: 3 },
  { cmds: "rrrrb", delay: 120, x: 7, r: 3 },
  { cmds: "rrrrbr", delay: 150, x: 8, r: 3 },
  { cmds: "llblb", delay: 90, x: 0, r: 2 },
  { cmds: "lblb", delay: 60, x: 1, r: 2 },
  { cmds: "blb", delay: 32, x: 2, r: 2 },
  { cmds: "bb", delay: 32, x: 3, r: 2 },
  { cmds: "ara", delay: 32, x: 4, r: 2 },
  { cmds: "rara", delay: 60, x: 5, r: 2 },
  { cmds: "rrara", delay: 90, x: 6, r: 2 },
  { cmds: "rrrara", delay: 120, x: 7, r: 2 },
];

const CHILD_O: readonly TemplateEntry[] = [
  { cmds: "llll", delay: 120, x: -1, r: 0 },
  { cmds: "lll", delay: 90, x: 0, r: 0 },
  { cmds: "ll", delay: 60, x: 1, r: 0 },
  { cmds: "l", delay: 30, x: 2, r: 0 },
  { cmds: "r", delay: 30, x: 4, r: 0 },
  { cmds: "rr", delay: 60, x: 5, r: 0 },
  { cmds: "rrr", delay: 90, x: 6, r: 0 },
  { cmds: "rrrr", delay: 120, x: 7, r: 0 },
];

function tableFor(m: MinoType): readonly TemplateEntry[] {
  if (m === 3) return CHILD_O;
  if (m === 0) return CHILD_I;
  return CHILD_SZTJL;
}

/** ExpandTemplateNode (IL 14872); appends babies[1..entries], returns entries+1. */
export function expandTemplateNode(babies: Baby[], root: Baby): number {
  const table = tableFor(root.fallingMino.m);
  const num = table.length + 1;
  const inherit = root.hold.swappedHold !== 0;
  for (const entry of table) {
    const dst = babies[0]?.clone() ?? root.clone();
    dst.hold = root.hold.clone();
    dst.nextIt.copyFrom(root.nextIt);
    dst.fallingMino.m = root.fallingMino.m;
    dst.fallingMino.y = root.fallingMino.y;
    dst.fallingMino.x = entry.x;
    dst.fallingMino.r = entry.r;
    dst.fallingMino.lastSrs = 0;
    dst.fallingMino.bugGravity = 0;
    if (!inherit) {
      dst.commands.init();
      dst.commands.moveDelay = entry.delay;
    } else {
      dst.commands = root.commands.clone();
      dst.commands.moveDelay += entry.delay;
    }
    dst.commands.addCommands(entry.cmds);
    babies.push(dst);
  }
  return num;
}
