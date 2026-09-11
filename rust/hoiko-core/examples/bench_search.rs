use std::time::Instant;
use hoiko_core::probe::{build_root, ProbeInput};
use hoiko_core::search::{run_search, default_search_state};
use hoiko_core::weights::HoikoWeights;

pub fn we() -> HoikoWeights { HoikoWeights { weight: [-15, -30, -100, -4, -25, -10, -15, -50, -120, -70, 10, 10, 5, 0, 30, 1000, 2, 30, 5, 5, 35, -30, 15, 15, 35, 10, -100, 60, 20, -3, 10, 10, -100, -100, -350, -300, -250, 200, 50, 300, 500, 50, 1500, 50, 0, 250, 50, 0, 0, 0], column: [-50, -70, -10, 0, 0, 0, 0, -10, -70, -50], combo_table: [180, 360, 540, 900, 1080], nexus: 0.5 } }

fn main() {
    let w = vec![we()];
    let reps = 30;
    let mut ms = 0f64; let mut nodes = 0i64;
    for _ in 0..reps {
        let root = build_root(&ProbeInput {
            board: vec![0; 32], current: 0, queue: vec![3,4,5,6,1,2,0,3,4,5,6,1,2],
            hold: 7, combo: 0, btb: 0, view_next: 2, weight_index: 0, is_even: true, use_s4w: false, trust_rate: 1.0,
        });
        let mut st = default_search_state();
        let t = Instant::now();
        let out = run_search(&mut st, &root, &w, true, false, 2, &|| 0.0, Some(i32::MAX), true).unwrap();
        ms += t.elapsed().as_secs_f64()*1000.0; nodes += out.node as i64;
    }
    println!("NATIVE RUST: {:.1}ms/move, {:.0} nodes/move, {:.0}k nodes/s, depth14",
        ms/reps as f64, nodes as f64/reps as f64, (nodes as f64)/(ms/1000.0)/1000.0);
}
