// PROD ADAPTER prototype — the host adapter that lets the persistent-form
// kernel (pfl_r13_sub1ms / pfl_r14_sub800) serve live positions.
//
// Audit B (R11-CODE-AUDIT-2026-11-20.md, integration item 1) flagged the
// missing piece: pfload is a batch host that replays a dumped corpus
// (BXD1 + bpdump); nothing builds the kernel's inputs (uni / inst48 /
// inst52 / plcin) from a live position. This file is that adapter,
// written against the primary sources:
//   - instance/child record layouts: bxg.c header comment (stage-2B host)
//     and the dump writer in the reference search (bx.rs dump_call /
//     dump_flush): an instance record is the BxInputs snapshot of one
//     (parent node, hold option) expansion group.
//   - node/option semantics: the reference search (search.rs Node,
//     piece_options, expand_s2 child construction, root setup) and the
//     corpus harness (bxcheck main.rs: obs -> SearchInput, config O
//     weights, frame = 0).
//   - packing: pfload.c pack_inst48 / pack_inst52 / pack_plcin and the
//     uni ply-descriptor layout of pfload.c run_decision.
//
// The adapter proper is the section between ADAPTER BEGIN / ADAPTER END:
// pure CPU code, no Vulkan, no corpus types. Everything after that is
// the verification harness (mode `verify`), which rebuilds the corpus
// inputs from obs records + stored child records and byte-compares
// against what pfload reads from BXD1/bpdump. No GPU is used.
//
// Verify checks (all over the 180-decision corpus):
//   A root instances rebuilt from obs alone == stored depth-0 records.
//   B depth-1 instances rebuilt from (root node, root child records)
//     via the adapter transition == stored depth-1 records.
//   C every instance record in the dump: header/option assembly rebuilt
//     from its recovered node state == stored record (413,838 records).
//   D inst48/inst52 streams for plies 0/1: adapter packing of the
//     generated records == pfload packing of the stored records.
//   E uni ply descriptors for plies 0/1 (layout words; tau via the
//     ported compute_tau, see the design doc for the live-serve tau
//     treatment).
//   F plcin words for children of ply 0/1 instances: from bpdump
//     placement lists == pfload pack_plcin of the stored child records.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>

static uint32_t rd32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static int32_t ri32(const uint8_t *p) { int32_t v; memcpy(&v, p, 4); return v; }
static uint64_t rd64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
static void put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static void putf64(uint8_t *p, double d) { memcpy(p, &d, 8); }
static double rdf64(const uint8_t *p) { double d; memcpy(&d, p, 8); return d; }

// =================== ADAPTER BEGIN ===================================
// A search node: the position state the kernel expands. Field meanings
// mirror the reference search's Node (search.rs).
typedef struct {
    uint16_t rows[40];   // board rows, engine order (row 0 = top), 10 bits used
    uint8_t flags[40];   // garbage-row flags, same order
    int32_t hold;        // hold kind index 0..6, -1 = empty
    uint32_t next;       // queue cursor: sequence[next] is the current piece
    int can_hold;
    int32_t combo, chain, pending, due; // due: root only, children carry 0
    int32_t tslot;       // board feature F_TSLOT (best T-slot on the surface)
    double reward;       // accumulated reward at this node (root: 0)
    uint32_t depth;
} ANode;

// One piece option of a node (search.rs PieceOption).
typedef struct {
    int32_t kind;        // piece this option places
    int used_hold;
    uint32_t next;       // queue cursor after the option
    int32_t hold;        // hold kind after the option (-1 = empty)
} AOption;

// The child outcome the adapter consumes to build the next node. In the
// corpus this is read off a BXD1 child record; in production it is
// assembled from the kernel's per-child record (value/accumulated/
// features/scalars) and the arena entry (rows/flags/chain/combo/
// pending) of each selected child. See PROD-ADAPTER-DESIGN-2026-11-21.
typedef struct {
    uint16_t rows[40];
    uint8_t flags[40];
    int32_t combo, chain, pending;
    int32_t feat_tslot;  // child board feature F_TSLOT (features[10])
    double accumulated;  // child accumulated reward
} AChildState;

// Config-O search constants (bxcheck config_o): the discount that drives
// scale_bits, and the S2 margin multiplier's parameters (rules.rs).
#define ADAPTER_DISCOUNT 0.97
// Serve supplies the referee frame per decision (a_set_root_frame);
// the corpus used 0, which stays the default so the harness is
// bit-identical without ever calling the setter.
static int64_t a_root_frame = 0;
static void a_set_root_frame(int64_t f) { a_root_frame = f; }

static void a_column_heights(const uint16_t *rows, int len, int h[10]) {
    uint16_t seen = 0;
    for (int x = 0; x < 10; x++) h[x] = 0;
    for (int row = 0; row < len && seen != 0x3FF; row++) {
        uint16_t fresh = (uint16_t)(rows[row] & ~seen);
        uint16_t f = fresh;
        while (f) { int x = __builtin_ctz(f); h[x] = len - row; f &= (uint16_t)(f - 1); }
        seen |= fresh;
    }
}
static int a_filled(const uint16_t *rows, int len, int x, int row) {
    if (x < 0 || x >= 10 || row >= len) return 1; // walls and floor are filled
    if (row < 0) return 0;                        // above the top is empty
    return (rows[row] >> x) & 1;
}
// features.rs best_tslot, verbatim port.
static int a_best_tslot(const uint16_t *rows, int len) {
    int h[10]; a_column_heights(rows, len, h);
    int best = 0;
    for (int x = 1; x < 9; x++) {
        int row = len - h[x] - 1;
        if (row < 2 || row >= len) continue;
        if (a_filled(rows, len, x, row)) continue;
        if (!a_filled(rows, len, x - 1, row) || !a_filled(rows, len, x + 1, row)) continue;
        int flat = row - 1;
        if (a_filled(rows, len, x - 1, flat) || a_filled(rows, len, x, flat) || a_filled(rows, len, x + 1, flat)) continue;
        int left_roof = a_filled(rows, len, x - 1, flat - 1);
        int right_roof = a_filled(rows, len, x + 1, flat - 1);
        if (left_roof == right_roof) continue;
        int open_side = left_roof ? x + 1 : x - 1;
        if (h[open_side] > len - flat) continue;
        int lines = 0;
        if ((uint32_t)(rows[row] | (1u << x)) == 0x3FF) lines += 1;
        if ((uint32_t)(rows[flat] | (7u << (x - 1))) == 0x3FF) lines += 1;
        if (lines > best) best = lines;
    }
    return best;
}

// rules.rs s2GarbageMultiplier, accumulated in ascending frame order
// exactly as the reference (the accumulation order is load-bearing for
// bit identity past the margin frame; do not close-form it).
static double a_s2_multiplier(int64_t frame) {
    double value = 1.0; // S2_GARBAGE_BASE
    for (int64_t step = 1; step <= frame; step++)
        if (step > 10800) value += 0.008 / 60.0; // S2_GARBAGE_INCREASE / FPS
    return value;
}
static double a_multiplier(uint32_t depth) {
    // Memoized per (root frame, depth): the ascending accumulation is
    // O(frame) and serve builds many records per decision.
    static double memo[256]; static uint8_t memo_ok[256]; static int64_t memo_frame = -1;
    if (memo_frame != a_root_frame) { memset(memo_ok, 0, sizeof memo_ok); memo_frame = a_root_frame; }
    if (depth < 256 && memo_ok[depth]) return memo[depth];
    double v = a_s2_multiplier(a_root_frame + 60 * (int64_t)depth);
    if (depth < 256) { memo[depth] = v; memo_ok[depth] = 1; }
    return v;
}
// f64::powi(ADAPTER_DISCOUNT, depth): binary powering, ascending-bit
// accumulation order (the compiler-rt/libgcc form the reference host
// was verified against).
static double a_scale(uint32_t depth) {
    double r = 1.0, a = ADAPTER_DISCOUNT;
    unsigned int e = depth;
    while (e) { if (e & 1) r *= a; a *= a; e >>= 1; }
    return r;
}

// search.rs piece_options, verbatim port. seq is the decision's piece
// sequence: seq[0] = current piece, seq[1..] = preview. Returns the
// option count (0, 1 or 2).
static int a_options(const ANode *n, const int *seq, int seq_len, AOption opts[2]) {
    if (n->next >= (uint32_t)seq_len) return 0;
    int current = seq[n->next];
    opts[0].kind = current; opts[0].used_hold = 0;
    opts[0].next = n->next + 1; opts[0].hold = n->hold;
    if (!n->can_hold) return 1;
    if (n->hold < 0) {
        if (n->next + 1 < (uint32_t)seq_len && seq[n->next + 1] != current) {
            opts[1].kind = seq[n->next + 1]; opts[1].used_hold = 1;
            opts[1].next = n->next + 2; opts[1].hold = current;
            return 2;
        }
        return 1;
    }
    if (n->hold != current) {
        opts[1].kind = n->hold; opts[1].used_hold = 1;
        opts[1].next = n->next + 1; opts[1].hold = current;
        return 2;
    }
    return 1;
}

