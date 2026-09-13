//! Step planning, board fingerprinting and step application.
//!
//! Faithful port of the `planSteps` / `boardFingerprint` / `executionMatches` /
//! `applyStep` region of `src/versus/controller.ts`.

use crate::engine::Game;
use crate::types::{AiExecutionPlan, AiMove, AiStep, GameSnapshot, COLS, ROWS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ApplyStepResult {
    Applied,
    ExpectedBoardFailure,
}

/// `src/versus/controller.ts` `locksPiece`.
pub(crate) fn locks_piece(step: &AiStep) -> bool {
    matches!(step, AiStep::Drop | AiStep::PlaceAt { .. })
}

/// `src/versus/controller.ts` `boardFingerprint`: bottom-up bit rows from the
/// top-down snapshot board, joined by commas.
pub fn board_fingerprint(snapshot: &GameSnapshot) -> String {
    let mut rows: Vec<u16> = Vec::with_capacity(ROWS);
    for y in 0..ROWS {
        let row = &snapshot.board.grid[ROWS - 1 - y];
        let mut bits = 0u16;
        for x in 0..COLS {
            if row[x] != 0 {
                bits |= 1u16 << x;
            }
        }
        rows.push(bits);
    }
    rows.iter()
        .map(|bits| bits.to_string())
        .collect::<Vec<String>>()
        .join(",")
}

/// `src/versus/controller.ts` `planSteps`.
pub fn plan_steps(current_rotation: i32, current_x: i32, mv: &AiMove) -> Vec<AiStep> {
    if !mv.use_hold {
        if let Some(execution) = &mv.execution {
            return execution.steps.clone();
        }
    }
    let mut steps: Vec<AiStep> = Vec::new();
    if mv.use_hold {
        steps.push(AiStep::Hold);
    }
    let target_rot = ((mv.target_rotation % 4) + 4) % 4;
    let cur_rot = ((current_rotation % 4) + 4) % 4;
    let cw = (target_rot - cur_rot + 4) % 4;
    let ccw = (cur_rot - target_rot + 4) % 4;
    if cw <= ccw {
        for _ in 0..cw {
            steps.push(AiStep::RotateCW);
        }
    } else {
        for _ in 0..ccw {
            steps.push(AiStep::RotateCCW);
        }
    }
    let dx = mv.target_x - current_x;
    if dx < 0 {
        for _ in 0..-dx {
            steps.push(AiStep::Left);
        }
    } else {
        for _ in 0..dx {
            steps.push(AiStep::Right);
        }
    }
    steps.push(AiStep::Drop);
    steps
}

fn board_matches(actual: &[u16], expected: &[u16]) -> bool {
    actual.len() == expected.len() && actual.iter().zip(expected).all(|(a, b)| a == b)
}

/// `src/versus/controller.ts` `executionMatches`.
pub fn execution_matches(snapshot: &GameSnapshot, execution: &AiExecutionPlan) -> bool {
    let Some(active) = &snapshot.active else {
        return false;
    };
    active.kind == execution.source_active_kind
        && active.rotation == execution.source_rotation
        && active.pos_x == execution.source_x
        && snapshot.hold == execution.source_hold
        && snapshot.can_hold == execution.source_can_hold
        && board_fingerprint(snapshot) == execution.source_board_fingerprint
}

/// `src/versus/controller.ts` `applyStep`.
pub(crate) fn apply_step(
    core: &mut Game,
    step: &AiStep,
    execution: Option<&AiExecutionPlan>,
) -> ApplyStepResult {
    match step {
        AiStep::Hold => {
            core.hold();
            ApplyStepResult::Applied
        }
        AiStep::RotateCW => {
            core.rotate_cw();
            ApplyStepResult::Applied
        }
        AiStep::RotateCCW => {
            core.rotate_ccw();
            ApplyStepResult::Applied
        }
        AiStep::Left => {
            core.move_left();
            ApplyStepResult::Applied
        }
        AiStep::Right => {
            core.move_right();
            ApplyStepResult::Applied
        }
        AiStep::SoftDrop => {
            core.soft_drop();
            ApplyStepResult::Applied
        }
        AiStep::Drop => {
            core.hard_drop();
            let Some(execution) = execution else {
                return ApplyStepResult::Applied;
            };
            match core.last_lock_transition() {
                Some(transition)
                    if board_matches(
                        &transition.board_after_lock_clear,
                        &execution.expected_board,
                    ) && transition.lines_cleared == execution.expected_lines_cleared =>
                {
                    ApplyStepResult::Applied
                }
                _ => ApplyStepResult::ExpectedBoardFailure,
            }
        }
        AiStep::PlaceAt {
            rotation,
            x,
            top_row,
            last_srs,
        } => {
            let placed = match top_row {
                Some(top_row) => core.place_mino_at(*rotation, *x, *top_row, last_srs.unwrap_or(0)),
                None => core.hard_drop_at(*rotation, *x),
            };
            if !placed {
                core.hard_drop();
            }
            ApplyStepResult::Applied
        }
    }
}
