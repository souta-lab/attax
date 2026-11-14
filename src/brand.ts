import { RESULTS } from "./data/results.js";
/**
 * Every user-visible name in one place. Renaming the project for publication means editing
 * this file (plus `index.html` <title>/meta and `package.json` "name").
 */
export const BRAND = {
  /** The bot's display name. */
  botName: "Attax",
  /** The opponent. Hoiko is the original author's AI; keep its name for attribution. */
  rivalName: "Hoiko",
  /** Short page title. */
  title: "Attax",
  /** One-line description of what the page is. */
  tagline: RESULTS.tagline,
} as const;
