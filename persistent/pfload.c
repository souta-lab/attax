// PERSISTENT LOAD-IN host — drives pf/pfl.comp (resident kernel with
// BPX-L as S1 and the selection final form as S3) over the 180-decision
// gate corpus and checks it against the basic forms:
//   GATE A/P/S/B: bpxg.c's checks, verbatim in structure (the fused
//     BPX output inside the resident kernel vs the corpus + ures);
//   selection: a host replay of selg.c's run_ply_full logic (dedupe,
//     B&B rounds, tau stop, final sort) from the read-back records,
//     compared against the kernel's outbuf (nReps/nSel/nEval, the
//     evaluated set, the selected positions), the arena words, and a
//     SEL1 dump cross-checked by selcheck diff against the basic
//     form's reference dump;
//   drill: skeleton shape (sabotage -> fault -> clean rerun matches).
// Modes: gate <spv> <G> | drill <spv> <G> | bench <spv> <G> |
//        dump <spv> <G> <out.bin>
// Data paths via env: BXDUMP BPDUMP TABLES URES (defaults = PC paths).
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <vulkan/vulkan.h>

#define CK(x) do { VkResult _r = (x); if (_r != VK_SUCCESS) { fprintf(stderr, "VK %d at %s:%d\n", _r, __FILE__, __LINE__); exit(1); } } while (0)
static uint32_t rd32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static int32_t ri32(const uint8_t *p) { int32_t v; memcpy(&v, p, 4); return v; }
static uint64_t rd64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
static int cmpd(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return (x > y) - (x < y); }
static double now_s(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
static int read_sclk(void) {
    const char *paths[3] = { "/sys/class/drm/card2/device/pp_dpm_sclk", "/sys/class/drm/card1/device/pp_dpm_sclk", "/sys/class/drm/card0/device/pp_dpm_sclk" };
    FILE *f = NULL;
    for (int i = 0; i < 3 && !f; i++) f = fopen(paths[i], "r");
    if (!f) return -1;
    char buf[1024]; int mhz = -1;
    while (fgets(buf, sizeof buf, f)) {
        if (strchr(buf, '*')) {
            char *colon = strchr(buf, ':');
            if (colon) { int v = atoi(colon + 1); if (v > 0) mhz = v; }
        }
    }
    fclose(f); return mhz;
}
static int gpu_busy(void) {
    if (system("pgrep -x selg >/dev/null 2>&1") == 0) return 1;
    if (system("pgrep -x bxpg >/dev/null 2>&1") == 0) return 1;
    if (system("pgrep -x bpg >/dev/null 2>&1") == 0) return 1;
    if (system("pgrep -x bpxg >/dev/null 2>&1") == 0) return 1;
    if (system("pgrep -x bpxsg >/dev/null 2>&1") == 0) return 1;
    if (system("pgrep -x vkrunner >/dev/null 2>&1") == 0) return 1;
    const char *paths[2] = { "/sys/class/drm/card0/device/gpu_busy_percent", "/sys/class/drm/card1/device/gpu_busy_percent" };
    for (int i = 0; i < 2; i++) { FILE *f = fopen(paths[i], "r"); if (f) { int v = 0; if (fscanf(f, "%d", &v) == 1 && v > 20) { fclose(f); return 1; } fclose(f); } }
    return 0;
}

// ---------------- corpus (selg.c load_full_corpus + bpxg.c arrays) --
typedef struct { uint32_t dec, parent_index, depth, len, nchild, childBase; int32_t next_idx, hold_kind; const uint8_t *raw; } FInst;
typedef struct { uint32_t i0, ni, childBase, nch, dec, depth; } FPly;
static FInst *finst; static uint32_t nfinst;
static FPly *fply; static uint32_t nfply;
static const uint8_t *g_bxm;
static uint32_t g_total_ch, g_max_ply_ch;
#define CREC(ci) (finst[inst_of_arr[ci]].raw + 196 + (size_t)((ci) - finst[inst_of_arr[ci]].childBase) * 228)
static uint32_t *inst_of_arr; // per-child parent instance index

static void load_corpus(const char *path) {
    int fd = open(path, O_RDONLY); if (fd < 0) { perror(path); exit(1); }
    struct stat st; fstat(fd, &st);
    uint8_t *bx = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (bx == MAP_FAILED) { perror("mmap"); exit(1); }
    if (memcmp(bx, "BXD1", 4)) { fprintf(stderr, "bad BXD1\n"); exit(1); }
    g_bxm = bx;
    uint64_t n_inst = rd64(bx + 8);
    finst = malloc(n_inst * sizeof(FInst));
    uint32_t cbase = 0;
    uint32_t cur_dec = 0xFFFFFFFF, cur_depth = 0xFFFFFFFF;
    const uint8_t *bp = bx + 32;
    for (uint64_t ii = 0; ii < n_inst; ii++) {
        const uint8_t *inst = bp;
        FInst *F = &finst[nfinst++];
        F->dec = rd32(inst); F->parent_index = rd32(inst + 4);
        F->depth = rd32(inst + 12); F->len = rd32(inst + 16);
        F->nchild = rd32(inst + 20); F->childBase = cbase;
        F->next_idx = (int32_t)rd32(inst + 24); F->hold_kind = (int32_t)rd32(inst + 28);
        F->raw = inst;
        cbase += F->nchild;
        if (F->dec != cur_dec || F->depth != cur_depth) {
            cur_dec = F->dec; cur_depth = F->depth;
            fply = realloc(fply, (nfply + 1) * sizeof(FPly));
            FPly *P = &fply[nfply++];
            P->i0 = (uint32_t)ii; P->ni = 0; P->childBase = F->childBase;
            P->nch = 0; P->dec = F->dec; P->depth = F->depth;
        }
        fply[nfply - 1].ni++;
        fply[nfply - 1].nch += F->nchild;
        if (fply[nfply - 1].nch > g_max_ply_ch) g_max_ply_ch = fply[nfply - 1].nch;
        bp = inst + 196 + (size_t)F->nchild * 228;
    }
    g_total_ch = cbase;
    inst_of_arr = malloc((size_t)g_total_ch * 4);
    for (uint32_t i = 0; i < nfinst; i++)
        for (uint32_t c = 0; c < finst[i].nchild; c++) inst_of_arr[finst[i].childBase + c] = i;
    printf("corpus: %u instances, %u plies, %u children, max ply children %u\n", nfinst, nfply, g_total_ch, g_max_ply_ch);
    uint32_t maxpd = 0, curd = 0xFFFFFFFF, cnt = 0;
    for (uint32_t p = 0; p < nfply; p++) { if (fply[p].dec != curd) { curd = fply[p].dec; cnt = 0; } if (++cnt > maxpd) maxpd = cnt; }
    printf("max plies per decision: %u (kernel MAXPLY 32)\n", maxpd);
    if (maxpd > 32) { fprintf(stderr, "MAXPLY exceeded\n"); exit(1); }
    // Shader layout contract (audit B (d)): per-ply children must fit the
    // 8192-word SLOTOF/EVALCH/REPSGEN regions. The kernel does not check
    // this, so the host rejects an over-limit corpus up front.
    if (g_max_ply_ch > 8192) { fprintf(stderr, "ply children %u exceeds kernel layout limit 8192\n", g_max_ply_ch); exit(1); }
}
static double child_value(uint64_t ci) { uint64_t b = rd64(CREC(ci) + 220); double d; memcpy(&d, &b, 8); return d; }
static uint64_t ord_of(double v) { uint64_t b; memcpy(&b, &v, 8); if (b == 0x8000000000000000ull) b = 0; return (b >> 63) ? ~b : (b | 0x8000000000000000ull); }

// ---------------- bpdump + inst52 packing (bpxg.c) ------------------
static uint8_t *bpKind, *bpSr; static int8_t *bpSx, *bpSy;
static void load_bpdump(const char *path) {
    // Real format (bpxg.c load_bpdump): headerless stream of
    // dec(4) depth(4) rows(80) len/kind/sr/sx/sy+pad(6) nout(2)
    // nout*8 placement bytes. Only kind/sr/sx/sy are needed here.
    FILE *f = fopen(path, "rb"); if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *d = malloc((size_t)fl); if (fread(d, 1, (size_t)fl, f) != (size_t)fl) { fprintf(stderr, "bpdump short\n"); exit(1); }
    fclose(f);
    bpKind = malloc(nfinst); bpSr = malloc(nfinst); bpSx = malloc(nfinst); bpSy = malloc(nfinst);
    long p = 0; uint64_t n = 0;
    while (p < fl) {
        if (n >= nfinst) { fprintf(stderr, "bpdump has more instances than corpus\n"); exit(1); }
        p += 8 + 80;
        bpKind[n] = d[p + 1]; bpSr[n] = d[p + 2]; bpSx[n] = (int8_t)d[p + 3]; bpSy[n] = (int8_t)d[p + 4];
        p += 6;
        uint16_t no; memcpy(&no, d + p, 2); p += 2;
        if (no != finst[n].nchild) { fprintf(stderr, "bpdump nchild mismatch inst %llu\n", (unsigned long long)n); exit(1); }
        p += 8 * (long)no; n++;
    }
    if (n != nfinst) { fprintf(stderr, "bpdump nInst %llu != %u\n", (unsigned long long)n, nfinst); exit(1); }
    free(d);
    printf("bpdump ok (%llu instances)\n", (unsigned long long)n);
}

// ---------------- static tau per ply (bpxg.c compute_tau) -----------
typedef struct { uint64_t key[3]; uint32_t pos; double v; } TauRep;
typedef struct { uint32_t tauLo, tauHi, tauPos, nKept; uint32_t kept[96]; } TauInfo;
static TauInfo *tauInfo;
static int tau_cmp(const void *a, const void *b) {
    const TauRep *x = a, *y = b;
    if (x->v != y->v) return x->v > y->v ? -1 : 1;
    return x->pos < y->pos ? -1 : 1;
}
static void compute_tau(void) {
    tauInfo = calloc(nfply, sizeof(TauInfo));
    TauRep *reps = malloc(7000 * sizeof(TauRep));
    for (uint32_t gi = 0; gi < nfply; gi++) {
        FPly *P = &fply[gi];
        // open addressing over the 144-byte rep key (FNV-1a), full compare
        static uint32_t htab[1 << 16]; static int32_t hslot[1 << 16];
        memset(hslot, 0xFF, sizeof hslot);
        uint32_t nReps = 0; uint32_t pos = 0;
        for (uint32_t li = 0; li < P->nch; li++) {
            uint64_t ci = P->childBase + li;
            const uint8_t *ch = CREC(ci);
            const uint8_t *ir = finst[inst_of_arr[ci]].raw;
            uint8_t key[144];
            memcpy(key + 0, ir + 24, 4);                       // nextIdx
            { int32_t hk = ri32(ir + 28); uint32_t hv = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; memcpy(key + 4, &hv, 4); }
            memcpy(key + 8, ch + 196, 4);                      // chain
            memcpy(key + 12, ch + 192, 4);                     // combo
            memset(key + 16, 0, 4);                            // lift
            memcpy(key + 20, ch + 188, 4);                     // pending
            memcpy(key + 24, ch + 88, 40);                     // flags
            memcpy(key + 64, ch + 8, 80);                      // rows
            uint64_t h = 0xcbf29ce484222325ULL;
            for (int i = 0; i < 144; i++) { h ^= key[i]; h *= 0x100000001b3ULL; }
            uint32_t s = (uint32_t)(h & 0xFFFF);
            int found = -1;
            while (hslot[s] >= 0) {
                int32_t ri = hslot[s];
                if (htab[s] == (uint32_t)(h >> 32)) {
                    // full key compare against the stored rep's source child
                    const TauRep *r = &reps[ri];
                    uint64_t ci0 = P->childBase + r->pos; // NOT the rep's child; recompute below
                    (void)ci0;
                    // reps store pos of FIRST occurrence; rebuild its key
                    const uint8_t *ch0 = CREC(P->childBase + r->pos);
                    const uint8_t *ir0 = finst[inst_of_arr[P->childBase + r->pos]].raw;
                    uint8_t key0[144];
                    memcpy(key0 + 0, ir0 + 24, 4);
                    { int32_t hk = ri32(ir0 + 28); uint32_t hv = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; memcpy(key0 + 4, &hv, 4); }
                    memcpy(key0 + 8, ch0 + 196, 4); memcpy(key0 + 12, ch0 + 192, 4); memset(key0 + 16, 0, 4);
                    memcpy(key0 + 20, ch0 + 188, 4); memcpy(key0 + 24, ch0 + 88, 40); memcpy(key0 + 64, ch0 + 8, 80);
                    if (!memcmp(key, key0, 144)) { found = ri; break; }
                }
                s = (s + 1) & 0xFFFF;
            }
            if (found < 0) {
                TauRep *r = &reps[nReps];
                r->pos = pos; r->v = child_value(ci);
                htab[s] = (uint32_t)(h >> 32); hslot[s] = (int32_t)nReps;
                nReps++;
            }
            pos++;
        }
        TauInfo *T = &tauInfo[gi];
        if (nReps > 96) {
            qsort(reps, nReps, sizeof(TauRep), tau_cmp);
            uint64_t tb; double tv = reps[95].v; memcpy(&tb, &tv, 8);
            T->tauLo = (uint32_t)tb; T->tauHi = (uint32_t)(tb >> 32); T->tauPos = reps[95].pos;
            T->nKept = 96;
            // kept[] must hold the top-96 reps' first-occurrence children
            // in corpus terms: child index = childBase + pos
            for (int j = 0; j < 96; j++) T->kept[j] = P->childBase + reps[j].pos;
        } else {
            T->tauLo = 0; T->tauHi = 0xFFF00000u; T->tauPos = 0xFFFFFFFFu; T->nKept = 0;
        }
    }
    free(reps);
    printf("compute_tau ok\n");
}

// ---------------- packing (bpxg inst52 / selg inst48+plc / gout) ----
static uint32_t *pack_inst52(void) {
    uint32_t *instW = calloc((size_t)nfinst * 52, 4);
    for (uint32_t i = 0; i < nfinst; i++) {
        const uint8_t *ir = finst[i].raw;
        uint32_t *w = instW + (size_t)i * 52;
        w[0] = finst[i].dec; w[1] = finst[i].depth; w[2] = finst[i].len; w[3] = finst[i].nchild;
        w[4] = finst[i].childBase; w[5] = (uint32_t)finst[i].next_idx;
        { int32_t hk = finst[i].hold_kind; w[6] = hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk; }
        for (int r = 0; r < 20; r++) { uint16_t a, b; memcpy(&a, ir + 32 + 4 * r, 2); memcpy(&b, ir + 32 + 4 * r + 2, 2); w[7 + r] = a | ((uint32_t)b << 16); }
        for (int r = 0; r < 10; r++) { uint32_t v = 0; for (int j = 0; j < 4; j++) v |= (uint32_t)ir[112 + 4 * r + j] << (8 * j); w[27 + r] = v; }
        w[37] = rd32(ir + 152); w[38] = rd32(ir + 156); w[39] = rd32(ir + 160);
        w[40] = rd32(ir + 164); w[41] = rd32(ir + 168);
        uint64_t rw = rd64(ir + 172), mw = rd64(ir + 180), sw = rd64(ir + 188);
        w[42] = (uint32_t)rw; w[43] = (uint32_t)(rw >> 32);
        w[44] = (uint32_t)mw; w[45] = (uint32_t)(mw >> 32);
        w[46] = (uint32_t)sw; w[47] = (uint32_t)(sw >> 32);
        w[48] = (uint32_t)bpKind[i] | ((uint32_t)bpSr[i] << 8) | ((uint32_t)(uint8_t)bpSx[i] << 16) | ((uint32_t)(uint8_t)bpSy[i] << 24);
        w[49] = 1; // emit plc byproduct (basic-form bench configuration)
        w[50] = 0; w[51] = 0;
    }
    return instW;
}
static uint32_t *pack_inst48(void) {
    // selg.c full_setup packing, verbatim (raw u32 streams; the tslot
    // guard lives inside bxp_b itself, not in the packing)
    uint32_t *w = calloc((size_t)nfinst * 48, 4);
    for (uint32_t i = 0; i < nfinst; i++) {
        const uint8_t *ir = finst[i].raw;
        uint32_t *d = w + (size_t)i * 48;
        d[0] = finst[i].dec; d[1] = finst[i].depth; d[2] = finst[i].len; d[3] = finst[i].nchild;
        d[4] = finst[i].childBase; d[5] = (uint32_t)finst[i].next_idx;
        d[6] = finst[i].hold_kind < 0 ? 0xFFFFFFFFu : (uint32_t)finst[i].hold_kind;
        for (int r = 0; r < 20; r++) d[7 + r] = rd32(ir + 32 + 4 * r);
        for (int r = 0; r < 10; r++) d[27 + r] = rd32(ir + 112 + 4 * r);
        for (int r = 0; r < 11; r++) d[37 + r] = rd32(ir + 152 + 4 * r);
    }
    return w;
}
static uint32_t *pack_plcin(void) {
    uint32_t *pw = malloc((size_t)g_total_ch * 2 * 4);
    for (uint32_t ci = 0; ci < g_total_ch; ci++) {
        const uint8_t *ch = CREC(ci);
        pw[ci * 2] = (uint32_t)ch[0] | ((uint32_t)ch[1] << 8) | ((uint32_t)(int8_t)ch[2] << 16) | ((uint32_t)(int8_t)ch[3] << 24);
        pw[ci * 2 + 1] = rd32(ch + 4);
    }
    return pw;
}
static uint32_t *pack_plc_expected(void) { // bpxg GATE P expectation
    uint32_t *pw = malloc((size_t)g_total_ch * 2 * 4);
    for (uint32_t ci = 0; ci < g_total_ch; ci++) {
        const uint8_t *ch = CREC(ci);
        pw[ci * 2] = (uint32_t)ch[0] | ((uint32_t)ch[1] << 8) | ((uint32_t)ch[2] << 16) | ((uint32_t)ch[3] << 24);
        pw[ci * 2 + 1] = ch[4];
    }
    return pw;
}
static uint32_t *pack_gout(void) {
    uint32_t *g = malloc((size_t)g_total_ch * 30 * 4);
    for (uint32_t ci = 0; ci < g_total_ch; ci++) {
        const uint8_t *ch = CREC(ci);
        for (int i = 0; i < 30; i++) g[(size_t)ci * 30 + i] = rd32(ch + 8 + 4 * i);
    }
    return g;
}

// ---------------- Vulkan scaffolding (pfx.c form) -------------------
static VkDevice dev; static VkQueue queue; static VkCommandPool pool;
static VkPhysicalDeviceMemoryProperties mp;
typedef struct { VkBuffer buf; VkDeviceMemory mem; uint8_t *ptr; } Buf;
static int find_type(uint32_t filter, VkMemoryPropertyFlags want) {
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((filter & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) return (int)i;
    return -1;
}
static Buf mkbuf(VkDeviceSize sz, VkBufferUsageFlags use, bool devlocal) {
    Buf b = { 0 };
    VkBufferCreateInfo ci = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, NULL, 0, sz, use, VK_SHARING_MODE_EXCLUSIVE, 0, NULL };
    CK(vkCreateBuffer(dev, &ci, NULL, &b.buf));
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(dev, b.buf, &mr);
    int t = devlocal ? find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)
                     : find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT | VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (t < 0 && !devlocal) t = find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (t < 0) { fprintf(stderr, "no memory type\n"); exit(1); }
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, mr.size, (uint32_t)t };
    CK(vkAllocateMemory(dev, &ai, NULL, &b.mem));
    CK(vkBindBufferMemory(dev, b.buf, b.mem, 0));
    if (!devlocal) CK(vkMapMemory(dev, b.mem, 0, VK_WHOLE_SIZE, 0, (void **)&b.ptr));
    return b;
}
static Buf bctrl, buni, binst52, binst48, bplcin, bplcout, btab, brec, brecstg, bstate, bout, bgout, bstatus;
static VkPipeline kpipe; static VkPipelineLayout lay; static VkDescriptorSet dset;
static VkQueryPool qpool; static double tsp_ns;
static VkCommandBuffer cb;
#define STATE_WORDS 196992u
#define OUT_WORDS 663040u

