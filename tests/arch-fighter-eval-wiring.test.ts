type FighterFile = "fighterA.ts" | "fighterB.ts";

type Matcher = {
  readonly not: {
    readonly toBe: (expected: unknown) => void;
  };
  readonly toBe: (expected: unknown) => void;
  readonly toContain: (expected: string) => void;
  readonly toHaveLength: (expected: number) => void;
};

declare const Bun: {
  readonly file: (path: URL) => {
    readonly text: () => Promise<string>;
  };
};
declare const describe: (name: string, callback: () => void) => void;
declare const expect: (value: unknown) => Matcher;
declare const test: (name: string, callback: () => void | Promise<void>) => void;

async function readFighterSource(file: FighterFile): Promise<string> {
  return Bun.file(new URL(`../src/ai/${file}`, import.meta.url)).text();
}

function extractBeamBestMoveCalls(source: string): readonly string[] {
  const calls: string[] = [];
  const marker = "beamBestMove(";
  let searchFrom = 0;

  while (true) {
    const callStart = source.indexOf(marker, searchFrom);
    if (callStart === -1) return calls;

    let depth = 0;
    let callEnd = -1;
    for (let index = callStart + marker.length - 1; index < source.length; index += 1) {
      const character = source[index];
      if (character === "(") depth += 1;
      if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          callEnd = index;
          break;
        }
      }
    }

    if (callEnd === -1) throw new Error(`unclosed beamBestMove call at ${callStart}`);
    calls.push(source.slice(callStart, callEnd + 1));
    searchFrom = callEnd + 1;
  }
}

function extractPolicy(source: string): string {
  expect(source.match(/createBeamEvaluation\(/g) ?? []).toHaveLength(1);
  const policyCalls = extractBeamBestMoveCalls(source).filter((call) =>
    /evaluation:\s*createBeamEvaluation\(\{/.test(call),
  );
  expect(policyCalls).toHaveLength(1);

  const policyCall = policyCalls[0];
  if (policyCall === undefined) throw new Error("expected a direct evaluation policy call");
  const policyMatch = policyCall.match(/evaluation:\s*createBeamEvaluation\(\{([\s\S]*?)\}\)/);
  if (policyMatch === null || policyMatch[1] === undefined) {
    throw new Error("expected createBeamEvaluation to receive an object policy");
  }
  return policyMatch[1].replace(/\s+/g, " ").trim().replace(/,$/, "");
}

describe("arch-fighter-eval-wiring", () => {
  test("each fighter passes a distinct createBeamEvaluation policy directly to beamBestMove", async () => {
    const bluePolicy = extractPolicy(await readFighterSource("fighterA.ts"));
    const redPolicy = extractPolicy(await readFighterSource("fighterB.ts"));

    expect(bluePolicy).toContain("scoreAdjust: blueAdjust");
    expect(bluePolicy).toContain("scorer: blueScorer(s.hold, s.canHold, queue, seen)");
    expect(bluePolicy).toContain("legacyVeto: blueVeto(s.pendingGarbage)");
    expect(redPolicy).toContain("scoreAdjust: redAdjust");
    expect(redPolicy).toContain("scorer: redScorer");
    expect(redPolicy).toContain("legacyVeto: redVeto");
    expect(bluePolicy).not.toBe(redPolicy);
  });
});
