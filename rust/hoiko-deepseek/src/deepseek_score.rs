use crate::board::{Board, COLS, ROWS};

pub fn ds_heights(after: &Board) -> [f64; COLS] {
    let mut h = [0f64; COLS];
    for x in 0..COLS {
        for y in (0..ROWS).rev() {
            if (after[y] & (1u16 << x)) != 0 {
                h[x] = (y + 1) as f64;
                break;
            }
        }
    }
    h
}

#[derive(Clone, Copy, Debug)]
pub struct DsWell {
    pub col: usize,
    pub depth: usize,
    pub max_ex_well: f64,
    pub global_max: f64,
    pub edge: bool,
}

pub fn ds_well(after: &Board, h: &[f64; COLS], cap: usize) -> DsWell {
    let mut col = 0usize;
    let mut best = h[0];
    for x in 1..COLS {
        let v = h[x];
        if v < best || (v == best && (x == 0 || x == COLS - 1)) {
            best = v;
            col = x;
        }
    }
    let mut depth = 0usize;
    while depth < cap && depth < ROWS {
        let y = depth;
        if (after[y] & (1u16 << col)) != 0 {
            break;
        }
        let mut filled = true;
        for x in 0..COLS {
            if x == col {
                continue;
            }
            if (after[y] & (1u16 << x)) == 0 {
                filled = false;
                break;
            }
        }
        if !filled {
            break;
        }
        depth += 1;
    }
    let mut max_ex = 0f64;
    for x in 0..COLS {
        if x == col {
            continue;
        }
        if h[x] > max_ex {
            max_ex = h[x];
        }
    }
    let mut global = 0f64;
    for v in h {
        if *v > global {
            global = *v;
        }
    }
    DsWell {
        col,
        depth: depth.min(cap),
        max_ex_well: max_ex,
        global_max: global,
        edge: col == 0 || col == COLS - 1,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct DsFloatWell {
    pub col: usize,
    pub depth: usize,
    pub edge: bool,
}

pub fn ds_float_well(h: &[f64; COLS], cap: usize) -> DsFloatWell {
    let mut col = 0usize;
    let mut best = 0usize;
    for x in 0..COLS {
        let left = if x == 0 { f64::INFINITY } else { h[x - 1] };
        let right = if x == COLS - 1 {
            f64::INFINITY
        } else {
            h[x + 1]
        };
        let raw = left.min(right) - h[x];
        let depth = raw.max(0.0).min(cap as f64) as usize;
        if depth > best || (depth == best && depth > 0 && (x == 0 || x == COLS - 1)) {
            best = depth;
            col = x;
        }
    }
    DsFloatWell {
        col,
        depth: best,
        edge: col == 0 || col == COLS - 1,
    }
}

pub fn ds_bump_ex_well(h: &[f64; COLS], well: usize) -> f64 {
    let mut bump = 0f64;
    let mut prev = -1f64;
    for x in 0..COLS {
        if x == well {
            continue;
        }
        let v = h[x];
        if prev >= 0.0 {
            bump += (v - prev).abs();
        }
        prev = v;
    }
    bump
}

pub fn ds_count_tslots(after: &Board, cap: usize) -> usize {
    let mut n = 0usize;
    let top = (ROWS - 1).min(14);
    for y in 1..=top {
        for x in 0..COLS {
            if (after[y] & (1u16 << x)) != 0 {
                continue;
            }
            if (after[y - 1] & (1u16 << x)) == 0 {
                continue;
            }
            let l = x == 0 || (after[y] & (1u16 << (x - 1))) != 0;
            let r = x == COLS - 1 || (after[y] & (1u16 << (x + 1))) != 0;
            let u = y + 1 >= ROWS || (after[y + 1] & (1u16 << x)) != 0;
            if (l as usize) + (r as usize) + (u as usize) >= 2 {
                n += 1;
                if n >= cap {
                    return n;
                }
            }
        }
    }
    n
}

pub fn ds_count_holes(after: &Board, h: &[f64; COLS]) -> u32 {
    let mut n = 0u32;
    for x in 0..COLS {
        let top = h[x] as usize;
        for y in 0..top.min(ROWS) {
            if (after[y] & (1u16 << x)) == 0 {
                n += 1;
            }
        }
    }
    n
}

pub fn ds_capped(after: &Board, h: &[f64; COLS]) -> u32 {
    let mut n = 0u32;
    for x in 0..COLS {
        let top = h[x] as usize;
        let mut y = 1usize;
        while y < top && y < ROWS - 1 {
            if (after[y] & (1u16 << x)) == 0
                && (after[y + 1] & (1u16 << x)) != 0
                && (after[y - 1] & (1u16 << x)) != 0
            {
                n += 1;
            }
            y += 1;
        }
    }
    n
}

pub fn ds_high(after: &Board) -> u32 {
    let mut n = 0u32;
    for y in 14..ROWS {
        n += (after[y] as u32).count_ones();
    }
    n
}

pub fn ds_emergency(pending: i32, max_h: f64) -> u8 {
    if pending >= 9 || max_h >= 16.0 {
        return 2;
    }
    if pending >= 4 || max_h >= 11.0 {
        return 1;
    }
    0
}

pub fn ds_veto(after: &Board, lines: u32, pending: i32, tspin: bool) -> bool {
    let h = ds_heights(after);
    if tspin && lines > 0 {
        let holes = ds_count_holes(after, &h);
        let mut global = 0f64;
        for v in &h {
            if *v > global {
                global = *v;
            }
        }
        if holes >= 10 && global >= 14.0 && pending > 0 {
            return true;
        }
        if holes >= 12 && global >= 15.0 {
            return true;
        }
    }
    if lines > 0 {
        return false;
    }
    if pending > 0 {
        return false;
    }
    let well = ds_well(after, &h, 6);
    let ceil = if pending > 0 { 16.0 } else { 18.0 };
    if well.global_max < ceil {
        return false;
    }
    if well.edge && well.depth >= 4 && well.max_ex_well <= 14.0 {
        return false;
    }
    true
}

pub fn ds_height_pressure(max_h: f64) -> f64 {
    if max_h >= 16.0 {
        return (max_h - 15.0) * 500.0;
    }
    if max_h >= 11.0 {
        return (max_h - 10.0) * 150.0;
    }
    0.0
}

pub fn ds_gamma(ply: i32) -> f64 {
    if ply <= 1 {
        return 1.0;
    }
    if ply == 2 {
        return 0.55;
    }
    0.3
}