static void vk_setup(const char *spvp) {
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "pfload", 1, "pfload", 1, VK_API_VERSION_1_3 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 0, NULL };
    VkInstance vi; CK(vkCreateInstance(&ici, NULL, &vi));
    uint32_t nd = 0; CK(vkEnumeratePhysicalDevices(vi, &nd, NULL)); VkPhysicalDevice ds[8]; CK(vkEnumeratePhysicalDevices(vi, &nd, ds));
    VkPhysicalDevice ph = VK_NULL_HANDLE; VkPhysicalDeviceProperties pr;
    const char *wantGpu = getenv("ATTAX_GPU");
    if (wantGpu && wantGpu[0]) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (strstr(pr.deviceName, wantGpu)) { ph = ds[i]; break; } }
    }
    if (!ph) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (strstr(pr.deviceName, "RX 6400")) { ph = ds[i]; break; } }
    }
    if (!ph) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (pr.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) { ph = ds[i]; break; } }
    }
    if (!ph) { fprintf(stderr, "no discrete Vulkan GPU found (ATTAX_GPU / RX 6400 / discrete only; no silent fallback)\n"); exit(1); }
    VkPhysicalDeviceSubgroupSizeControlProperties ssc = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_PROPERTIES, NULL };
    VkPhysicalDeviceSubgroupProperties sub = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES, &ssc };
    VkPhysicalDeviceProperties2 p2 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, &sub };
    vkGetPhysicalDeviceProperties2(ph, &p2);
    uint32_t reqWave = 0;
    const char *ws = getenv("ATTAX_WAVE");
    if (ws && ws[0]) {
        reqWave = (uint32_t)atoi(ws);
        if (reqWave != 32 && reqWave != 64) { fprintf(stderr, "ATTAX_WAVE must be 32 or 64\n"); exit(1); }
        if (reqWave < ssc.minSubgroupSize || reqWave > ssc.maxSubgroupSize) {
            fprintf(stderr, "ATTAX_WAVE=%u unsupported by %s (min=%u max=%u)\n", reqWave, pr.deviceName, ssc.minSubgroupSize, ssc.maxSubgroupSize);
            exit(1);
        }
    }
    uint32_t effWave = reqWave ? reqWave : sub.subgroupSize;
    if (effWave != 32 && effWave != 64) { fprintf(stderr, "unsupported subgroupSize %u (need 32 or 64)\n", effWave); exit(1); }
    printf("device %s subgroupSize %u (wave=%u, min=%u max=%u) sclk %d MHz\n", pr.deviceName, sub.subgroupSize, effWave, ssc.minSubgroupSize, ssc.maxSubgroupSize, read_sclk());
    tsp_ns = pr.limits.timestampPeriod;
    vkGetPhysicalDeviceMemoryProperties(ph, &mp);
    uint32_t nq = 0; vkGetPhysicalDeviceQueueFamilyProperties(ph, &nq, NULL); VkQueueFamilyProperties qf[16]; vkGetPhysicalDeviceQueueFamilyProperties(ph, &nq, qf);
    uint32_t qfi = 0; for (uint32_t i = 0; i < nq; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfi = i; break; }
    float prio = 1; VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, qfi, 1, &prio };
    VkPhysicalDeviceFeatures feats = { 0 }; feats.shaderInt64 = VK_TRUE; feats.shaderFloat64 = VK_TRUE;
    VkPhysicalDeviceSubgroupSizeControlFeatures sscf = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_FEATURES, NULL, VK_TRUE, VK_FALSE };
    VkPhysicalDeviceShaderAtomicInt64Features af = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_ATOMIC_INT64_FEATURES, &sscf };
    af.shaderBufferInt64Atomics = VK_TRUE;
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, &af, 0, 1, &qci, 0, NULL, 0, NULL, &feats };
    CK(vkCreateDevice(ph, &dci, NULL, &dev));
    vkGetDeviceQueue(dev, qfi, 0, &queue);
    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, qfi };
    CK(vkCreateCommandPool(dev, &cpci, NULL, &pool));
    VkCommandBufferAllocateInfo cai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    CK(vkAllocateCommandBuffers(dev, &cai, &cb));
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, 2, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &qpool));
}

