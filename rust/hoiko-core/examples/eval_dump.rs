//! E4 eval differential probe. Two modes, whitespace tokens on stdin.
//!
//! trace:  `trace board_len rows... current queue_len queue... hold combo btb view_next allow_hold`
//!         Runs the canonical `run_search` and the traced copy; prints CANON/TRACE
//!         outcome lines and `PATH x:rot:m:act,...` for the replica's chosen line.
//!
//! eval:   `eval board_len rows... current queue_len queue... hold combo btb view_next
//!          allow_hold path_len [x rot m act]*`
//!         Walks the path, dumps every child's state + per-term evaluation.
//!
//! Weights are the `we` preset (same values the app/wasm use).

use std::io::Read;

use hoiko_core::board::BOARD_HEIGHT;
use hoiko_core::evaluate::transition_weight;
use hoiko_core::probe::{build_root, ProbeInput};
use hoiko_core::probe_eval::{eval_bfs_probe, eval_walk_probe, EvalChildDump, EvalGenDump};
use hoiko_core::probe_trace::search_trace;
use hoiko_core::search::{default_search_state, run_search};
use hoiko_core::weights::HoikoWeights;

fn we() -> HoikoWeights {
    HoikoWeights {
        weight: [
            -15, -30, -100, -4, -25, -10, -15, -50, -120, -70, 10, 10, 5, 0, 30, 1000, 2, 30, 5,
            5, 35, -30, 15, 15, 35, 10, -100, 60, 20, -3, 10, 10, -100, -100, -350, -300, -250, 200,
            50, 300, 500, 50, 1500, 50, 0, 250, 50, 0, 0, 0,
        ],
        column: [-50, -70, -10, 0, 0, 0, 0, -10, -70, -50],
        combo_table: [180, 360, 540, 900, 1080],
        nexus: 0.5,
    }
}

struct Tok<'a> {
    it: std::str::SplitWhitespace<'a>,
}

impl Tok<'_> {
    fn i32(&mut self) -> i32 {
        self.it.next().unwrap().parse().unwrap()
    }
    fn usize(&mut self) -> usize {
        self.it.next().unwrap().parse().unwrap()
    }
}

struct Input {
    probe: ProbeInput,
    allow_hold: bool,
}

fn read_input(t: &mut Tok) -> Input {
    let board_len = t.usize();
    let mut board = Vec::with_capacity(board_len);
    for _ in 0..board_len {
        board.push(t.i32());
    }
    let current = t.i32();
    let queue_len = t.usize();
    let mut queue = Vec::with_capacity(queue_len);
    for _ in 0..queue_len {
        queue.push(t.i32());
    }
    let hold = t.i32();
    let combo = t.i32();
    let btb = t.i32();
    let view_next = t.i32();
    let allow_hold = t.i32() != 0;
    Input {
        probe: ProbeInput {
            board,
            current,
            queue,
            hold,
            combo,
            btb,
            view_next,
            weight_index: 0,
            is_even: true,
            use_s4w: false,
            trust_rate: 1.0,
        },
        allow_hold,
    }
}

fn rows_of(rows: &[i32; BOARD_HEIGHT]) -> String {
    rows.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")
}

fn print_child(gi: usize, idx: usize, c: &EvalChildDump) {
    print_child_labeled("E", gi, idx, c);
}

fn print_child_labeled(label: &str, gi: usize, idx: usize, c: &EvalChildDump) {
    let t = &c.terms;
    let ch = t.col_height.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",");
    println!(
        "{} {} {} hold={} x={} y={} rot={} m={} act={} delay={} combo={} btb={} stack={} nextBase={} trustEnd={} win={} fall={},{},{},{},{} lock={},{},{},{},{} | ch={} | minH={} height={} well={} wellCol={} wellDepth={} updown={} under={} ground={} res={} tsd={} tst={} pc={} cont={} action={} board={} fscore={} score={} rows={}",
        label,
        gi,
        idx,
        if c.hold_used { 1 } else { 0 },
        c.placed_x,
        c.locked.y,
        c.placed_r & 3,
        c.placed_m,
        c.act,
        c.move_delay,
        c.combo,
        c.btb,
        c.stack_height,
        c.next_base,
        c.trust_end,
        c.trust_end - c.next_base,
        c.falling.x,
        c.falling.y,
        c.falling.r,
        c.falling.m,
        c.falling.last_srs,
        c.locked.x,
        c.locked.y,
        c.locked.r,
        c.locked.m,
        c.locked.last_srs,
        ch,
        t.min_height,
        t.height,
        t.well_score,
        t.well_column,
        t.well_depth,
        t.up_down,
        t.underground,
        t.ground,
        t.resource,
        t.tsd,
        t.tst,
        t.pc,
        t.cont_bonus,
        t.final_action,
        t.board_sum,
        t.family_score,
        t.score,
        rows_of(&c.board),
    );
}

