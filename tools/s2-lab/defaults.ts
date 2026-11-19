/**
 * Shipped bot defaults, vendored from src/ai/bot/fighter.ts in Phase C
 * (2026-11-19) when the TS search was removed. The GPU driver reads
 * BOT_DEFAULTS.width as the beam width a profile must resolve to (the GPU
 * engine is fixed at the shipped width 96 and refuses anything else).
 */
export const BOT_DEFAULTS = { preview: 5, width: 96 } as const;