static void buffers_setup(uint32_t *inst52, uint32_t *inst48, uint32_t *plcin, double *tabD, uint32_t *gout) {
    const VkBufferUsageFlags SB = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    bctrl = mkbuf(8192 * 4, SB, false);
    buni = mkbuf(4096, SB, false);
    binst52 = mkbuf((VkDeviceSize)nfinst * 52 * 4, SB, false); memcpy(binst52.ptr, inst52, (size_t)nfinst * 52 * 4);
    binst48 = mkbuf((VkDeviceSize)nfinst * 48 * 4, SB, false); memcpy(binst48.ptr, inst48, (size_t)nfinst * 48 * 4);
    bplcin = mkbuf((VkDeviceSize)g_total_ch * 2 * 4, SB, false); memcpy(bplcin.ptr, plcin, (size_t)g_total_ch * 2 * 4);
    bplcout = mkbuf((VkDeviceSize)g_total_ch * 2 * 4, SB, false); memset(bplcout.ptr, 0xEE, (size_t)g_total_ch * 2 * 4);
    btab = mkbuf(180 * 8, SB, false); memcpy(btab.ptr, tabD, 180 * 8);
    brec = mkbuf((VkDeviceSize)g_total_ch * 64, SB | VK_BUFFER_USAGE_TRANSFER_SRC_BIT, true);
    bstate = mkbuf((VkDeviceSize)STATE_WORDS * 4, SB, true);
    bout = mkbuf((VkDeviceSize)OUT_WORDS * 4, SB, false);
    bgout = mkbuf((VkDeviceSize)g_total_ch * 30 * 4, SB | VK_BUFFER_USAGE_TRANSFER_DST_BIT, true);
    bstatus = mkbuf((VkDeviceSize)nfinst * 4, SB, false); memset(bstatus.ptr, 0xEE, (size_t)nfinst * 4);
    // staging for records readback: largest decision's children
    uint32_t maxdc = 0;
    { uint32_t curd = 0xFFFFFFFF, acc = 0; for (uint32_t p = 0; p < nfply; p++) { if (fply[p].dec != curd) { curd = fply[p].dec; acc = 0; } acc += fply[p].nch; if (acc > maxdc) maxdc = acc; } }
    brecstg = mkbuf((VkDeviceSize)maxdc * 64, VK_BUFFER_USAGE_TRANSFER_DST_BIT, false);
    printf("records staging for max decision children %u\n", maxdc);
    // upload gout in 64 MB chunks via the staging buffer (reuse a temp BAR buffer)
    {
        Buf stg = mkbuf(64ull << 20, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, false);
        size_t total = (size_t)g_total_ch * 30 * 4, off = 0;
        while (off < total) {
            size_t n = total - off > (64ull << 20) ? (64ull << 20) : total - off;
            memcpy(stg.ptr, (uint8_t *)gout + off, n);
            CK(vkResetCommandBuffer(cb, 0));
            VkCommandBufferBeginInfo bgi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
            CK(vkBeginCommandBuffer(cb, &bgi));
            VkBufferCopy reg = { 0, off, n };
            vkCmdCopyBuffer(cb, stg.buf, bgout.buf, 1, &reg);
            CK(vkEndCommandBuffer(cb));
            VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cb, 0, NULL };
            CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE)); CK(vkQueueWaitIdle(queue));
            off += n;
        }
        vkFreeMemory(dev, stg.mem, NULL); vkDestroyBuffer(dev, stg.buf, NULL);
    }
    // descriptor set: 19 bindings
    VkDescriptorSetLayoutBinding bd[19];
    for (int i = 0; i < 19; i++) { bd[i].binding = (uint32_t)i; bd[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; bd[i].descriptorCount = 1; bd[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; bd[i].pImmutableSamplers = NULL; }
    VkDescriptorSetLayoutCreateInfo lci = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, NULL, 0, 19, bd };
    VkDescriptorSetLayout dsl; CK(vkCreateDescriptorSetLayout(dev, &lci, NULL, &dsl));
    VkPushConstantRange pcr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 16 };
    VkPipelineLayoutCreateInfo plci = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, NULL, 0, 1, &dsl, 1, &pcr };
    CK(vkCreatePipelineLayout(dev, &plci, NULL, &lay));
    VkDescriptorPoolSize dps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 19 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, NULL, 0, 1, 1, &dps };
    VkDescriptorPool dp; CK(vkCreateDescriptorPool(dev, &dpi, NULL, &dp));
    VkDescriptorSetAllocateInfo sai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, NULL, dp, 1, &dsl };
    CK(vkAllocateDescriptorSets(dev, &sai, &dset));
    VkDescriptorBufferInfo ii_[19] = {
        { bctrl.buf, 0, VK_WHOLE_SIZE }, { buni.buf, 0, VK_WHOLE_SIZE }, { binst52.buf, 0, VK_WHOLE_SIZE },
        { binst48.buf, 0, VK_WHOLE_SIZE }, { bplcin.buf, 0, VK_WHOLE_SIZE }, { btab.buf, 0, VK_WHOLE_SIZE },
        { brec.buf, 0, VK_WHOLE_SIZE }, { bstate.buf, 0, VK_WHOLE_SIZE }, { bout.buf, 0, VK_WHOLE_SIZE },
        { bgout.buf, 0, VK_WHOLE_SIZE }, { bstatus.buf, 0, VK_WHOLE_SIZE }, { bplcout.buf, 0, VK_WHOLE_SIZE },
        { bstate.buf, 188608ull * 4, VK_WHOLE_SIZE }, { bstate.buf, 0, VK_WHOLE_SIZE },
        { bstate.buf, 32768ull * 4, VK_WHOLE_SIZE }, { bstate.buf, 188480ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 188544ull * 4, VK_WHOLE_SIZE }, { bstate.buf, 147456ull * 4, VK_WHOLE_SIZE },
        { brec.buf, 0, VK_WHOLE_SIZE }
    };
    VkWriteDescriptorSet wr[19];
    for (int i = 0; i < 19; i++) { VkWriteDescriptorSet w = { VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, dset, (uint32_t)i, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NULL, &ii_[i], NULL }; wr[i] = w; }
    vkUpdateDescriptorSets(dev, 19, wr, 0, NULL);
}

