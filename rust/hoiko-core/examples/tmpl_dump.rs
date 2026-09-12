//! TemplateAI control-plane probe: read one synthetic state, run the pure
//! decision functions in the same order as the oracle's `tmpl=1` probe, print
//! the results (used by `tools/hoiko-oracle/diff/tdopeners.ts`).
//!
//! Input (single line, space separated):
//!   lock{x,y,r,m} fall{x,y,r,m} hold bagRemains viewNext useTd loopTemplate
//!   opType opDropCount prevOpDropCount lockX lockY lockR lockM
//!   <32 board rows> <7 next pieces>
//! Board rows are written directly (native bit order, row 0 = bottom).

use std::cell::RefCell;
use std::io::Read;
use std::rc::Rc;

use hoiko_core::gamepack::GamePack;
use hoiko_core::nextmino::NextMino;
use hoiko_core::template_ai::TemplateAi;

fn main() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("stdin");
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let t: Vec<i64> = line.split_whitespace().map(|x| x.parse().expect("int")).collect();
        let mut i = 0;
        let mut next_i = || {
            let v = t[i];
            i += 1;
            v as i32
        };
        let (lx, ly, lr, lm) = (next_i(), next_i(), next_i(), next_i());
        let (fx, fy, fr, fm) = (next_i(), next_i(), next_i(), next_i());
        let hold = next_i();
        let bag_remains = next_i();
        let view_next = next_i();
        let use_td = next_i() != 0;
        let loop_template = next_i() != 0;
        let op_type = next_i();
        let op_drop_count = next_i();
        let prev_op_drop_count = next_i();
        let mut rows = [0i32; 32];
        for r in rows.iter_mut() {
            *r = next_i();
        }
        let mut queue = Vec::new();
        for _ in 0..7 {
            queue.push(next_i());
        }

        let next = Rc::new(RefCell::new(NextMino::default()));
        next.borrow_mut().view_next = view_next;
        next.borrow_mut().init(&queue);
        if bag_remains >= 0 {
            next.borrow_mut().bag_remains = bag_remains;
        }
        let mut g = GamePack::default();
        g.next_it.set_source(&next);
        g.board.line = rows;
        g.hold.m = hold;
        g.locked_mino.x = lx;
        g.locked_mino.y = ly;
        g.locked_mino.r = lr;
        g.locked_mino.m = lm;
        g.falling_mino.x = fx;
        g.falling_mino.y = fy;
        g.falling_mino.r = fr;
        g.falling_mino.m = fm;

        let mut t = TemplateAi {
            use_td_openers: use_td,
            use_template: use_td,
            op_type,
            op_drop_count,
            prev_op_drop_count,
            ..TemplateAi::default()
        };
        t.loop_template = loop_template;

        let cmp = TemplateAi::td_openers_cmp(&g);
        println!("TDCMP={cmp}");
        let origin = TemplateAi::origin_next_cmp(&g);
        println!("ORIGIN={}", if origin { 1 } else { 0 });
        let dt = t.decision_template(&g);
        println!(
            "DT={} opType={} opDropCount={} prev={}",
            if dt { 1 } else { 0 },
            t.op_type,
            t.op_drop_count,
            t.prev_op_drop_count
        );
        let dtl = t.decision_loop_template(&mut g, bag_remains);
        println!(
            "DTL={} opType={} opDropCount={} prev={} btb={}",
            if dtl { 1 } else { 0 },
            t.op_type,
            t.op_drop_count,
            t.prev_op_drop_count,
            g.btb
        );
    }
}
