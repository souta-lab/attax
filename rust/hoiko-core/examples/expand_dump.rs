//! Expand dump for the exe expand differential: one position on stdin
//! (whitespace tokens), one child list on stdout, replica order.
//!
//!   board_len rows... current queue_len queue... hold combo btb view_next allow_hold
//!
//! `tuck` mode classifies a single placement against a board:
//!
//!   tuck m r x y board_len rows...

use std::io::Read;

use hoiko_core::evaluate::VsFlags;
use hoiko_core::probe::{build_root, expand_dump_probe, tuck_probe, ProbeInput};

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_whitespace();
    let first = it.next().unwrap();

    if first == "tuck" {
        let m = it.next().unwrap().parse::<i32>().unwrap();
        let r = it.next().unwrap().parse::<i32>().unwrap();
        let x = it.next().unwrap().parse::<i32>().unwrap();
        let y = it.next().unwrap().parse::<i32>().unwrap();
        let board_len = it.next().unwrap().parse::<usize>().unwrap();
        let mut board = Vec::with_capacity(board_len);
        for _ in 0..board_len {
            board.push(it.next().unwrap().parse::<i32>().unwrap());
        }
        println!("T {}", if tuck_probe(&board, m, r, x, y) { 1 } else { 0 });
        return;
    }

    let board_len = first.parse::<usize>().unwrap();
    let mut board = Vec::with_capacity(board_len);
    for _ in 0..board_len {
        board.push(it.next().unwrap().parse::<i32>().unwrap());
    }
    let current = it.next().unwrap().parse::<i32>().unwrap();
    let queue_len = it.next().unwrap().parse::<usize>().unwrap();
    let mut queue = Vec::with_capacity(queue_len);
    for _ in 0..queue_len {
        queue.push(it.next().unwrap().parse::<i32>().unwrap());
    }
    let hold = it.next().unwrap().parse::<i32>().unwrap();
    let combo = it.next().unwrap().parse::<i32>().unwrap();
    let btb = it.next().unwrap().parse::<i32>().unwrap();
    let view_next = it.next().unwrap().parse::<i32>().unwrap();
    let allow_hold = it.next().unwrap().parse::<i32>().unwrap() != 0;

    let input = ProbeInput {
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
        use_pcstack: false,
        vs: VsFlags::default(),
        trust_rate: 1.0,
    };
    let spawn_y = build_root(&input).falling_mino.y;
    let children = expand_dump_probe(&input, allow_hold);
    let hold_used = children.iter().filter(|c| c.hold_used).count();

    let mut out = String::new();
    out.push_str(&format!("S {spawn_y}\n"));
    out.push_str(&format!("N {} {}\n", children.len(), hold_used));
    for c in &children {
        out.push_str(&format!(
            "C {} {} {} {} {} {} {} {} {} {} {} {}",
            if c.hold_used { 1 } else { 0 },
            if c.tuck { 1 } else { 0 },
            c.placed_x,
            c.placed_r,
            c.placed_m,
            c.act,
            c.stack_height,
            c.move_delay,
            c.falling_m,
            c.hold_m,
            c.combo,
            c.btb,
        ));
        for row in c.board.iter() {
            out.push(' ');
            out.push_str(&row.to_string());
        }
        out.push('\n');
    }
    print!("{out}");
}