static void pipeline_setup(const char *spvp) {
    FILE *sf = fopen(spvp, "rb"); if (!sf) { perror(spvp); exit(1); }
    fseek(sf, 0, SEEK_END); long sl = ftell(sf); fseek(sf, 0, SEEK_SET);
    uint32_t *spv = malloc(sl); if (fread(spv, 1, sl, sf) != (size_t)sl) exit(1); fclose(sf);
    VkShaderModuleCreateInfo smi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, NULL, 0, (size_t)sl, spv };
    VkShaderModule sm; CK(vkCreateShaderModule(dev, &smi, NULL, &sm));
    const char *ws2 = getenv("ATTAX_WAVE");
    uint32_t rw2 = (ws2 && ws2[0]) ? (uint32_t)atoi(ws2) : 0u;
    VkPipelineShaderStageRequiredSubgroupSizeCreateInfo rss = { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_REQUIRED_SUBGROUP_SIZE_CREATE_INFO, NULL, rw2 };
    VkComputePipelineCreateInfo cci = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, NULL, 0,
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, rw2 ? &rss : NULL, 0, VK_SHADER_STAGE_COMPUTE_BIT, sm, "main", NULL }, lay, VK_NULL_HANDLE, 0 };
    CK(vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &cci, NULL, &kpipe));
    free(spv);
}

// per-decision ply ranges
static uint32_t decPly0[256], decPlyN[256], decChild0[256], decChildN[256], NDEC;
static void decision_ranges(void) {
    NDEC = 0;
    for (uint32_t p = 0; p < nfply; p++) {
        uint32_t d = fply[p].dec;
        if (d >= NDEC) { NDEC = d + 1; decPly0[d] = p; decPlyN[d] = 0; decChild0[d] = fply[p].childBase; decChildN[d] = 0; }
        decPlyN[d]++; decChildN[d] += fply[p].nch;
    }
    printf("decisions: %u\n", NDEC);
}

