//! `ExpandAI.ExpandTemplateNode` + the three const child tables — faithful port
//! of `src/ai/native/expand-template.ts` (SPEC_ExpandAI §7).

use crate::baby::Baby;
use crate::shapes::MinoType;

struct TemplateEntry {
    cmds: &'static str,
    delay: i32,
    x: i32,
    r: i32,
}

const fn e(cmds: &'static str, delay: i32, x: i32, r: i32) -> TemplateEntry {
    TemplateEntry { cmds, delay, x, r }
}

const CHILD_I: &[TemplateEntry] = &[
    e("lll", 90, 0, 0),
    e("ll", 60, 1, 0),
    e("l", 30, 2, 0),
    e("r", 30, 4, 0),
    e("rr", 60, 5, 0),
    e("rrr", 90, 6, 0),
    e("lllall", 150, -2, 1),
    e("lllal", 120, -1, 1),
    e("llla", 90, 0, 1),
    e("lla", 60, 1, 1),
    e("la", 30, 2, 1),
    e("a", 0, 3, 1),
    e("ra", 30, 4, 1),
    e("rra", 60, 5, 1),
    e("rrra", 90, 6, 1),
    e("rrrar", 120, 7, 1),
    e("lllbl", 120, -1, 3),
    e("lllb", 90, 0, 3),
    e("llb", 60, 1, 3),
    e("lb", 30, 2, 3),
    e("b", 0, 3, 3),
    e("rb", 30, 4, 3),
    e("rrb", 60, 5, 3),
    e("rrrb", 90, 6, 3),
    e("rrrbr", 120, 7, 3),
    e("rrrbrr", 150, 8, 3),
    e("llblb", 90, 0, 2),
    e("lblb", 60, 1, 2),
    e("blb", 32, 2, 2),
    e("bb", 32, 3, 2),
    e("ara", 32, 4, 2),
    e("rara", 60, 5, 2),
    e("rrara", 90, 6, 2),
];

const CHILD_SZTJL: &[TemplateEntry] = &[
    e("lll", 90, 0, 0),
    e("ll", 60, 1, 0),
    e("l", 30, 2, 0),
    e("r", 30, 4, 0),
    e("rr", 60, 5, 0),
    e("rrr", 90, 6, 0),
    e("rrrr", 120, 7, 0),
    e("lllal", 120, -1, 1),
    e("llla", 90, 0, 1),
    e("lla", 60, 1, 1),
    e("la", 30, 2, 1),
    e("a", 0, 3, 1),
    e("ra", 30, 4, 1),
    e("rra", 60, 5, 1),
    e("rrra", 90, 6, 1),
    e("rrrar", 120, 7, 1),
    e("lllb", 90, 0, 3),
    e("llb", 60, 1, 3),
    e("lb", 30, 2, 3),
    e("b", 0, 3, 3),
    e("rb", 30, 4, 3),
    e("rrb", 60, 5, 3),
    e("rrrb", 90, 6, 3),
    e("rrrrb", 120, 7, 3),
    e("rrrrbr", 150, 8, 3),
    e("llblb", 90, 0, 2),
    e("lblb", 60, 1, 2),
    e("blb", 32, 2, 2),
    e("bb", 32, 3, 2),
    e("ara", 32, 4, 2),
    e("rara", 60, 5, 2),
    e("rrara", 90, 6, 2),
    e("rrrara", 120, 7, 2),
];

const CHILD_O: &[TemplateEntry] = &[
    e("llll", 120, -1, 0),
    e("lll", 90, 0, 0),
    e("ll", 60, 1, 0),
    e("l", 30, 2, 0),
    e("r", 30, 4, 0),
    e("rr", 60, 5, 0),
    e("rrr", 90, 6, 0),
    e("rrrr", 120, 7, 0),
];

fn table_for(m: MinoType) -> &'static [TemplateEntry] {
    if m == 3 {
        CHILD_O
    } else if m == 0 {
        CHILD_I
    } else {
        CHILD_SZTJL
    }
}

/// `ExpandTemplateNode` (IL 14872); appends `babies[1..entries]`, returns
/// `entries + 1`.
pub fn expand_template_node(babies: &mut Vec<Baby>, root: &Baby) -> i32 {
    let table = table_for(root.falling_mino.m);
    let num = table.len() as i32 + 1;
    let inherit = root.hold.swapped_hold != 0;
    for entry in table {
        let mut dst = Baby::default();
        dst.hold = root.hold;
        dst.falling_mino.m = root.falling_mino.m;
        dst.falling_mino.y = root.falling_mino.y;
        dst.falling_mino.x = entry.x;
        dst.falling_mino.r = entry.r;
        dst.falling_mino.last_srs = 0;
        dst.falling_mino.bug_gravity = 0;
        dst.next = root.next;
        if !inherit {
            dst.commands.init();
            dst.commands.move_delay = entry.delay;
        } else {
            dst.commands = root.commands;
            dst.commands.move_delay += entry.delay;
        }
        dst.commands.add_commands(entry.cmds);
        babies.push(dst);
    }
    num
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::baby::Baby;
    use crate::shapes::{MINO_I, MINO_NONE, MINO_O, MINO_T};

    fn root_baby(m: i32) -> Baby {
        let mut root = Baby::default();
        root.falling_mino.m = m;
        root.falling_mino.y = 20;
        root.falling_mino.x = 3;
        root.falling_mino.r = 0;
        root.hold.m = MINO_NONE;
        root
    }

    #[test]
    fn i_table() {
        let root = root_baby(MINO_I);
        let mut babies = vec![root.clone()];
        assert_eq!(expand_template_node(&mut babies, &root), 34);
        assert_eq!(babies.len(), 34);
        assert_eq!(babies[1].falling_mino.x, 0);
        assert_eq!(babies[1].falling_mino.r, 0);
        assert_eq!(babies[1].commands.move_delay, 90);
        assert_eq!(babies[7].falling_mino.x, -2);
        assert_eq!(babies[7].falling_mino.r, 1);
        assert_eq!(babies[7].commands.move_delay, 150);
    }

    #[test]
    fn o_table() {
        let root = root_baby(MINO_O);
        let mut babies = vec![root.clone()];
        assert_eq!(expand_template_node(&mut babies, &root), 9);
        assert_eq!(babies.len(), 9);
        assert_eq!(babies[1].falling_mino.x, -1);
        assert_eq!(babies[7].falling_mino.x, 6);
    }

    #[test]
    fn sztjl_table() {
        let root = root_baby(MINO_T);
        let mut babies = vec![root.clone()];
        assert_eq!(expand_template_node(&mut babies, &root), 34);
        assert_eq!(babies[1].falling_mino.x, 0);
        assert_eq!(babies[7].falling_mino.x, 7);
    }
}