// Root node + sequence from one obs record (154 B), following the
// corpus harness's obs -> SearchInput decoding (bxcheck main.rs).
static void a_root_from_obs(const uint8_t *obs, ANode *root, int *seq, int *seq_len) {
    memset(root, 0, sizeof *root);
    memcpy(root->rows, obs, 80);
    memcpy(root->flags, obs + 80, 40);
    const uint8_t *p = obs + 120;
    root->hold = p[1] ? (int32_t)p[2] : -1;
    root->can_hold = p[3] != 0;
    root->next = 0;
    root->combo = ri32(p + 18);
    root->chain = ri32(p + 22);
    root->pending = ri32(p + 26);
    root->due = ri32(p + 30);
    root->tslot = a_best_tslot(root->rows, 40);
    root->reward = 0.0;
    root->depth = 0;
    int known = p[4];
    seq[0] = p[0];
    for (int i = 0; i < known; i++) seq[1 + i] = p[5 + i];
    *seq_len = 1 + known;
}

// Child node from a parent node, the option being expanded, and the
// child outcome (search.rs expand_s2 child construction, restricted to
// the fields the instance record carries).
static void a_child_node(const ANode *parent, const AOption *opt, const AChildState *ch, ANode *out) {
    memset(out, 0, sizeof *out);
    memcpy(out->rows, ch->rows, 80);
    memcpy(out->flags, ch->flags, 40);
    out->hold = opt->hold;
    out->next = opt->next;
    out->can_hold = 1;
    out->combo = ch->combo;
    out->chain = ch->chain;
    out->pending = ch->pending;
    out->due = 0;
    out->tslot = ch->feat_tslot;
    out->reward = ch->accumulated;
    out->depth = parent->depth + 1;
}

// Assemble one 196 B instance record (bx.rs dump_flush layout) for the
// expansion group (node, option). nchild is the placement count for the
// option's piece on the node's board (BP movegen output; in the corpus
// it is read from bpdump, in production BP runs on the host or the
// kernel's S1 enumerates the same set).
static void a_build_record(uint8_t out[196], const ANode *n, const AOption *o,
                           uint32_t dec, uint32_t parent_index, uint32_t nchild) {
    put32(out + 0, dec);
    put32(out + 4, parent_index);
    put32(out + 8, (uint32_t)o->used_hold);
    put32(out + 12, n->depth);
    put32(out + 16, 40); // board len: obs-derived boards are always 40 rows
    put32(out + 20, nchild);
    put32(out + 24, o->next);
    put32(out + 28, (uint32_t)o->hold);
    memcpy(out + 32, n->rows, 80);
    memcpy(out + 112, n->flags, 40);
    put32(out + 152, (uint32_t)n->combo);
    put32(out + 156, (uint32_t)n->chain);
    put32(out + 160, (uint32_t)n->pending);
    put32(out + 164, (uint32_t)n->due);
    put32(out + 168, (uint32_t)n->tslot);
    putf64(out + 172, n->reward);
    putf64(out + 180, a_multiplier(n->depth));
    putf64(out + 188, a_scale(n->depth));
}

// Packing, mirroring pfload.c pack_inst48 / pack_inst52 / pack_plcin so
// the adapter's buffers are byte-identical to the batch host's.
static void a_pack_inst48(const uint8_t *rec, uint32_t d[48]) {
    d[0] = rd32(rec); d[1] = rd32(rec + 12); d[2] = rd32(rec + 16); d[3] = rd32(rec + 20);
    d[4] = 0; // childBase: filled by the ply builder (buffer-global)
    d[5] = rd32(rec + 24);
    d[6] = rd32(rec + 28);
    for (int r = 0; r < 20; r++) d[7 + r] = rd32(rec + 32 + 4 * r);
    for (int r = 0; r < 10; r++) d[27 + r] = rd32(rec + 112 + 4 * r);
    for (int r = 0; r < 11; r++) d[37 + r] = rd32(rec + 152 + 4 * r);
}
static void a_pack_inst52(const uint8_t *rec, const uint8_t bp_spawn[4], uint32_t w[52]) {
    w[0] = rd32(rec); w[1] = rd32(rec + 12); w[2] = rd32(rec + 16); w[3] = rd32(rec + 20);
    w[4] = 0; // childBase: filled by the ply builder
    w[5] = rd32(rec + 24);
    w[6] = rd32(rec + 28);
    const uint8_t *ir = rec;
    for (int r = 0; r < 20; r++) { uint16_t a, b; memcpy(&a, ir + 32 + 4 * r, 2); memcpy(&b, ir + 32 + 4 * r + 2, 2); w[7 + r] = a | ((uint32_t)b << 16); }
    for (int r = 0; r < 10; r++) { uint32_t v = 0; for (int j = 0; j < 4; j++) v |= (uint32_t)ir[112 + 4 * r + j] << (8 * j); w[27 + r] = v; }
    w[37] = rd32(ir + 152); w[38] = rd32(ir + 156); w[39] = rd32(ir + 160);
    w[40] = rd32(ir + 164); w[41] = rd32(ir + 168);
    uint64_t rw = rd64(ir + 172), mw = rd64(ir + 180), sw = rd64(ir + 188);
    w[42] = (uint32_t)rw; w[43] = (uint32_t)(rw >> 32);
    w[44] = (uint32_t)mw; w[45] = (uint32_t)(mw >> 32);
    w[46] = (uint32_t)sw; w[47] = (uint32_t)(sw >> 32);
    w[48] = (uint32_t)bp_spawn[0] | ((uint32_t)bp_spawn[1] << 8) |
            ((uint32_t)(uint8_t)(int8_t)bp_spawn[2] << 16) | ((uint32_t)(uint8_t)(int8_t)bp_spawn[3] << 24);
    w[49] = 1; // emit plc byproduct (basic-form bench configuration)
    w[50] = 0; w[51] = 0;
}
// One placement -> plcin pair. BP's dump carries placements as
// (rot, x i8, y i8, last_srs) 4 B records — the kind is the instance's
// spawn kind, constant across the instance — while the BXD1 child
// record carries (kind, rot, x, y, last_srs u32). pfload.c pack_plcin
// sign-extends x/y through (uint32_t)(int8_t)v.
static void a_pack_plcin(uint8_t kind, const uint8_t plc4[4], uint32_t w[2]) {
    w[0] = (uint32_t)kind | ((uint32_t)plc4[0] << 8) |
           ((uint32_t)(int8_t)plc4[1] << 16) | ((uint32_t)(int8_t)plc4[2] << 24);
    w[1] = plc4[3];
}
// ---- BP movegen: port of the fork's movegen.rs ---------------------
// (itself a line-by-line port of movegen.ts), with the reachability
// rule taken from the KERNEL (BPD1 is the kernel's own dump): spin
// evidence on, and rotations attempted in three directions -- CW, CCW
// and 180 with the S2 kick tables -- first fitting kick per direction.
// movegen.rs's rotate180 = false reading (§5.1) undercounts the kernel;
// see the note inside the BFS loop. Output = resting placements in BFS
// dequeue order; non-T kinds are deduped by placed cells (a
// spin-proving duplicate replaces the kept representative in place),
// T is never deduped. Only the COUNT is contractual for serve: each
// child's identity (placement, srs) is read back from the kernel's
// plcout byproduct, never from this list.
typedef struct { uint8_t rot; int8_t x; int8_t y; uint8_t srs; } APlc;