// Run one decision; returns 0 = done, 1 = fault. span/wall in us.
static int run_decision(uint32_t d, uint32_t G, uint32_t flags, double *spanUs, double *wallUs) {
    uint32_t *uni = (uint32_t *)buni.ptr;
    uint32_t np = decPlyN[d];
    uni[0] = np; uni[1] = 0;
    for (int i = 2; i < 16; i++) uni[i] = 0;
    for (uint32_t k = 0; k < np; k++) {
        FPly *P = &fply[decPly0[d] + k];
        TauInfo *T = &tauInfo[decPly0[d] + k];
        uint32_t *u = uni + 16 + k * 8;
        u[0] = P->i0; u[1] = P->ni; u[2] = P->childBase; u[3] = P->nch;
        u[4] = T->tauLo; u[5] = T->tauHi; u[6] = T->tauPos; u[7] = P->depth;
    }
    uint32_t *ctrl = (uint32_t *)bctrl.ptr;
    // Zero the control block host-side before submitting: the poll loop
    // below reads ctrl[0]/ctrl[1] through the mapping and must never see
    // the previous run's done/error before the CB fill executes.
    memset(ctrl, 0, 8192 * 4);
    CK(vkResetCommandBuffer(cb, 0));
    VkCommandBufferBeginInfo bgi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
    CK(vkBeginCommandBuffer(cb, &bgi));
    vkCmdFillBuffer(cb, bctrl.buf, 0, 8192 * 4, 0);
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL, VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0, NULL);
    vkCmdResetQueryPool(cb, qpool, 0, 2);
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, kpipe);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, lay, 0, 1, &dset, 0, NULL);
    uint32_t pcw[4] = { G, G / 12, flags, 200000 };
    vkCmdPushConstants(cb, lay, VK_SHADER_STAGE_COMPUTE_BIT, 0, 16, pcw);
    vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, qpool, 0);
    vkCmdDispatch(cb, G, 1, 1);
    vkCmdWriteTimestamp(cb, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, qpool, 1);
    if (decChildN[d]) {
        VkMemoryBarrier mb2 = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL, VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT };
        vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &mb2, 0, NULL, 0, NULL);
        VkBufferCopy reg = { (VkDeviceSize)decChild0[d] * 64, 0, (VkDeviceSize)decChildN[d] * 64 };
        vkCmdCopyBuffer(cb, brec.buf, brecstg.buf, 1, &reg);
    }
    CK(vkEndCommandBuffer(cb));
    double t0 = now_s();
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cb, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    double deadline = t0 + 20.0;
    int fault = 0;
    for (;;) {
        uint32_t done = __atomic_load_n(&ctrl[0], __ATOMIC_ACQUIRE);
        uint32_t err = __atomic_load_n(&ctrl[1], __ATOMIC_ACQUIRE);
        if (err) { fault = 1; break; }
        if (done) break;
        if (now_s() > deadline) { fprintf(stderr, "dec %u: host poll timeout\n", d); fault = 2; break; }
    }
    CK(vkQueueWaitIdle(queue));
    *wallUs = (now_s() - t0) * 1e6;
    uint64_t tq[2];
    CK(vkGetQueryPoolResults(dev, qpool, 0, 2, sizeof tq, tq, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    *spanUs = (double)(tq[1] - tq[0]) * tsp_ns / 1000.0;
    return fault;
}

// ---------------- verification --------------------------------------
static uint8_t *ures;
static uint64_t badHash, badU, badFeat, badScal, badInst, violU, keptMiss;
static uint64_t badVal, badAcc, badK, badQ1, badSurvRange;
static uint64_t selBadAlive, selBadReps, selBadEval, selBadEvalSet, selBadSel, selBadPos, arenaBad;
static uint64_t canon_key(const uint8_t *inst, const uint8_t *ch) {
    uint64_t h = 0xcbf29ce484222325ULL; const uint64_t P = 0x100000001b3ULL;
    uint32_t len = rd32(inst + 16);
#define KB(b) do { h ^= (uint8_t)(b); h *= P; } while (0)
#define K32(v) do { uint32_t _v = (uint32_t)(v); for (int _i = 0; _i < 4; _i++) KB(_v >> (8 * _i)); } while (0)
    KB(1);
    K32(rd32(inst + 24));
    K32(rd32(inst + 28));
    K32(rd32(ch + 196));
    K32(rd32(ch + 192));
    K32(0);
    K32(rd32(ch + 188));
    KB(1); K32(len);
    for (uint32_t i = 0; i < len; i++) KB(ch[88 + i]);
    K32(len);
    for (uint32_t i = 0; i < len; i++) { uint32_t r = rd32(ch + 8 + 2 * i) & 0xFFFF; KB(r); KB(r >> 8); }
#undef KB
#undef K32
    return h;
}
typedef struct { uint8_t *p; size_t len, cap; } DBuf;
static void dput(DBuf *b, const void *src, size_t n) { if (b->len + n > b->cap) { b->cap = (b->len + n) * 2 + 65536; b->p = realloc(b->p, b->cap); } memcpy(b->p + b->len, src, n); b->len += n; }
static void dput32(DBuf *b, uint32_t v) { dput(b, &v, 4); }
static void dput64(DBuf *b, uint64_t v) { dput(b, &v, 8); }
static DBuf dumpBuf;
static uint64_t host_ord(uint64_t bits) { if (bits == 0x8000000000000000ull) bits = 0; return (bits >> 63) ? ~bits : (bits | 0x8000000000000000ull); }

// scratch for the replay (max ply children 8192)
static uint32_t rp_list[8192], rp_posOf[8192];
static uint64_t rp_U[8192], rp_val[8192];
static uint8_t rp_isSurv[8192], rp_inEval[8192];
static uint32_t rep_child[8192], rep_pos[8192], rep_ord_idx[8192];
static uint64_t rep_ordU[8192];
static int cmp_reporder(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    if (rep_ordU[x] != rep_ordU[y]) return rep_ordU[x] > rep_ordU[y] ? -1 : 1;
    return rep_pos[x] < rep_pos[y] ? -1 : 1;
}
static uint32_t ev_child[8192], ev_gen[8192];
static uint64_t ev_bits[8192];
static int cmp_final(const void *a, const void *b) {
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    uint64_t ox = host_ord(ev_bits[x]), oy = host_ord(ev_bits[y]);
    if (ox != oy) return ox > oy ? -1 : 1;
    return ev_gen[x] < ev_gen[y] ? -1 : 1;
}
static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return (x > y) - (x < y); }

