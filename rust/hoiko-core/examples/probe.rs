//! Differential probe binary: reads weights + cases from stdin (whitespace
//! tokens) and prints the same canonical lines the TS harness produces.

use std::io::Read;

use hoiko_core::probe::{evaluate_probe, expand_probe, ProbeInput};
use hoiko_core::weights::HoikoWeights;

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
    fn f64(&mut self) -> f64 {
        self.it.next().unwrap().parse().unwrap()
    }
    fn bool(&mut self) -> bool {
        self.i32() != 0
    }
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut t = Tok { it: s.split_whitespace() };

    let mut weight = [0i32; 50];
    for v in weight.iter_mut() {
        *v = t.i32();
    }
    let mut column = [0i32; 10];
    for v in column.iter_mut() {
        *v = t.i32();
    }
    let mut combo_table = [0i32; 5];
    for v in combo_table.iter_mut() {
        *v = t.i32();
    }
    let nexus = t.f64();
    let ew = HoikoWeights { weight, column, combo_table, nexus };

    let cases = t.usize();
    let mut out = String::new();
    for _ in 0..cases {
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
        let weight_index = t.i32();
        let is_even = t.bool();
        let use_s4w = t.bool();
        let trust_rate = t.f64();
        let allow_hold = t.bool();

        let input = ProbeInput {
            board,
            current,
            queue,
            hold,
            combo,
            btb,
            view_next,
            weight_index,
            is_even,
            use_s4w,
            trust_rate,
        };
        let ev = evaluate_probe(&input, &ew);
        let ex = expand_probe(&input, allow_hold);
        out.push_str(&format!(
            "E {} {} {} {} {} {}\n",
            ev.family_score, ev.score, ev.first_family_score, ev.first_score, ex.count, ex.hold_used
        ));
        for c in &ex.children {
            out.push_str(&format!(
                "C {} {} {} {} {}",
                c.placed_x, c.placed_r, c.placed_m, c.act, c.stack_height
            ));
            for row in c.board.iter() {
                out.push(' ');
                out.push_str(&row.to_string());
            }
            out.push('\n');
        }
    }
    print!("{out}");
}