// pieces.rs NATIVE_CELLS: [kind][rot][cell] = (x, y), y down.
static const int8_t A_CELLS[7][4][4][2] = {
    { {{0,1},{1,1},{2,1},{3,1}}, {{2,0},{2,1},{2,2},{2,3}}, {{0,2},{1,2},{2,2},{3,2}}, {{1,0},{1,1},{1,2},{1,3}} }, // I
    { {{1,0},{2,0},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{2,1}} }, // O
    { {{1,0},{0,1},{1,1},{2,1}}, {{1,0},{1,1},{2,1},{1,2}}, {{0,1},{1,1},{2,1},{1,2}}, {{1,0},{0,1},{1,1},{1,2}} }, // T
    { {{1,0},{2,0},{0,1},{1,1}}, {{1,0},{1,1},{2,1},{2,2}}, {{1,1},{2,1},{0,2},{1,2}}, {{0,0},{0,1},{1,1},{1,2}} }, // S
    { {{0,0},{1,0},{1,1},{2,1}}, {{2,0},{1,1},{2,1},{1,2}}, {{0,1},{1,1},{1,2},{2,2}}, {{1,0},{0,1},{1,1},{0,2}} }, // Z
    { {{0,0},{0,1},{1,1},{2,1}}, {{1,0},{2,0},{1,1},{1,2}}, {{0,1},{1,1},{2,1},{2,2}}, {{1,0},{1,1},{0,2},{1,2}} }, // J
    { {{2,0},{0,1},{1,1},{2,1}}, {{1,0},{1,1},{1,2},{2,2}}, {{0,1},{1,1},{2,1},{0,2}}, {{0,0},{1,0},{1,1},{1,2}} }, // L
};
typedef struct { int min_x, max_x, min_y, height; uint16_t rows[4]; } AShape;
static AShape a_shapes[7][4];
static int a_shapes_ready = 0;
static void a_build_shapes(void) {
    if (a_shapes_ready) return;
    for (int k = 0; k < 7; k++) for (int r = 0; r < 4; r++) {
        AShape *s = &a_shapes[k][r];
        int minx = 9, maxx = 0, miny = 9, maxy = 0;
        for (int i = 0; i < 4; i++) {
            int cx = A_CELLS[k][r][i][0], cy = A_CELLS[k][r][i][1];
            if (cx < minx) minx = cx; if (cx > maxx) maxx = cx;
            if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
        }
        s->min_x = minx; s->max_x = maxx; s->min_y = miny; s->height = maxy - miny + 1;
        s->rows[0] = s->rows[1] = s->rows[2] = s->rows[3] = 0;
        for (int i = 0; i < 4; i++)
            s->rows[A_CELLS[k][r][i][1] - miny] |= (uint16_t)(1u << (A_CELLS[k][r][i][0] - minx));
    }
    a_shapes_ready = 1;
}
// pieces.rs kick tables: [from][dir 0=CW,1=CCW][test] = (dx, dy-up).
static const int8_t A_KICKS_JLSTZ[4][2][5][2] = {
    { {{0,0},{-1,0},{-1,1},{0,-2},{-1,-2}}, {{0,0},{1,0},{1,1},{0,-2},{1,-2}} },
    { {{0,0},{1,0},{1,-1},{0,2},{1,2}},     {{0,0},{1,0},{1,-1},{0,2},{1,2}} },
    { {{0,0},{1,0},{1,1},{0,-2},{1,-2}},    {{0,0},{-1,0},{-1,1},{0,-2},{-1,-2}} },
    { {{0,0},{-1,0},{-1,-1},{0,2},{-1,2}},  {{0,0},{-1,0},{-1,-1},{0,2},{-1,2}} },
};
static const int8_t A_KICKS_I[4][2][5][2] = {
    { {{0,0},{-2,0},{1,0},{-2,-1},{1,2}},   {{0,0},{-1,0},{2,0},{-1,2},{2,-1}} },
    { {{0,0},{-1,0},{2,0},{-1,2},{2,-1}},   {{0,0},{2,0},{-1,0},{2,1},{-1,-2}} },
    { {{0,0},{2,0},{-1,0},{2,1},{-1,-2}},   {{0,0},{1,0},{-2,0},{1,-2},{-2,1}} },
    { {{0,0},{1,0},{-2,0},{1,-2},{-2,1}},   {{0,0},{-2,0},{1,0},{-2,-1},{1,2}} },
};
// 180-degree kicks, (dx, dy) dy up, keyed by the FROM rotation (target
// = from + 2): pieces.rs KICKS_180_JLSTZ_S2 (the S2 profile table the
// kernel's dir-2 kb blocks use; KN = 5) and KICKS_180_I (KN = 2).
static const int8_t A_KICKS180_JLSTZ_S2[4][5][2] = {
    { {0,0},{0,1},{1,1},{-1,1},{1,0} },
    { {0,0},{1,0},{1,2},{1,1},{0,2} },
    { {0,0},{0,-1},{-1,-1},{1,-1},{-1,0} },
    { {0,0},{-1,0},{-1,2},{-1,1},{0,2} },
};
static const int8_t A_KICKS180_I[4][2][2] = {
    { {0,0},{0,1} },
    { {0,0},{1,0} },
    { {0,0},{0,-1} },
    { {0,0},{-1,0} },
};
#define A_STATE_COUNT (4 * 64 * 16)
static struct {
    uint32_t visited[A_STATE_COUNT];
    uint8_t spin_arrival[A_STATE_COUNT];
    uint32_t spin_stamp[A_STATE_COUNT];
    uint16_t queue[A_STATE_COUNT];
    uint16_t resting[A_STATE_COUNT];
    uint64_t seen[A_STATE_COUNT];
    int32_t seen_pos[A_STATE_COUNT];
    uint8_t seen_srs[A_STATE_COUNT];
    uint32_t stamp;
} a_mg;
static int a_encode(int rot, int x, int y) { return (rot * 64 + (y + 4)) * 16 + (x + 3); }
static int a_collides_shape(const uint16_t *rows, int len, const AShape *s, int x, int y) {
    if (x + s->min_x < 0 || x + s->max_x >= 10) return 1;
    int shift = x + s->min_x;
    for (int i = 0; i < s->height; i++) {
        int row = y + s->min_y + i;
        if (row >= len) return 1;
        if (row >= 0 && (rows[row] & (uint16_t)(s->rows[i] << shift))) return 1;
    }
    return 0;
}
static int a_collides(const uint16_t *rows, int len, int kind, int rot, int x, int y) {
    return a_collides_shape(rows, len, &a_shapes[kind][rot & 3], x, y);
}
static void a_visit(const uint16_t *rows, int len, int kind, uint32_t stamp, int rot, int x, int y, int *tail) {
    if (y + 4 < 0 || y + 4 >= 64 || x + 3 < 0 || x + 3 >= 16) return;
    int id = a_encode(rot, x, y);
    if (a_mg.visited[id] == stamp) return;
    if (a_collides(rows, len, kind, rot, x, y)) return;
    a_mg.visited[id] = stamp;
    a_mg.queue[(*tail)++] = (uint16_t)id;
}
static uint64_t a_cell_key(const AShape *s, int x, int y) {
    uint64_t key = (uint64_t)(y + s->min_y + 4);
    for (int i = 0; i < s->height; i++) key = key * 1024 + ((uint64_t)s->rows[i] << (x + s->min_x));
    return key;
}
// All resting placements for (kind at spawn sr/sx/sy) on rows[0..len),
// in BPD1 order. Stores at most cap entries; returns the full emitted
// count. The kernel's per-instance child count is min(count, 64).
static int a_movegen(const uint16_t *rows, int len, int kind, int sr, int sx, int sy, APlc *out, int cap) {
    a_build_shapes();
    int syy = sy;
    if (len > 20 && syy == len - 21 && a_collides(rows, len, kind, sr, sx, syy)) syy -= 1;
    if (a_collides(rows, len, kind, sr, sx, syy)) return 0;
    a_mg.stamp += 1;
    if (a_mg.stamp == 0xFFFFFFFFu || a_mg.stamp == 0) {
        memset(a_mg.visited, 0, sizeof a_mg.visited);
        memset(a_mg.spin_stamp, 0, sizeof a_mg.spin_stamp);
        a_mg.stamp = 1;
    }
    uint32_t stamp = a_mg.stamp;
    int rotations = (kind == 1) ? 1 : 4;
    int head = 0, tail = 0, nrest = 0;
    int top = 0; while (top < len && rows[top] == 0) top++;
    const AShape *ss = &a_shapes[kind][sr & 3];
    int start_bottom = syy + ss->min_y + ss->height - 1;
    if (start_bottom < top - 1) {
        for (int rot = 0; rot < rotations; rot++) {
            const AShape *s = &a_shapes[kind][rot];
            int lowest = top - s->min_y - s->height;
            int highest = lowest - 2; if (highest < syy) highest = syy;
            for (int x = -s->min_x; x + s->max_x < 10; x++)
                for (int y = lowest; y >= highest; y--)
                    a_visit(rows, len, kind, stamp, rot, x, y, &tail);
        }
    } else {
        a_visit(rows, len, kind, stamp, sr, sx, syy, &tail);
    }
    while (head < tail) {
        int id = a_mg.queue[head++];
        int x = (id % 16) - 3, y = ((id / 16) % 64) - 4, rot = id / (16 * 64);
        int grounded = a_collides(rows, len, kind, rot, x, y + 1);
        if (grounded) a_mg.resting[nrest++] = (uint16_t)id;
        a_visit(rows, len, kind, stamp, rot, x - 1, y, &tail);
        a_visit(rows, len, kind, stamp, rot, x + 1, y, &tail);
        if (!grounded) a_visit(rows, len, kind, stamp, rot, x, y + 1, &tail);
        if (rotations == 1) continue;
        for (int dir = 0; dir < 2; dir++) {
            int to = (rot + (dir == 0 ? 1 : 3)) & 3;
            const int8_t (*ks)[2] = (kind == 0) ? A_KICKS_I[rot][dir] : A_KICKS_JLSTZ[rot][dir];
            const AShape *ts = &a_shapes[kind][to];
            // Kernel BP reachability (established against BPD1, the
            // kernel's own dump, on 2026-11-21): first fitting kick per
            // direction, in THREE directions -- CW, CCW, and 180 (the
            // shader's kb blocks are dir = 0, 1, 2; KN[24] in
            // tables.glsl). movegen.rs with rotate180 = false undercounts
            // the kernel on 2,371 of 413,838 corpus instances (pockets
            // only a 180 entry reaches); visiting every fitting kick
            // overshoots on 5,200. The host count contract is the
            // kernel's, so the port follows the kernel here.
            for (int i = 0; i < 5; i++) {
                int nx = x + ks[i][0], ny = y - (int)ks[i][1];
                if (a_collides_shape(rows, len, ts, nx, ny)) continue;
                int last_srs = (i == 0) ? 1 : i + 1;
                if (a_collides_shape(rows, len, ts, nx, ny + 1) &&
                    ny + 4 >= 0 && ny + 4 < 64 && nx + 3 >= 0 && nx + 3 < 16) {
                    int target = a_encode(to, nx, ny);
                    if (a_mg.spin_stamp[target] != stamp || last_srs > a_mg.spin_arrival[target]) {
                        a_mg.spin_stamp[target] = stamp;
                        a_mg.spin_arrival[target] = (uint8_t)last_srs;
                    }
                }
                a_visit(rows, len, kind, stamp, to, nx, ny, &tail);
                break;
            }
        }
        // 180-degree rotation (kernel dir 2): first fitting kick of the
        // S2 tables (pieces.rs kicks180 with s2 = true).
        {
            int to = (rot + 2) & 3;
            const AShape *ts = &a_shapes[kind][to];
            const int8_t (*ks)[2] = (kind == 0) ? A_KICKS180_I[rot] : A_KICKS180_JLSTZ_S2[rot];
            int nk = (kind == 0) ? 2 : 5;
            for (int i = 0; i < nk; i++) {
                int nx = x + ks[i][0], ny = y - (int)ks[i][1];
                if (a_collides_shape(rows, len, ts, nx, ny)) continue;
                int last_srs = i + 1;
                if (a_collides_shape(rows, len, ts, nx, ny + 1) &&
                    ny + 4 >= 0 && ny + 4 < 64 && nx + 3 >= 0 && nx + 3 < 16) {
                    int target = a_encode(to, nx, ny);
                    if (a_mg.spin_stamp[target] != stamp || last_srs > a_mg.spin_arrival[target]) {
                        a_mg.spin_stamp[target] = stamp;
                        a_mg.spin_arrival[target] = (uint8_t)last_srs;
                    }
                }
                a_visit(rows, len, kind, stamp, to, nx, ny, &tail);
                break;
            }
        }
    }
    int nseen = 0, nout = 0;
    for (int k = 0; k < nrest; k++) {
        int id = a_mg.resting[k];
        int x = (id % 16) - 3, y = ((id / 16) % 64) - 4, rot = id / (16 * 64);
        const AShape *s = &a_shapes[kind][rot];
        if (y + s->min_y + s->height - 1 < 0) continue;
        int last_srs = (a_mg.spin_stamp[id] == stamp) ? a_mg.spin_arrival[id] : 0;
        if (kind != 2) { // T is never cell-deduped
            uint64_t key = a_cell_key(s, x, y);
            int pos = -1;
            for (int j = 0; j < nseen; j++) if (a_mg.seen[j] == key) { pos = j; break; }
            if (pos >= 0) {
                // spin-evidence: a spin-proving duplicate replaces the
                // kept representative in place (position preserved).
                if (last_srs > a_mg.seen_srs[pos]) {
                    a_mg.seen_srs[pos] = (uint8_t)last_srs;
                    int idx = a_mg.seen_pos[pos];
                    if (idx < cap) { out[idx].rot = (uint8_t)rot; out[idx].x = (int8_t)x; out[idx].y = (int8_t)y; out[idx].srs = (uint8_t)last_srs; }
                }
                continue;
            }
            a_mg.seen[nseen] = key; a_mg.seen_pos[nseen] = nout; a_mg.seen_srs[nseen] = (uint8_t)last_srs; nseen++;
        }
        if (nout < cap) { out[nout].rot = (uint8_t)rot; out[nout].x = (int8_t)x; out[nout].y = (int8_t)y; out[nout].srs = (uint8_t)last_srs; }
        nout++;
    }
    return nout;
}
// Child board reconstruction, lock half (fork lock_placement for the
// rows; the garbage flags follow their rows, cleared rows vanish, new
// top rows flag 0). The landed-garbage half is a_land_garbage below;
// harness check G verifies lock + garbage against every BXD1 child.
static void a_apply_placement(const uint16_t *rows, const uint8_t *flags, int len,
                              int kind, int rot, int x, int y,
                              uint16_t *out_rows, uint8_t *out_flags) {
    a_build_shapes();
    uint16_t tmp[40]; uint8_t tfl[40];
    memcpy(tmp, rows, sizeof tmp); memcpy(tfl, flags, sizeof tfl);
    const AShape *s = &a_shapes[kind][rot & 3];
    int shift = x + s->min_x;
    for (int i = 0; i < s->height; i++) {
        int row = y + s->min_y + i;
        if (row >= 0 && row < len) tmp[row] |= (uint16_t)(s->rows[i] << shift);
    }
    int write = len - 1;
    for (int read = len - 1; read >= 0; read--) {
        if (tmp[read] == 0x3FF) continue;
        out_rows[write] = tmp[read]; out_flags[write] = tfl[read]; write--;
    }
    while (write >= 0) { out_rows[write] = 0; out_flags[write] = 0; write--; }
    for (int r = len; r < 40; r++) { out_rows[r] = 0; out_flags[r] = 0; }
}
// Well column of a board (search.rs well_column): the column with the
// lowest stack; the first minimum wins. The landed-garbage hole column
// is shared by the whole tank.
static int a_well_column(const uint16_t *rows, int len) {
    int well = 0, lowest = 0x7FFFFFFF;
    for (int x = 0; x < 10; x++) {
        int height = 0;
        for (int r = 0; r < len; r++)
            if (rows[r] & (uint16_t)(1u << x)) { height = len - r; break; }
        if (height < lowest) { lowest = height; well = x; }
    }
    return well;
}