static void verify_decision(uint32_t d) {
    uint32_t *recw = (uint32_t *)brecstg.ptr;
    uint32_t *out = (uint32_t *)bout.ptr;
    uint32_t cb0 = decChild0[d];
    DBuf db = { 0 };
    uint32_t nplies_d = 0;
    for (uint32_t k = 0; k < decPlyN[d]; k++) {
        uint32_t gp = decPly0[d] + k;
        FPly *P = &fply[gp]; TauInfo *T = &tauInfo[gp];
        const uint32_t *head = out + k * 16;
        uint32_t nAliveH = head[0], nRepsH = head[1], nSelH = head[2], nEvalH = head[3], nSurvH = head[5];
        memset(rp_isSurv, 0, P->nch); memset(rp_inEval, 0, P->nch);
        const uint32_t *survL = out + 512 + k * 8192;
        for (uint32_t s = 0; s < nSurvH; s++) {
            uint32_t ci = survL[s];
            if (ci < P->childBase || ci >= P->childBase + P->nch) { badSurvRange++; continue; }
            rp_isSurv[ci - P->childBase] = 1;
        }
        for (int j = 0; j < (int)T->nKept; j++) if (!rp_isSurv[T->kept[j] - P->childBase]) keptMiss++;
        const uint32_t *evalL = out + 262656 + k * 8192;
        for (uint32_t s = 0; s < nEvalH; s++) {
            uint32_t ci = evalL[s];
            if (ci >= P->childBase && ci < P->childBase + P->nch) rp_inEval[ci - P->childBase] = 1;
        }
        // GATE A / B / Q1 over the ply's children (records from staging)
        for (uint32_t li = 0; li < P->nch; li++) {
            uint64_t ci = P->childBase + li;
            const uint32_t *w = recw + (ci - cb0) * 16;
            const uint8_t *er = CREC(ci);
            const uint8_t *ir = finst[inst_of_arr[ci]].raw;
            uint64_t hh = 0x14650FB0739D0383ull; const uint64_t prime = 0x100000001B3ull;
            int32_t hk = ri32(ir + 28);
            uint64_t pw0 = rd32(ir + 24) | ((uint64_t)(hk < 0 ? 0xFFFFFFFFu : (uint32_t)hk) << 32);
            uint64_t pw1 = (uint32_t)ri32(er + 196) | ((uint64_t)(uint32_t)ri32(er + 192) << 32);
            uint64_t pw2 = (uint32_t)ri32(er + 188);
            int ilen = ri32(ir + 16);
            uint64_t flb = 0; for (int j = 0; j < 40 && j < ilen; j++) if (er[88 + j]) flb |= 1ull << (ilen - 1 - j);
            uint64_t rpk[7] = { 0 };
            for (int j = 0; j < 40; j++) { uint16_t rw = 0; if (j < ilen) memcpy(&rw, er + 8 + 2 * j, 2); rpk[j / 6] |= (uint64_t)rw << (10 * (j % 6)); }
            hh = (hh ^ pw0) * prime; hh = (hh ^ pw1) * prime; hh = (hh ^ pw2) * prime; hh = (hh ^ flb) * prime;
            for (int j = 0; j < 7; j++) hh = (hh ^ rpk[j]) * prime;
            uint64_t gotH = (uint64_t)w[0] | ((uint64_t)w[1] << 32);
            if (gotH != hh) badHash++;
            uint64_t gotU = (uint64_t)w[2] | ((uint64_t)w[3] << 32);
            uint64_t expU = rd64(ures + 16 + (ci * 5 + 4) * 8);
            if (gotU != expU) badU++;
            { double uv; memcpy(&uv, &gotU, 8); if (uv < child_value(ci)) violU++; }
            uint64_t flo = (uint64_t)w[10] | ((uint64_t)w[11] << 32);
            int gf[11];
            gf[0] = (int)((flo >> 0) & 0x7F); gf[1] = (int)((flo >> 7) & 0x3FF); gf[2] = (int)((flo >> 17) & 0x1FF);
            gf[3] = (int)((flo >> 26) & 0x7FF); gf[4] = (int)((flo >> 37) & 0x3F); gf[5] = (int)((flo >> 43) & 0x1FF);
            gf[6] = (int)(w[12] & 0x3FFF); gf[7] = (int)((flo >> 52) & 0x1FF); gf[8] = (int)((flo >> 61) & 0x7);
            gf[9] = (int)((w[12] >> 14) & 0xF); gf[10] = (int)((w[12] >> 18) & 0x3);
            for (int j = 0; j < 11; j++) if (gf[j] != ri32(er + 128 + 4 * j)) { badFeat++; break; }
            uint32_t scA = w[13], scB = w[14];
            int gs_spin = (int)(scA & 3), gs_lines = (int)((scA >> 2) & 63), gs_dead = (int)((scA >> 8) & 1), gs_pc = (int)((scA >> 9) & 1);
            int gs_attack = (int)((scA >> 10) & 1023), gs_gc = (int)((scA >> 20) & 63);
            int gs_combo = (int)(scB & 63) - 1, gs_chain = (int)((scB >> 6) & 255), gs_pending = (int)((scB >> 14) & 63), gs_landed = (int)((scB >> 20) & 63);
            int expLines = (int)rd32(er + 172);
            int expPc = 0;
            if (expLines > 0) { expPc = 1; for (int j = 0; j < 40; j++) { uint16_t rw; memcpy(&rw, er + 8 + 2 * j, 2); if (rw != 0) { expPc = 0; break; } } }
            if (gs_spin != er[200] || gs_lines != expLines || gs_dead != er[201] || gs_pc != expPc ||
                gs_attack != ri32(er + 176) || gs_gc != ri32(er + 180) || gs_landed != ri32(er + 184) ||
                gs_pending != ri32(er + 188) || gs_combo != ri32(er + 192) || gs_chain != ri32(er + 196)) badScal++;
            if (w[15] != inst_of_arr[ci]) badInst++;
            if (rp_isSurv[li]) {
                uint64_t wv = rd64(er + 220), wa = rd64(er + 212);
                uint64_t gv = (uint64_t)w[4] | ((uint64_t)w[5] << 32);
                uint64_t ga = (uint64_t)w[6] | ((uint64_t)w[7] << 32);
                if (gv != wv) badVal++;
                if (ga != wa) badAcc++;
                double dv; memcpy(&dv, &wv, 8);
                uint64_t vb = dv == 0.0 ? 0 : wv;
                uint64_t ord = (vb >> 63) ? ~vb : (vb | 0x8000000000000000ull);
                uint64_t gk = (uint64_t)w[8] | ((uint64_t)w[9] << 32);
                if (gk != ~ord) badK++;
            } else if (!rp_inEval[li]) {
                // Value words may also be written by the selection's
                // Pass B for B&B-evaluated children (a different set
                // from the static-tau survivors); only children in
                // neither set must have them zero.
                if (w[4] || w[5] || w[6] || w[7] || w[8] || w[9]) badQ1++;
            }
        }
        // ---- host replay of the selection (selg run_ply_full mirror) --
        uint32_t n = 0;
        for (uint32_t li = 0; li < P->nch; li++) {
            const uint32_t *w = recw + (P->childBase + li - cb0) * 16;
            if ((w[13] >> 8) & 1) { rp_posOf[li] = 0xFFFFFFFFu; continue; }
            rp_posOf[li] = n;
            rp_list[n] = P->childBase + li;
            rp_U[n] = (uint64_t)w[2] | ((uint64_t)w[3] << 32);
            rp_val[n] = (uint64_t)w[4] | ((uint64_t)w[5] << 32);
            n++;
        }
        if (n != nAliveH) selBadAlive++;
        if (n == 0) continue;
        // dedupe by record hash: rep = argmax (ordU desc, pos asc)
        static int32_t htab2[16384];
        for (int i = 0; i < 16384; i++) htab2[i] = -1;
        uint32_t nReps = 0;
        for (uint32_t pos = 0; pos < n; pos++) {
            uint32_t ci = rp_list[pos];
            const uint32_t *w = recw + (ci - cb0) * 16;
            uint64_t fp = (uint64_t)w[0] | ((uint64_t)w[1] << 32); // kernel fp = (w1<<32)|w0 as u64 value
            uint64_t ord = host_ord(rp_U[pos]);
            uint32_t s = (uint32_t)(fp & 16383);
            // host table keyed by the full hash via the records themselves
            int found = -1;
            for (uint32_t it = 0; it < 16384; it++) {
                int32_t e = htab2[s];
                if (e < 0) break;
                uint32_t ci0 = rep_child[e];
                const uint32_t *w0 = recw + (ci0 - cb0) * 16;
                uint64_t fp0 = (uint64_t)w0[0] | ((uint64_t)w0[1] << 32);
                if (fp0 == fp) { found = e; break; }
                s = (s + 1) & 16383;
            }
            if (found < 0) {
                uint32_t s2 = (uint32_t)(fp & 16383);
                while (htab2[s2] >= 0) {
                    uint32_t ci0 = rep_child[htab2[s2]];
                    const uint32_t *w0 = recw + (ci0 - cb0) * 16;
                    uint64_t fp0 = (uint64_t)w0[0] | ((uint64_t)w0[1] << 32);
                    if (fp0 == fp) break;
                    s2 = (s2 + 1) & 16383;
                }
                htab2[s2] = (int32_t)nReps;
                rep_child[nReps] = ci; rep_pos[nReps] = pos; rep_ordU[nReps] = ord;
                nReps++;
            } else if (ord > rep_ordU[found]) {
                rep_child[found] = ci; rep_pos[found] = pos; rep_ordU[found] = ord;
            }
        }
        if (nReps != nRepsH) selBadReps++;
        for (uint32_t i = 0; i < nReps; i++) rep_ord_idx[i] = i;
        qsort(rep_ord_idx, nReps, 4, cmp_reporder);
        // B&B rounds (selg mirror)
        static uint8_t isEval[8192];
        memset(isEval, 0, nReps);
        uint32_t nEval = 0; uint64_t b = 256; int rounds = 0;
        uint32_t ordSave[8192]; memcpy(ordSave, rep_ord_idx, nReps * 4);
        for (;;) {
            uint32_t bcur = b < nReps ? (uint32_t)b : nReps;
            rounds++;
            for (uint32_t j = 0; j < bcur; j++) if (!isEval[j]) { isEval[j] = 1; nEval++; }
            bool stop = false;
            if (nEval >= 96 && nEval < nReps) {
                uint32_t m = 0;
                for (uint32_t j = 0; j < nReps; j++) if (isEval[j]) { uint32_t ri = ordSave[j]; ev_child[m] = rep_child[ri]; ev_gen[m] = rep_pos[ri]; ev_bits[m] = rp_val[rep_pos[ri]]; m++; }
                uint32_t idx[8192]; for (uint32_t a = 0; a < m; a++) idx[a] = a;
                // sort by gen asc, then stable sort by (value desc, gen asc) via cmp_final on gen-sorted array
                for (uint32_t a = 1; a < m; a++) { uint32_t t = idx[a]; uint32_t g = ev_gen[t]; uint32_t a2 = a; while (a2 > 0 && ev_gen[idx[a2 - 1]] > g) { idx[a2] = idx[a2 - 1]; a2--; } idx[a2] = t; }
                qsort(idx, m, 4, cmp_final);
                uint64_t tauBits = ev_bits[idx[95]];
                uint64_t tauOrd = host_ord(tauBits);
                uint32_t tauGen = ev_gen[idx[95]];
                uint32_t nri = ordSave[bcur];
                uint64_t ub = rp_U[rep_pos[nri]];
                uint64_t uo = host_ord(ub);
                if (uo < tauOrd) stop = true;
                else if (uo == tauOrd) stop = (ub == tauBits && rep_pos[nri] > tauGen);
            }
            if (nEval >= nReps || stop || rounds >= 24) break;
            b *= 2;
        }
        if (nEval != nEvalH) selBadEval++;
        { // evaluated SET compare (children)
            uint32_t m = 0;
            for (uint32_t j = 0; j < nReps; j++) if (isEval[j]) ev_child[m++] = rep_child[ordSave[j]];
            qsort(ev_child, m, 4, cmp_u32);
            uint32_t gpu[8192]; uint32_t gm = 0;
            for (uint32_t s = 0; s < nEvalH; s++) gpu[gm++] = evalL[s];
            qsort(gpu, gm, 4, cmp_u32);
            if (gm != m || memcmp(gpu, ev_child, m * 4)) selBadEvalSet++;
        }
        // final sort over evaluated, in gen order base
        uint32_t m = 0;
        for (uint32_t j = 0; j < nReps; j++) if (isEval[j]) { uint32_t ri = ordSave[j]; ev_child[m] = rep_child[ri]; ev_gen[m] = rep_pos[ri]; ev_bits[m] = rp_val[rep_pos[ri]]; m++; }
        { uint32_t idx[8192]; for (uint32_t a = 0; a < m; a++) idx[a] = a;
          for (uint32_t a = 1; a < m; a++) { uint32_t t = idx[a]; uint32_t g = ev_gen[t]; uint32_t a2 = a; while (a2 > 0 && ev_gen[idx[a2 - 1]] > g) { idx[a2] = idx[a2 - 1]; a2--; } idx[a2] = t; }
          qsort(idx, m, 4, cmp_final);
          uint32_t nSel = m < 96 ? m : 96;
          if (nSel != nSelH) selBadSel++;
          const uint32_t *selL = out + 524800 + k * 96;
          uint32_t selpos[96];
          for (uint32_t s2 = 0; s2 < nSel; s2++) {
              selpos[s2] = ev_gen[idx[s2]];
              uint32_t rel = selL[s2] - P->childBase;
              uint32_t gpuPos = rel < P->nch ? rp_posOf[rel] : 0xFFFFFFFFu;
              if (gpuPos != selpos[s2]) selBadPos++;
          }
          // arena check
          const uint32_t *arn = out + 527872 + k * 4224;
          for (uint32_t s2 = 0; s2 < nSel; s2++) {
              uint32_t ci = ev_child[idx[s2]];
              const uint8_t *ch = CREC(ci);
              const uint8_t *ir = finst[inst_of_arr[ci]].raw;
              const uint32_t *w = recw + (ci - cb0) * 16;
              uint32_t a[44];
              for (int i2 = 0; i2 < 20; i2++) a[i2] = rd32(ch + 8 + 4 * i2);
              for (int i2 = 0; i2 < 10; i2++) a[20 + i2] = rd32(ch + 88 + 4 * i2);
              a[30] = rd32(ir + 24);
              { int32_t hk2 = ri32(ir + 28); a[31] = hk2 < 0 ? 0xFFFFFFFFu : (uint32_t)hk2; }
              uint32_t scB = w[14];
              a[32] = (scB >> 6) & 0xFF; a[33] = (uint32_t)((int)(scB & 63) - 1); a[34] = (scB >> 14) & 63;
              a[35] = w[4]; a[36] = w[5]; a[37] = inst_of_arr[ci]; a[38] = ci;
              for (int i2 = 39; i2 < 44; i2++) a[i2] = 0;
              if (memcmp(arn + s2 * 44, a, 44 * 4)) arenaBad++;
          }
          // dump emission
          nplies_d++;
          dput32(&db, P->depth + 1); dput32(&db, nReps); dput32(&db, n); dput32(&db, nSel);
          static uint8_t inEvalPos[8192];
          memset(inEvalPos, 0, n);
          for (uint32_t j = 0; j < nReps; j++) if (isEval[j]) inEvalPos[rep_pos[ordSave[j]]] = 1;
          uint32_t j2 = 0;
          for (uint32_t kk = P->i0; kk < P->i0 + P->ni; kk++) {
              FInst *F = &finst[kk];
              const uint8_t *ch = F->raw + 196;
              for (uint32_t ci2 = 0; ci2 < F->nchild; ci2++, ch += 228) {
                  if (ch[201]) continue;
                  uint32_t pos = rp_posOf[(F->childBase + ci2) - P->childBase];
                  dput64(&db, inEvalPos[pos] ? rp_val[pos] : rp_U[pos]);
                  dput64(&db, 0);
                  dput64(&db, canon_key(F->raw, ch));
                  dput32(&db, F->parent_index);
                  dput32(&db, (uint32_t)F->next_idx);
                  j2++;
              }
          }
          if (j2 != n) { fprintf(stderr, "dump child count mismatch dec %u\n", d); exit(1); }
          for (uint32_t s2 = 0; s2 < nSel; s2++) dput32(&db, selpos[s2]);
        }
    }
    dput32(&dumpBuf, nplies_d);
    if (db.len) { dput(&dumpBuf, db.p, db.len); }
    free(db.p);
}