fn print_gen(gd: &EvalGenDump) {
    println!(
        "GEN {} depth={} mode={} trust={} count={} curFallM={} curHoldM={} curCombo={} curBtb={} curStack={}",
        gd.depth - 1,
        gd.depth,
        if gd.mode_first { "first" } else { "eval" },
        gd.trust_tenths,
        gd.children.len(),
        gd.cur_falling_m,
        gd.cur_hold_m,
        gd.cur_combo,
        gd.cur_btb,
        gd.cur_stack_height,
    );
    for (i, c) in gd.children.iter().enumerate() {
        print_child((gd.depth - 1) as usize, i, c);
    }
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut t = Tok { it: s.split_whitespace() };
    let mode = t.it.next().unwrap();
    let mut input = read_input(&mut t);
    let ew = we();
    let root = build_root(&input.probe);
    let weight_index = transition_weight(&root.board, 0, true);
    input.probe.weight_index = weight_index;

    if mode == "trace" || mode == "trace_std" {
        let mut state = default_search_state();
        let out = run_search(
            &mut state,
            &root,
            &[ew],
            true,
            false,
            input.probe.view_next,
            &|| 0.0,
            Some(i32::MAX),
            input.allow_hold,
        )
        .unwrap();
        let mut state2 = default_search_state();
        let select_mode = if mode == "trace_std" { 1 } else { 0 };
        let tr = search_trace(
            &mut state2,
            &root,
            &[ew],
            true,
            false,
            input.probe.view_next,
            input.allow_hold,
            select_mode,
        )
        .unwrap();
        println!(
            "CANON x={} r={} m={} hold={} score={} depth={} nodes={} y={} srs={}",
            out.first_x,
            out.first_r,
            out.first_m,
            if out.first_hold { 1 } else { 0 },
            out.score,
            out.depth,
            out.node,
            out.first_placement.y,
            out.first_placement.last_srs,
        );
        println!(
            "TRACE x={} r={} m={} hold={} score={} depth={} nodes={}",
            tr.first_x, tr.first_r, tr.first_m, if tr.path[0].hold_used { 1 } else { 0 }, tr.score,
            tr.depth, tr.nodes,
        );
        let same = tr.first_x == out.first_x
            && tr.first_r == out.first_r
            && tr.first_m == out.first_m
            && tr.score == out.score
            && tr.depth == out.depth
            && tr.nodes == out.node;
        println!("TRACE_MATCH {}", if same { 1 } else { 0 });
        let path = tr
            .path
            .iter()
            .map(|p| format!("{}:{}:{}:{}", p.x, ((p.r % 4) + 4) % 4, p.m, p.act))
            .collect::<Vec<_>>()
            .join(",");
        if select_mode == 0 {
            for s in &tr.prune_stats {
                println!(
                    "PRUNE depth={} children={} cap={} keep={} cutoff={} atCutoff={} keptAtCutoff={} distinct={}",
                    s.depth, s.num_children, s.cap, s.next_beam, s.cutoff_score, s.at_cutoff,
                    s.kept_at_cutoff, s.distinct_scores,
                );
            }
        }
        println!("PATH {path}");
        return;
    }

    if mode == "eval" {
        let path_len = t.usize();
        let mut path = Vec::with_capacity(path_len);
        for _ in 0..path_len {
            let x = t.i32();
            let r = t.i32();
            let m = t.i32();
            let act = t.i32();
            path.push((x, r, m, act));
        }
        println!("WEIGHT weightIndex={weight_index}");
        let gens = eval_walk_probe(
            &input.probe,
            &ew,
            weight_index,
            true,
            false,
            input.allow_hold,
            1,
            &path,
        );
        for g in &gens {
            print_gen(g);
        }
        return;
    }

    if mode == "eval_bfs" {
        println!("WEIGHT weightIndex={weight_index}");
        let gens = eval_bfs_probe(&input.probe, &ew, weight_index, true, false, input.allow_hold);
        let root = gens.first();
        if let Some(g0) = root {
            print_gen(g0);
        }
        for (p, gd) in gens.iter().enumerate().skip(1) {
            println!(
                "B {} depth={} trust={} count={} curFallM={} curHoldM={} curCombo={} curBtb={} curStack={}",
                p - 1,
                gd.depth,
                gd.trust_tenths,
                gd.children.len(),
                gd.cur_falling_m,
                gd.cur_hold_m,
                gd.cur_combo,
                gd.cur_btb,
                gd.cur_stack_height,
            );
            for (i, c) in gd.children.iter().enumerate() {
                print_child_labeled("EB", p - 1, i, c);
            }
        }
        return;
    }

    panic!("unknown mode {mode}");
}