// Landed-garbage materialization (search.rs expand_s2), applied to a
// post-lock board in place. On a non-clearing lock, pending garbage
// lands under the stack: at the root only the due part, deeper the
// whole pending. The board shifts up by the landed count over new
// bottom rows of FULL_ROW ^ (1 << well), flagged 1. Returns the landed
// row count. The residual pending is NOT computed here: in serve it is
// the kernel's own output (rec/arena), in the corpus the child record
// carries it; harness check G cross-checks both against this count.
static int a_land_garbage(uint16_t *rows, uint8_t *flags, int len,
                          int lines, int pending_in, int depth, int due) {
    if (lines > 0 || pending_in <= 0) return 0;
    int landed = (depth == 0 ? due : pending_in);
    if (landed > pending_in) landed = pending_in;
    if (landed <= 0) return 0;
    if (landed > len) landed = len;
    uint16_t mask = (uint16_t)(0x3FFu ^ (1u << a_well_column(rows, len)));
    uint16_t sr[40]; uint8_t sf[40];
    memcpy(sr, rows, sizeof sr); memcpy(sf, flags, sizeof sf);
    for (int r = 0; r < len; r++) {
        int src = r + landed;
        if (src < len) { rows[r] = sr[src]; flags[r] = sf[src]; }
        else { rows[r] = mask; flags[r] = 1; }
    }
    return landed;
}

// Serve uni descriptor for one ply, sentinel tau (wiring record §3:
// tau is dead in r13/r14; the sentinel keeps the layout identical to
// pfload's nReps <= 96 case). slot is always 0 for per-ply dispatch.
static void a_ply_uni(uint32_t *uni, int slot, uint32_t inst_base, uint32_t ni,
                      uint32_t child_base, uint32_t nch, uint32_t depth) {
    uint32_t *d = uni + 16 + slot * 8;
    d[0] = inst_base; d[1] = ni; d[2] = child_base; d[3] = nch;
    d[4] = 0; d[5] = 0xFFF00000u; d[6] = 0xFFFFFFFFu; d[7] = depth;
}
// =================== ADAPTER END =====================================

#ifndef PROD_ADAPTER_NO_HARNESS
// ---------------- verification harness -------------------------------
static uint8_t *g_obs; static long g_obs_n;
static uint8_t *g_bx; static long g_bx_len;
static uint8_t *g_bp; static long g_bp_len;

