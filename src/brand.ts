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
  title: "Attax vs Hoiko",
  /** One-line description of what the page is. */
  tagline: "A versus AI for the falling-block game. It won 195 of 200 games against Hoiko.",
} as const;