// ---------------- modes + main --------------------------------------
static uint64_t fnv1a(const uint8_t *p, size_t n) {
    uint64_t h = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 0x100000001b3ULL; }
    return h;
}
int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: pfload <gate|drill|bench|dump|dumpsel> <spv> [G=72] [out.bin]\n"); return 1; }
    const char *mode = argv[1], *spvp = argv[2];
    uint32_t G = (argc >= 4) ? (uint32_t)atoi(argv[3]) : 72u;
    if (G == 0 || G % 12) { fprintf(stderr, "G must be a multiple of 12\n"); return 1; }
    const char *bxp = getenv("BXDUMP"); if (!bxp) bxp = "/home/s0u7a/bxgpu/bxdump.bin";
    const char *bpp = getenv("BPDUMP"); if (!bpp) bpp = "/tmp/s9work/stage1/bpdump180.bin";
    const char *tabp = getenv("TABLES"); if (!tabp) tabp = "/tmp/s9work/gate-data/tables.bin";
    const char *urp = getenv("URES"); if (!urp) urp = "/home/s0u7a/bxgpu/ures.bin";
    load_corpus(bxp);
    load_bpdump(bpp);
    compute_tau();
    decision_ranges();
    // tables (bpxg form)
    double *tabD = malloc(180 * 8);
    { FILE *tf = fopen(tabp, "rb"); if (!tf) { perror("tables"); return 1; }
      uint8_t thdr[8]; if (fread(thdr, 1, 8, tf) != 8) return 1;
      if (rd32(thdr) != 0x4D345442 || rd32(thdr + 4) != 180) { fprintf(stderr, "bad tables header\n"); return 1; }
      if (fread(tabD, 8, 180, tf) != 180) return 1; fclose(tf); }
    // ures
    { FILE *uf = fopen(urp, "rb"); if (!uf) { perror("ures"); return 1; }
      fseek(uf, 0, SEEK_END); long ufl = ftell(uf); fseek(uf, 0, SEEK_SET);
      ures = malloc(ufl); if (fread(ures, 1, ufl, uf) != (size_t)ufl) return 1; fclose(uf);
      if (ufl < 16 || memcmp(ures, "BXU1", 4) || rd64(ures + 8) != g_total_ch) { fprintf(stderr, "bad ures\n"); return 1; } }
    uint32_t *inst52 = pack_inst52();
    uint32_t *inst48 = pack_inst48();
    uint32_t *plcin = pack_plcin();
    uint32_t *gout = pack_gout();
    vk_setup(spvp);
    buffers_setup(inst52, inst48, plcin, tabD, gout);
    pipeline_setup(spvp);
    printf("setup done, G=%u\n", G);

    if (!strcmp(mode, "dumpsel")) {
        if (argc < 5) { fprintf(stderr, "usage: pfload dumpsel <spv> <G> <out.bin>\n"); return 1; }
        FILE *of = fopen(argv[4], "wb");
        if (!of) { perror(argv[4]); return 1; }
        double tot = 0;
        for (uint32_t d = 0; d < NDEC; d++) {
            double sp, wa;
            if (run_decision(d, G, 0, &sp, &wa)) { printf("FAULT dec %u\n", d); fclose(of); return 1; }
            tot += sp;
            const uint32_t *out = (const uint32_t *)bout.ptr;
            for (uint32_t k = 0; k < decPlyN[d]; k++) {
                uint32_t nSel = out[k * 16 + 2];
                fwrite(&nSel, 4, 1, of);
                fwrite(out + 524800 + k * 96, 4, nSel, of);
                fwrite(out + 527872 + k * 4224, 4, nSel * 44, of);
            }
        }
        fclose(of);
        printf("DUMPSEL ok: %u decisions, mean span %.1f us/dec -> %s\n", NDEC, tot / NDEC, argv[4]);
        return 0;
    }

    if (!strcmp(mode, "drill")) {
        double sp, wa;
        int f = run_decision(7, G, 1, &sp, &wa);
        uint32_t *ctrl = (uint32_t *)bctrl.ptr;
        printf("DRILL sabotage: run fault=%d ctrl done=%u error=%u (want fault=1 done=0 error!=0)\n", f, ctrl[0], ctrl[1]);
        if (!(f == 1 && ctrl[0] == 0 && ctrl[1] != 0)) { printf("DRILL FAILED at sabotage stage\n"); return 1; }
        f = run_decision(7, G, 0, &sp, &wa);
        printf("DRILL clean rerun: fault=%d done=%u error=%u span %.1f us\n", f, ctrl[0], ctrl[1], sp);
        if (f) { printf("DRILL FAILED at rerun\n"); return 1; }
        verify_decision(7);
        printf("DRILL verify dec7: hash %llu U %llu feat %llu scal %llu val %llu acc %llu K %llu q1 %llu | sel alive %llu reps %llu eval %llu evalset %llu sel %llu pos %llu arena %llu keptMiss %llu\n",
               (unsigned long long)badHash, (unsigned long long)badU, (unsigned long long)badFeat, (unsigned long long)badScal,
               (unsigned long long)badVal, (unsigned long long)badAcc, (unsigned long long)badK, (unsigned long long)badQ1,
               (unsigned long long)selBadAlive, (unsigned long long)selBadReps, (unsigned long long)selBadEval, (unsigned long long)selBadEvalSet,
               (unsigned long long)selBadSel, (unsigned long long)selBadPos, (unsigned long long)arenaBad, (unsigned long long)keptMiss);
        int bad = (badHash || badU || badFeat || badScal || badVal || badAcc || badK || badQ1 || selBadAlive || selBadReps || selBadEval || selBadEvalSet || selBadSel || selBadPos || arenaBad || keptMiss);
        printf("DRILL %s\n", bad ? "FAILED" : "PASSED");
        return bad ? 1 : 0;
    }
    if (!strcmp(mode, "bench")) {
        if (gpu_busy()) { printf("BENCH REFUSED: another GPU tenant present\n"); return 1; }
        double sp, wa;
        for (int r = 0; r < 2; r++)
            for (uint32_t d = 0; d < 20; d++)
                if (run_decision(d, G, 0, &sp, &wa)) { printf("BENCH warmup fault at dec %u\n", d); return 1; }
        printf("bench warmup done, sclk %d MHz\n", read_sclk());
        double spans[3][256], walls[3][256];
        for (int r = 0; r < 3; r++) {
            for (uint32_t d = 0; d < NDEC; d++) {
                if (run_decision(d, G, 0, &sp, &wa)) { printf("BENCH fault at dec %u\n", d); return 1; }
                spans[r][d] = sp; walls[r][d] = wa;
            }
        }
        for (int r = 0; r < 3; r++) {
            double ms = 0, mw = 0; for (uint32_t d = 0; d < NDEC; d++) { ms += spans[r][d]; mw += walls[r][d]; }
            double sc[256]; memcpy(sc, spans[r], NDEC * 8); qsort(sc, NDEC, 8, cmpd);
            printf("BENCH rep %d: span mean %.1f med %.1f us/dec | wall mean %.1f us/dec | sclk %d MHz\n",
                   r, ms / NDEC, sc[NDEC / 2], mw / NDEC, read_sclk());
        }
        return 0;
    }
    // gate / dump: all decisions, verify each
    int faults = 0;
    double totSpan = 0;
    for (uint32_t d = 0; d < NDEC; d++) {
        double sp, wa;
        int f = run_decision(d, G, 0, &sp, &wa);
        if (f) { printf("dec %u FAULT %d\n", d, f); faults++; continue; }
        totSpan += sp;
        verify_decision(d);
    }
    printf("GATE A: hash %llu U %llu feat %llu scal %llu inst %llu violU %llu keptMiss %llu survRange %llu\n",
           (unsigned long long)badHash, (unsigned long long)badU, (unsigned long long)badFeat, (unsigned long long)badScal,
           (unsigned long long)badInst, (unsigned long long)violU, (unsigned long long)keptMiss, (unsigned long long)badSurvRange);
    printf("GATE B: value %llu accumulated %llu K %llu | non-survivor q1/q2 nonzero %llu\n",
           (unsigned long long)badVal, (unsigned long long)badAcc, (unsigned long long)badK, (unsigned long long)badQ1);
    printf("SELECTION: alive %llu reps %llu eval %llu evalset %llu nsel %llu selpos %llu arena %llu\n",
           (unsigned long long)selBadAlive, (unsigned long long)selBadReps, (unsigned long long)selBadEval,
           (unsigned long long)selBadEvalSet, (unsigned long long)selBadSel, (unsigned long long)selBadPos, (unsigned long long)arenaBad);
    // GATE S over all instances
    { uint32_t *st = (uint32_t *)bstatus.ptr; uint64_t badErr = 0, badCnt = 0;
      for (uint32_t i = 0; i < nfinst; i++) { if ((st[i] & 0xFFu) != 0) badErr++; if ((st[i] >> 16) != finst[i].nchild) badCnt++; }
      printf("GATE S: err instances %llu count mismatches %llu\n", (unsigned long long)badErr, (unsigned long long)badCnt);
      if (badErr || badCnt) faults++; }
    // GATE P over the full corpus
    { uint32_t *exp = pack_plc_expected(); uint32_t *got = (uint32_t *)bplcout.ptr; uint64_t badP = 0;
      for (uint64_t i = 0; i < (uint64_t)g_total_ch * 2; i++) if (got[i] != exp[i]) badP++;
      printf("GATE P: plc mismatches %llu\n", (unsigned long long)badP);
      if (badP) faults++; free(exp); }
    // dump identity
    { DBuf full = { 0 }; dput(&full, "SEL1", 4); dput32(&full, NDEC); dput(&full, dumpBuf.p, dumpBuf.len);
      printf("DUMP: %zu bytes fnv %016llx (reference 288824916 bytes fnv aeec061e4f6c4a0c)\n",
             full.len, (unsigned long long)fnv1a(full.p, full.len));
      if (!strcmp(mode, "dump")) {
          if (argc < 5) { fprintf(stderr, "dump needs out path\n"); return 1; }
          FILE *of = fopen(argv[4], "wb"); fwrite(full.p, 1, full.len, of); fclose(of);
          printf("dump written to %s\n", argv[4]);
      }
      free(full.p); }
    printf("faults %d | span sum %.1f us over %u decisions (mean %.1f)\n", faults, totSpan, NDEC, totSpan / NDEC);
    int bad = faults || badHash || badU || badFeat || badScal || badInst || violU || keptMiss || badSurvRange ||
              badVal || badAcc || badK || badQ1 || selBadAlive || selBadReps || selBadEval || selBadEvalSet ||
              selBadSel || selBadPos || arenaBad;
    printf("GATE %s\n", bad ? "FAILED" : "PASSED");
    return bad ? 1 : 0;
}