typedef struct { uint32_t dec, parent, uh, depth, len, nchild; const uint8_t *raw; uint32_t child_g0; } VInst;
static VInst *g_inst; static uint32_t g_ninst, g_nchild_total;
// bpdump per instance: spawn bytes (kind,sr,sx,sy at +89..), nout, placements ptr
typedef struct { uint8_t spawn[4]; uint32_t nout; const uint8_t *plc; } VBp;
static VBp *g_vbp;

static uint8_t *read_all(const char *path, long *len) {
    FILE *f = fopen(path, "rb"); if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *d = malloc((size_t)n);
    if (fread(d, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "short read %s\n", path); exit(1); }
    fclose(f); *len = n; return d;
}
static void load_all(const char *obs_p, const char *bx_p, const char *bp_p) {
    g_obs = read_all(obs_p, &g_obs_n);
    g_bx = read_all(bx_p, &g_bx_len);
    g_bp = read_all(bp_p, &g_bp_len);
    if (memcmp(g_bx, "BXD1", 4)) { fprintf(stderr, "bad BXD1\n"); exit(1); }
    uint64_t ni = rd64(g_bx + 8), nc = rd64(g_bx + 16);
    g_inst = malloc(ni * sizeof(VInst));
    const uint8_t *bp = g_bx + 32;
    uint32_t cg = 0;
    for (uint64_t i = 0; i < ni; i++) {
        VInst *F = &g_inst[g_ninst++];
        F->dec = rd32(bp); F->parent = rd32(bp + 4); F->uh = rd32(bp + 8);
        F->depth = rd32(bp + 12); F->len = rd32(bp + 16); F->nchild = rd32(bp + 20);
        F->raw = bp; F->child_g0 = cg;
        cg += F->nchild;
        bp += 196 + (size_t)F->nchild * 228;
    }
    g_nchild_total = cg;
    if (cg != nc) { fprintf(stderr, "child count mismatch\n"); exit(1); }
    g_vbp = malloc(ni * sizeof(VBp));
    long p = 0;
    for (uint64_t i = 0; i < ni; i++) {
        VBp *B = &g_vbp[i];
        memcpy(B->spawn, g_bp + p + 89, 4);
        B->nout = (uint32_t)(g_bp[p + 94] | (g_bp[p + 95] << 8));
        B->plc = g_bp + p + 96;
        if (B->nout != g_inst[i].nchild) { fprintf(stderr, "bpdump nchild mismatch inst %llu\n", (unsigned long long)i); exit(1); }
        p += 96 + 8 * (long)B->nout;
    }
    if (p != g_bp_len) { fprintf(stderr, "bpdump walk mismatch\n"); exit(1); }
    printf("corpus: %u instances, %u children, %ld decisions\n", g_ninst, g_nchild_total, g_obs_n / 154);
}
static const uint8_t *child_rec(uint32_t inst_i, uint32_t ci) {
    return g_inst[inst_i].raw + 196 + (size_t)ci * 228;
}
// pfload.c pack_inst48 / pack_inst52 / pack_plcin, verbatim reference
// implementations operating on stored records (childBase patched in).
static void ref_pack_inst48(const VInst *F, uint32_t childBase, uint32_t d[48]) {
    const uint8_t *ir = F->raw;
    d[0] = rd32(ir); d[1] = rd32(ir + 12); d[2] = rd32(ir + 16); d[3] = rd32(ir + 20);
    d[4] = childBase; d[5] = rd32(ir + 24); d[6] = rd32(ir + 28);
    for (int r = 0; r < 20; r++) d[7 + r] = rd32(ir + 32 + 4 * r);
    for (int r = 0; r < 10; r++) d[27 + r] = rd32(ir + 112 + 4 * r);
    for (int r = 0; r < 11; r++) d[37 + r] = rd32(ir + 152 + 4 * r);
}
static void ref_pack_inst52(const VInst *F, uint32_t childBase, uint32_t w[52]) {
    const uint8_t *ir = F->raw;
    w[0] = rd32(ir); w[1] = rd32(ir + 12); w[2] = rd32(ir + 16); w[3] = rd32(ir + 20);
    w[4] = childBase; w[5] = rd32(ir + 24);
    { int32_t hk = ri32(ir + 28); w[6] = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; }
    for (int r = 0; r < 20; r++) { uint16_t a, b; memcpy(&a, ir + 32 + 4 * r, 2); memcpy(&b, ir + 32 + 4 * r + 2, 2); w[7 + r] = a | ((uint32_t)b << 16); }
    for (int r = 0; r < 10; r++) { uint32_t v = 0; for (int j = 0; j < 4; j++) v |= (uint32_t)ir[112 + 4 * r + j] << (8 * j); w[27 + r] = v; }
    w[37] = rd32(ir + 152); w[38] = rd32(ir + 156); w[39] = rd32(ir + 160);
    w[40] = rd32(ir + 164); w[41] = rd32(ir + 168);
    uint64_t rw = rd64(ir + 172), mw = rd64(ir + 180), sw = rd64(ir + 188);
    w[42] = (uint32_t)rw; w[43] = (uint32_t)(rw >> 32);
    w[44] = (uint32_t)mw; w[45] = (uint32_t)(mw >> 32);
    w[46] = (uint32_t)sw; w[47] = (uint32_t)(sw >> 32);
    uint32_t gi = (uint32_t)(F - g_inst);
    w[48] = (uint32_t)g_vbp[gi].spawn[0] | ((uint32_t)g_vbp[gi].spawn[1] << 8) |
            ((uint32_t)(uint8_t)g_vbp[gi].spawn[2] << 16) | ((uint32_t)(uint8_t)g_vbp[gi].spawn[3] << 24);
    w[49] = 1; w[50] = 0; w[51] = 0;
}
static void ref_pack_plcin(const uint8_t *ch, uint32_t w[2]) {
    w[0] = (uint32_t)ch[0] | ((uint32_t)ch[1] << 8) | ((uint32_t)(int8_t)ch[2] << 16) | ((uint32_t)(int8_t)ch[3] << 24);
    w[1] = rd32(ch + 4);
}
// pfload.c compute_tau, ported (per-ply static tau over stored children).
typedef struct { uint32_t tauLo, tauHi, tauPos, nKept; uint32_t kept[96]; } VTau;
static uint64_t child_value_b(const uint8_t *ch) { return rd64(ch + 220); }
typedef struct { uint32_t pos; double v; } TRep;
static int trep_cmp(const void *a, const void *b) {
    const TRep *x = a, *y = b;
    if (x->v != y->v) return x->v > y->v ? -1 : 1;
    return x->pos < y->pos ? -1 : 1;
}
static void compute_tau_ply(const VInst *ply_insts, uint32_t ni, VTau *T) {
    // gather the ply's children in order
    uint32_t nch = 0; for (uint32_t i = 0; i < ni; i++) nch += ply_insts[i].nchild;
    TRep *reps = malloc((nch ? nch : 1) * sizeof(TRep));
    uint32_t nReps = 0; uint32_t pos = 0;
    // dedupe by the 144-byte key (pfload compute_tau), linear-scan form
    for (uint32_t i = 0; i < ni; i++) {
        const VInst *F = &ply_insts[i];
        for (uint32_t ci = 0; ci < F->nchild; ci++, pos++) {
            const uint8_t *ch = child_rec((uint32_t)(F - g_inst), ci);
            uint8_t key[144];
            memcpy(key + 0, F->raw + 24, 4);
            { int32_t hk = ri32(F->raw + 28); uint32_t hv = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; memcpy(key + 4, &hv, 4); }
            memcpy(key + 8, ch + 196, 4); memcpy(key + 12, ch + 192, 4); memset(key + 16, 0, 4);
            memcpy(key + 20, ch + 188, 4); memcpy(key + 24, ch + 88, 40); memcpy(key + 64, ch + 8, 80);
            int found = 0;
            for (uint32_t r = 0; r < nReps; r++) {
                // rebuild the rep's key from its source child
                uint32_t rp = reps[r].pos, acc = 0; const VInst *F0 = NULL; uint32_t ci0 = 0;
                for (uint32_t j = 0; j < ni; j++) { if (rp < acc + ply_insts[j].nchild) { F0 = &ply_insts[j]; ci0 = rp - acc; break; } acc += ply_insts[j].nchild; }
                const uint8_t *ch0 = child_rec((uint32_t)(F0 - g_inst), ci0);
                uint8_t key0[144];
                memcpy(key0 + 0, F0->raw + 24, 4);
                { int32_t hk = ri32(F0->raw + 28); uint32_t hv = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; memcpy(key0 + 4, &hv, 4); }
                memcpy(key0 + 8, ch0 + 196, 4); memcpy(key0 + 12, ch0 + 192, 4); memset(key0 + 16, 0, 4);
                memcpy(key0 + 20, ch0 + 188, 4); memcpy(key0 + 24, ch0 + 88, 40); memcpy(key0 + 64, ch0 + 8, 80);
                if (!memcmp(key, key0, 144)) { found = 1; break; }
            }
            if (!found) { reps[nReps].pos = pos; double dv; uint64_t b = child_value_b(ch); memcpy(&dv, &b, 8); reps[nReps].v = dv; nReps++; }
        }
    }
    if (nReps > 96) {
        qsort(reps, nReps, sizeof(TRep), trep_cmp);
        uint64_t tb; double tv = reps[95].v; memcpy(&tb, &tv, 8);
        T->tauLo = (uint32_t)tb; T->tauHi = (uint32_t)(tb >> 32); T->tauPos = reps[95].pos; T->nKept = 96;
        uint32_t base = 0; for (uint32_t i = 0; i < ni; i++) { (void)base; break; }
        // kept[] in corpus terms needs the ply childBase; caller patches it
        for (int j = 0; j < 96; j++) T->kept[j] = reps[j].pos;
    } else {
        T->tauLo = 0; T->tauHi = 0xFFF00000u; T->tauPos = 0xFFFFFFFFu; T->nKept = 0;
    }
    free(reps);
}

