/** Tiny DOM helpers — the UI is plain DOM + canvas, no framework. */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; attrs?: Record<string, string> } = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class !== undefined) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  for (const child of children) node.append(child);
  return node;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function fixed(x: number, digits = 2): string {
  return x.toFixed(digits);
}

/** Cell size for boards: large on desktop, compact on phones. */
export function boardCell(): number {
  const w = window.innerWidth;
  if (w < 560) return 13;
  if (w < 900) return 18;
  return 24;
}

/** Human-readable name of a lock action. */
export function actionLabel(action: string): string {
  switch (action) {
    case "Single":
      return "Single";
    case "Double":
      return "Double";
    case "Triple":
      return "Triple";
    case "Quad":
      return "Four lines";
    case "Tss":
      return "T-spin single";
    case "Tsd":
      return "T-spin double";
    case "Tst":
      return "T-spin triple";
    case "Tsm":
      return "T-spin mini";
    case "Pc":
      return "Perfect clear";
    default:
      return "";
  }
}
