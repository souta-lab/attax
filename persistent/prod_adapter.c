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
#define ADAPTER_ROOT_FRAME 0 // serve supplies the referee frame; corpus used 0

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
    return a_s2_multiplier(ADAPTER_ROOT_FRAME + 60 * (int64_t)depth);
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
// =================== ADAPTER END =====================================

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

int main(int argc, char **argv) {
    if (argc < 5 || strcmp(argv[1], "verify")) {
        fprintf(stderr, "usage: prod_adapter verify <obs.bin> <bxdump.bin> <bpdump.bin>\n");
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