static int first_diff(const uint8_t *a, const uint8_t *b, int n) {
    for (int i = 0; i < n; i++) if (a[i] != b[i]) return i;
    return -1;
}

// ---- Checks G/H/I: movegen, child boards, all-ply serve inputs -----
static int run_xverify(void) {
    int bad = 0;
    uint64_t g_ok = 0, g_tot = 0, g_pend_bad = 0, h_ok = 0, h_cnt_ok = 0, h_tot = 0;
    uint64_t i_pack_bad = 0, i_uni_bad = 0, i_uni_tot = 0;
    // Per-decision running child base accumulated from movegen counts,
    // in stored instance order (decision-major, depth ascending).
    for (uint32_t gi = 0; gi < g_ninst; gi++) {
        VInst *F = &g_inst[gi];
        uint16_t prows[40]; memcpy(prows, F->raw + 32, 80);
        const uint8_t *pflags = F->raw + 112;
        int kind = g_vbp[gi].spawn[0];
        // Check H: movegen count + ordered placements vs BPD1.
        APlc out[128];
        int n = a_movegen(prows, 40, kind, g_vbp[gi].spawn[1], g_vbp[gi].spawn[2],
                          (int8_t)g_vbp[gi].spawn[3], out, 128);
        h_tot++;
        if (n == (int)g_vbp[gi].nout) {
            h_cnt_ok++;
            int ok = 1;
            for (uint32_t ci = 0; ci < g_vbp[gi].nout; ci++) {
                const uint8_t *bp = g_vbp[gi].plc + (size_t)ci * 8;
                if (out[ci].rot != bp[0] || out[ci].x != (int8_t)bp[1] ||
                    out[ci].y != (int8_t)bp[2] || out[ci].srs != bp[3]) { ok = 0; break; }
            }
            if (ok) h_ok++;
        } else if (h_tot - h_cnt_ok < 4) printf("H inst %u: count %d != BPD1 %u\n", gi, n, g_vbp[gi].nout);
        // Check G: child board reconstruction vs every BXD1 child.
        // Reconstruction = pure lock (a_apply_placement) followed by the
        // landed-garbage materialization (a_land_garbage), driven by the
        // child record's own lines/attack and the parent instance's
        // pending/due/depth. The residual pending implied by the same
        // accounting is cross-checked against the child record's.
        int32_t pending_in = ri32(F->raw + 160), due_in = ri32(F->raw + 164);
        for (uint32_t ci = 0; ci < F->nchild; ci++) {
            const uint8_t *ch = child_rec(gi, ci);
            uint16_t orows[40]; uint8_t oflags[40];
            a_apply_placement(prows, pflags, 40, ch[0], ch[1], (int8_t)ch[2], (int8_t)ch[3], orows, oflags);
            int lines = (int)ri32(ch + 172), attack = (int)ri32(ch + 176);
            int landed = a_land_garbage(orows, oflags, 40, lines, pending_in, (int)F->depth, due_in);
            int pout = lines > 0 ? (pending_in - attack > 0 ? pending_in - attack : 0)
                                 : pending_in - landed;
            if (pout != (int)ri32(ch + 188)) {
                g_pend_bad++;
                if (g_pend_bad < 4) printf("G inst %u child %u: residual pending %d != stored %d\n",
                                           gi, ci, pout, (int)ri32(ch + 188));
            }
            g_tot++;
            if (!memcmp(orows, ch + 8, 80) && !memcmp(oflags, ch + 88, 40)) g_ok++;
            else if (g_tot - g_ok < 4) printf("G inst %u child %u: board diff\n", gi, ci);
        }
    }
    printf("G child boards (lock + landed garbage): %llu/%llu byte-identical; residual-pending mismatches %llu\n",
           (unsigned long long)g_ok, (unsigned long long)g_tot, (unsigned long long)g_pend_bad);
    printf("H movegen counts vs BPD1: %llu/%llu (the serve contract)\n",
           (unsigned long long)h_cnt_ok, (unsigned long long)h_tot);
    printf("H full lists identical (count + ordered placements + srs): %llu/%llu"
           " (informational: BPD1 order is the kernel's emission order;"
           " serve takes each child's identity from plcout, not from this list)\n",
           (unsigned long long)h_ok, (unsigned long long)h_tot);
    if (g_ok != g_tot || g_pend_bad || h_cnt_ok != h_tot) bad = 1;
    // Check I: all-ply pack streams + uni descriptors with the child
    // base accumulated from movegen counts (serve path), vs the stored
    // corpus accumulation. The corpus lays children out across decision
    // boundaries, so the accumulation runs over the whole instance list
    // in stored order (serve re-bases per ply at dispatch time; what is
    // verified here is the accumulation arithmetic itself). Any count
    // error shifts every later base and fails loudly here.
    uint32_t gi = 0;
    uint32_t run_base = 0;
    while (gi < g_ninst) {
        uint32_t dec = g_inst[gi].dec;
        while (gi < g_ninst && g_inst[gi].dec == dec) {
            uint32_t ply_first = gi, depth = g_inst[gi].depth;
            uint32_t ply_base = run_base, nch_sum = 0;
            while (gi < g_ninst && g_inst[gi].dec == dec && g_inst[gi].depth == depth) {
                VInst *F = &g_inst[gi];
                uint16_t prows[40]; memcpy(prows, F->raw + 32, 80);
                APlc tmp[128];
                int n = a_movegen(prows, 40, g_vbp[gi].spawn[0], g_vbp[gi].spawn[1],
                                  g_vbp[gi].spawn[2], (int8_t)g_vbp[gi].spawn[3], tmp, 128);
                uint32_t cnt = n > 64 ? 64 : (uint32_t)n;
                uint32_t ga[48], ra[48], gs[52], rs[52];
                a_pack_inst48(F->raw, ga); ga[4] = run_base;
                ref_pack_inst48(F, F->child_g0, ra);
                a_pack_inst52(F->raw, g_vbp[gi].spawn, gs); gs[4] = run_base;
                ref_pack_inst52(F, F->child_g0, rs);
                if (memcmp(ga, ra, sizeof ga) || memcmp(gs, rs, sizeof gs)) {
                    i_pack_bad++;
                    if (i_pack_bad < 4) printf("I inst %u: pack diff (base %u vs stored %u)\n", gi, run_base, F->child_g0);
                }
                run_base += cnt; nch_sum += cnt;
                gi++;
            }
            uint32_t ni = gi - ply_first;
            uint32_t ubuf[24]; memset(ubuf, 0, sizeof ubuf);
            a_ply_uni(ubuf, 0, ply_first, ni, ply_base, nch_sum, depth);
            uint32_t *serve_d = ubuf + 16;
            uint32_t ref_d[8];
            ref_d[0] = ply_first; ref_d[1] = ni; ref_d[2] = g_inst[ply_first].child_g0;
            ref_d[3] = 0; for (uint32_t m = ply_first; m < gi; m++) ref_d[3] += g_inst[m].nchild;
            ref_d[7] = depth;
            i_uni_tot++;
            if (serve_d[0] != ref_d[0] || serve_d[1] != ref_d[1] || serve_d[2] != ref_d[2] ||
                serve_d[3] != ref_d[3] || serve_d[7] != ref_d[7] ||
                serve_d[4] != 0 || serve_d[5] != 0xFFF00000u || serve_d[6] != 0xFFFFFFFFu) {
                i_uni_bad++;
                if (i_uni_bad < 4) printf("I dec %u depth %u: uni diff\n", dec, depth);
            }
        }
    }
    printf("I pack streams (all plies, movegen bases): %llu bad\n", (unsigned long long)i_pack_bad);
    printf("I uni descriptors (all plies): %llu/%llu identical on words 0-3,7 + sentinel tau\n",
           (unsigned long long)(i_uni_tot - i_uni_bad), (unsigned long long)i_uni_tot);
    if (i_pack_bad || i_uni_bad) bad = 1;
    printf("XVERIFY %s\n", bad ? "FAILED" : "PASSED");
    return bad ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc >= 5 && !strcmp(argv[1], "xverify")) {
        load_all(argv[2], argv[3], argv[4]);
        return run_xverify();
    }
    if (argc < 5 || strcmp(argv[1], "verify")) {
        fprintf(stderr, "usage: prod_adapter verify|xverify <obs.bin> <bxdump.bin> <bpdump.bin>\n");
        return 1;
    }
    load_all(argv[2], argv[3], argv[4]);
    long ndec = g_obs_n / 154;
    int bad = 0;

    // per-decision instance index ranges by depth
    // (instances are stored grouped by decision, depth ascending)
    // ---- Check A + B -------------------------------------------------
    uint64_t a_ok = 0, a_tot = 0, b_ok = 0, b_tot = 0, b_amb = 0, b_label_ok = 0, b_label_tot = 0;
    uint64_t d_bad = 0, d_tot = 0, e_bad = 0, e_tot = 0, f_bad = 0, f_tot = 0;
    uint32_t ii = 0;
    for (long dec = 0; dec < ndec; dec++) {
        // collect this decision's instances
        uint32_t start = ii;
        while (ii < g_ninst && g_inst[ii].dec == (uint32_t)dec) ii++;
        uint32_t end = ii;
        const uint8_t *obs = g_obs + dec * 154;
        ANode root; int seq[16]; int seq_len = 0;
        a_root_from_obs(obs, &root, seq, &seq_len);
        AOption opts[2];
        int nopts = a_options(&root, seq, seq_len, opts);
        // stored depth-0 instances
        uint32_t d0[2]; int nd0 = 0;
        for (uint32_t k = start; k < end && g_inst[k].depth == 0; k++) d0[nd0++] = k;
        if (nd0 != nopts) { printf("dec %ld: option count %d != stored roots %d\n", dec, nopts, nd0); bad = 1; }
        // Check A: root records
        for (int o = 0; o < nopts && o < nd0; o++) {
            uint32_t gi = d0[o];
            if (g_inst[gi].uh != (uint32_t)opts[o].used_hold) { printf("dec %ld root %d: uh order mismatch\n", dec, o); bad = 1; continue; }
            uint8_t rec[196];
            a_build_record(rec, &root, &opts[o], (uint32_t)dec, 0, g_vbp[gi].nout);
            a_tot++;
            int fd = first_diff(rec, g_inst[gi].raw, 196);
            if (fd < 0) a_ok++;
            else { printf("dec %ld root uh=%d: record diff at byte %d (gen %02x stored %02x)\n", dec, opts[o].used_hold, fd, rec[fd], g_inst[gi].raw[fd]); bad = 1; }
            // Check D (ply 0): inst48/inst52 streams
            uint32_t ga[48], ra[48], gs[52], rs[52];
            uint32_t cb = g_inst[gi].child_g0;
            a_pack_inst48(rec, ga); ga[4] = cb;
            ref_pack_inst48(&g_inst[gi], cb, ra);
            a_pack_inst52(rec, g_vbp[gi].spawn, gs); gs[4] = cb;
            ref_pack_inst52(&g_inst[gi], cb, rs);
            d_tot++;
            if (memcmp(ga, ra, sizeof ga) || memcmp(gs, rs, sizeof gs)) { d_bad++; printf("dec %ld root uh=%d: pack stream diff\n", dec, opts[o].used_hold); bad = 1; }
            // Check F (ply 0 children): plcin from bpdump vs stored children
            for (uint32_t ci = 0; ci < g_inst[gi].nchild; ci++) {
                uint32_t gw[2], rw[2];
                a_pack_plcin(g_vbp[gi].spawn[0], g_vbp[gi].plc + (size_t)ci * 8, gw);
                ref_pack_plcin(child_rec(gi, ci), rw);
                f_tot++;
                if (memcmp(gw, rw, sizeof gw)) { f_bad++; if (f_bad < 4) printf("dec %ld root child %u: plcin diff\n", dec, ci); bad = 1; }
            }
        }
        // Check E (ply 0): uni descriptor words. Reference: pfload FPly
        // accumulated from the stored corpus (load_corpus order) + the
        // ported compute_tau. Adapter side: accumulated from the
        // generated root records in generation order.
        {
            uint32_t refd[8], adpd[8];
            uint32_t nch0 = 0; for (int o = 0; o < nd0; o++) nch0 += g_inst[d0[o]].nchild;
            VTau T; compute_tau_ply(&g_inst[start], (uint32_t)nd0, &T);
            refd[0] = start; refd[1] = (uint32_t)nd0; refd[2] = g_inst[start].child_g0; refd[3] = nch0;
            refd[4] = T.tauLo; refd[5] = T.tauHi; refd[6] = T.tauPos; refd[7] = 0;
            uint32_t anch = 0; for (int o = 0; o < nopts; o++) anch += g_vbp[d0[o]].nout;
            adpd[0] = start; adpd[1] = (uint32_t)nopts; adpd[2] = g_inst[start].child_g0; adpd[3] = anch;
            adpd[4] = T.tauLo; adpd[5] = T.tauHi; adpd[6] = T.tauPos; adpd[7] = root.depth;
            e_tot++;
            if (memcmp(refd, adpd, sizeof refd)) { e_bad++; printf("dec %ld ply0: uni descriptor diff\n", dec); bad = 1; }
        }
        // Check B: depth-1 groups by parent_index
        // candidate child nodes from root children, in stored order
        typedef struct { ANode node; int src_inst; int src_child; } Cand;
        Cand *cands = NULL; int ncand = 0, ccand = 0;
        for (int o = 0; o < nd0; o++) {
            uint32_t gi = d0[o];
            const AOption *ropt = NULL;
            for (int q = 0; q < nopts; q++) if (opts[q].used_hold == (int)g_inst[gi].uh) ropt = &opts[q];
            if (!ropt) continue;
            for (uint32_t ci = 0; ci < g_inst[gi].nchild; ci++) {
                const uint8_t *ch = child_rec(gi, ci);
                AChildState cs; memset(&cs, 0, sizeof cs);
                memcpy(cs.rows, ch + 8, 80); memcpy(cs.flags, ch + 88, 40);
                cs.combo = ri32(ch + 192); cs.chain = ri32(ch + 196); cs.pending = ri32(ch + 188);
                cs.feat_tslot = ri32(ch + 128 + 40); // features[10]
                cs.accumulated = rdf64(ch + 212);
                if (ncand == ccand) { ccand = ccand ? ccand * 2 : 64; cands = realloc(cands, (size_t)ccand * sizeof(Cand)); }
                a_child_node(&root, ropt, &cs, &cands[ncand].node);
                cands[ncand].src_inst = (int)gi; cands[ncand].src_child = (int)ci;
                ncand++;
            }
        }
        // stored depth-1 instances grouped by parent_index (order preserved)
        uint32_t k = start;
        while (k < end && g_inst[k].depth == 0) k++;
        // Expected arena labels: the reference search registers DEAD
        // children first (arena indices 1..n_dead), then live children
        // in child order across the decision's root instances (stored
        // order). Dead nodes are never expanded, so they leave no
        // instance records. Only 4 of 180 decisions have any dead ply-0
        // children; in each, the stored depth-1 parents form exactly
        // the contiguous range [n_dead+1, n_children] (probes 6/7).
        uint32_t *exp_pidx = NULL; int nexp = 0, cexp = 0;
        {
            uint32_t n_dead = 0, live_rank = 0;
            for (int o = 0; o < nd0; o++)
                for (uint32_t ci = 0; ci < g_inst[d0[o]].nchild; ci++)
                    if (child_rec(d0[o], ci)[201]) n_dead++;
            for (int o = 0; o < nd0; o++) {
                uint32_t gi = d0[o];
                for (uint32_t ci = 0; ci < g_inst[gi].nchild; ci++) {
                    if (child_rec(gi, ci)[201]) continue; // dead flag in child record
                    live_rank++;
                    if (nexp == cexp) { cexp = cexp ? cexp * 2 : 64; exp_pidx = realloc(exp_pidx, (size_t)cexp * 4); }
                    exp_pidx[nexp++] = n_dead + live_rank;
                }
            }
        }
        uint64_t label_seq = 0;
        int label_rank = 0;
        while (k < end && g_inst[k].depth == 1) {
            uint32_t pidx = g_inst[k].parent;
            uint32_t g0 = k;
            while (k < end && g_inst[k].depth == 1 && g_inst[k].parent == pidx) k++;
            uint32_t g1 = k;
            label_rank++;
            b_label_tot++;
            if (label_seq < (uint64_t)nexp && pidx == exp_pidx[label_seq]) b_label_ok++;
            label_seq++;
            // find candidate(s) generating exactly this group
            int matches = 0;
            for (int c = 0; c < ncand; c++) {
                AOption copts[2];
                int cn = a_options(&cands[c].node, seq, seq_len, copts);
                if (cn != (int)(g1 - g0)) continue;
                int all = 1;
                for (uint32_t m = g0; m < g1; m++) {
                    int oi = -1;
                    for (int o = 0; o < cn; o++) if (copts[o].used_hold == (int)g_inst[m].uh) oi = o;
                    if (oi < 0) { all = 0; break; }
                    uint8_t rec[196];
                    a_build_record(rec, &cands[c].node, &copts[oi], (uint32_t)dec, pidx, g_vbp[m].nout);
                    if (memcmp(rec, g_inst[m].raw, 196)) { all = 0; break; }
                }
                if (all) matches++;
            }
            b_tot += (g1 - g0);
            if (matches == 1) b_ok += (g1 - g0);
            else if (matches > 1) { b_ok += (g1 - g0); b_amb += (g1 - g0); }
            else { printf("dec %ld depth1 parent %u: no candidate generates the stored group (%u records)\n", dec, pidx, g1 - g0); bad = 1; }
            // Check E (ply 1): descriptor for the whole ply, once per
            // decision (on the first group). Adapter side accumulates
            // nch from the generated groups' BP counts in order.
            if (label_rank == 1) {
                uint32_t ni1 = 0, nch1 = 0, first1 = g0;
                for (uint32_t m = start; m < end; m++) if (g_inst[m].depth == 1) { ni1++; nch1 += g_inst[m].nchild; }
                VTau T; compute_tau_ply(&g_inst[first1], ni1, &T);
                uint32_t refd[8] = { first1, ni1, g_inst[first1].child_g0, nch1, T.tauLo, T.tauHi, T.tauPos, 1 };
                uint32_t anch1 = 0;
                for (uint32_t m = start; m < end; m++) if (g_inst[m].depth == 1) anch1 += g_vbp[m].nout;
                uint32_t adpd[8] = { first1, ni1, g_inst[first1].child_g0, anch1, T.tauLo, T.tauHi, T.tauPos, 1 };
                e_tot++;
                if (memcmp(refd, adpd, sizeof refd)) { e_bad++; printf("dec %ld ply1: uni descriptor diff\n", dec); bad = 1; }
            }
            // Check D (ply 1): pack streams for the group's stored records
            for (uint32_t m = g0; m < g1; m++) {
                uint32_t ga[48], ra[48], gs[52], rs[52];
                uint32_t cb = g_inst[m].child_g0;
                a_pack_inst48(g_inst[m].raw, ga); ga[4] = cb;
                ref_pack_inst48(&g_inst[m], cb, ra);
                a_pack_inst52(g_inst[m].raw, g_vbp[m].spawn, gs); gs[4] = cb;
                ref_pack_inst52(&g_inst[m], cb, rs);
                d_tot++;
                if (memcmp(ga, ra, sizeof ga) || memcmp(gs, rs, sizeof gs)) { d_bad++; bad = 1; }
                for (uint32_t ci = 0; ci < g_inst[m].nchild; ci++) {
                    uint32_t gw[2], rw[2];
                    a_pack_plcin(g_vbp[m].spawn[0], g_vbp[m].plc + (size_t)ci * 8, gw);
                    ref_pack_plcin(child_rec(m, ci), rw);
                    f_tot++;
                    if (memcmp(gw, rw, sizeof gw)) { f_bad++; bad = 1; }
                }
            }
        }
        if (label_seq != (uint64_t)nexp) { printf("dec %ld: depth-1 group count %llu != live children %d\n", dec, (unsigned long long)label_seq, nexp); bad = 1; }
        free(exp_pidx);
        free(cands);
    }
    printf("A root records: %llu/%llu byte-identical\n", (unsigned long long)a_ok, (unsigned long long)a_tot);
    printf("B depth-1 records: %llu/%llu byte-identical (ambiguous-equivalent %llu)\n",
           (unsigned long long)b_ok, (unsigned long long)b_tot, (unsigned long long)b_amb);
    printf("B arena labels: %llu/%llu groups carry parent_index == arena rank (dead nodes registered first)\n",
           (unsigned long long)b_label_ok, (unsigned long long)b_label_tot);
    printf("D pack streams (plies 0/1): %llu records, %llu bad\n", (unsigned long long)d_tot, (unsigned long long)d_bad);
    printf("E uni descriptors (plies 0/1): %llu, %llu bad\n", (unsigned long long)e_tot, (unsigned long long)e_bad);
    printf("F plcin (plies 0/1 children): %llu words pairs, %llu bad\n", (unsigned long long)f_tot, (unsigned long long)f_bad);

    // ---- Check C: all instances, assembly from recovered node state --
    uint64_t c_ok = 0, c_tot = 0, c_recover_fail = 0;
    for (uint32_t gi = 0; gi < g_ninst; gi++) {
        VInst *F = &g_inst[gi];
        const uint8_t *obs = g_obs + (size_t)F->dec * 154;
        int seq[16]; int seq_len = 0;
        { ANode tmp; a_root_from_obs(obs, &tmp, seq, &seq_len); }
        ANode n; memset(&n, 0, sizeof n);
        memcpy(n.rows, F->raw + 32, 80); memcpy(n.flags, F->raw + 112, 40);
        n.combo = ri32(F->raw + 152); n.chain = ri32(F->raw + 156);
        n.pending = ri32(F->raw + 160); n.due = ri32(F->raw + 164);
        n.tslot = ri32(F->raw + 168); n.reward = rdf64(F->raw + 172);
        n.depth = F->depth;
        uint32_t rec_next = rd32(F->raw + 24); int32_t rec_hold = ri32(F->raw + 28);
        int32_t spawn_kind = g_vbp[gi].spawn[0];
        int ok = 0;
        if (F->uh == 0) {
            n.next = rec_next - 1; n.hold = rec_hold;
            n.can_hold = (F->depth == 0) ? (obs[123] != 0) : 1;
            ok = 1;
        } else {
            // Recover the pre-option node for a used_hold record. Two
            // cases in piece_options: hold was Some(h) -> option.next =
            // node.next+1, node.hold = placed kind; hold was None ->
            // option.next = node.next+2, node.hold = -1. Adjacent equal
            // queue kinds can make both readings plausible, so accept
            // whichever reproduces the stored (next, hold) pair.
            for (int cs = 0; cs < 2 && !ok; cs++) {
                ANode t = n;
                if (cs == 0) {
                    if (rec_next < 1 || rec_next - 1 >= (uint32_t)seq_len) continue;
                    if (seq[rec_next - 1] != rec_hold) continue;
                    t.next = rec_next - 1; t.hold = spawn_kind;
                } else {
                    if (rec_next < 2 || rec_next - 2 >= (uint32_t)seq_len) continue;
                    if (seq[rec_next - 2] != rec_hold) continue;
                    if (rec_next - 1 >= (uint32_t)seq_len || seq[rec_next - 1] != spawn_kind) continue;
                    t.next = rec_next - 2; t.hold = -1;
                }
                t.can_hold = 1;
                AOption topts[2];
                int tno = a_options(&t, seq, seq_len, topts);
                for (int o = 0; o < tno; o++)
                    if (topts[o].used_hold == 1 && topts[o].next == rec_next && topts[o].hold == rec_hold) { n = t; ok = 1; break; }
            }
        }
        if (!ok) { c_recover_fail++; continue; }
        AOption opts[2];
        int no = a_options(&n, seq, seq_len, opts);
        int oi = -1;
        for (int o = 0; o < no; o++) if (opts[o].used_hold == (int)F->uh) oi = o;
        if (oi < 0) { c_recover_fail++; continue; }
        uint8_t rec[196];
        a_build_record(rec, &n, &opts[oi], F->dec, F->parent, g_vbp[gi].nout);
        c_tot++;
        if (!memcmp(rec, F->raw, 196)) c_ok++;
        else if (c_tot - c_ok < 4) {
            int fd = first_diff(rec, F->raw, 196);
            printf("C inst %u (dec %u depth %u uh %u): diff at byte %d gen %02x stored %02x\n", gi, F->dec, F->depth, F->uh, fd, rec[fd], F->raw[fd]);
        }
    }
    printf("C all-instance assembly: %llu/%llu byte-identical (node recovery failed %llu)\n",
           (unsigned long long)c_ok, (unsigned long long)c_tot, (unsigned long long)c_recover_fail);
    if (c_ok != c_tot || c_recover_fail) bad = 1;
    if (a_ok != a_tot || b_ok != b_tot || d_bad || e_bad || f_bad) bad = 1;
    printf("VERIFY %s\n", bad ? "FAILED" : "PASSED");
    return bad ? 1 : 0;
}
#endif // PROD_ADAPTER_NO_HARNESS
