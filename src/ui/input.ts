import type { CorePort } from "./types.js";

export interface InputHandle {
  detach(): void;
}

/**
 * Single-step keyboard controls (no DAS, per guideline).
 * ArrowLeft/Right/Down, ArrowUp/X = rotate CW, Z = rotate CCW,
 * Space = hard drop, C/Shift = hold.
 */
export function attachInput(target: Window | HTMLElement, core: CorePort): InputHandle {
  const onKeyDown = (ev: Event): void => {
    if (!(ev instanceof KeyboardEvent)) return;
    if (ev.repeat) {
      // Allow repeat only for horizontal/soft-drop movement.
      if (ev.code !== "ArrowLeft" && ev.code !== "ArrowRight" && ev.code !== "ArrowDown") return;
    }
    switch (ev.code) {
      case "ArrowLeft":
        ev.preventDefault();
        core.moveLeft();
        break;
      case "ArrowRight":
        ev.preventDefault();
        core.moveRight();
        break;
      case "ArrowDown":
        ev.preventDefault();
        core.softDrop();
        break;
      case "ArrowUp":
      case "KeyX":
        ev.preventDefault();
        core.rotateCW();
        break;
      case "KeyZ":
        ev.preventDefault();
        core.rotateCCW();
        break;
      case "Space":
        ev.preventDefault();
        core.hardDrop();
        break;
      case "KeyC":
      case "ShiftLeft":
      case "ShiftRight":
        ev.preventDefault();
        core.hold();
        break;
      default:
        break;
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return {
    detach(): void {
      target.removeEventListener("keydown", onKeyDown);
    },
  };
}
