// OPT-STEP2 Vulkan host: single-submit resident pipeline
// (OPT-DESIGN section 1 / step 2, on top of the step-1 selection
// stage and the step-1.5 HOST_CACHED fix).
//
// One decision = one submit. The command buffer contains, for every
// ply (max 15): mg_build (movegen input construction on GPU) ->
// movegen (indirect) -> ex_scan (child prefix offsets + indirect
// args) -> ex_build (indirect) -> expand (indirect) -> GPU selection
// (prep / radix sorts / segment / repair / flags / compact) -> leaf
// collection (prep / tile sums / scan / scatter). All ply handoffs
// are device-local; dispatch sizes come from device-side counters
// via indirect dispatch. The host only reads back a fixed-size state
// mirror after the submit (plus, in run mode, the arena / leaf /
// beam arrays needed to emit the wire output and run the final
// selection with the step-1 host semantics).
//
// Scratch that must be device-local is asserted at startup
// (mkbuf_dev), as in step 1.
//
// Modes:
//   expandcheck <expand.spv> <tables.bin> <cases.bin> [device]
//   run <movegen.spv> <expand.spv> <tables.bin> <decisions.bin> <out.bin> [max_decisions] [device]
//   bench <movegen.spv> <expand.spv> <tables.bin> <decisions.bin> <reps> [device]
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <math.h>
#include <unistd.h>
#include <vulkan/vulkan.h>

static void die(const char *m, VkResult r) { fprintf(stderr, "FAIL %s (%d)\n", m, r); exit(1); }
#define CK(x) do { VkResult _r = (x); if (_r != VK_SUCCESS) die(#x, _r); } while (0)

static uint8_t *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(n ? n : 1); if (n && fread(b, 1, n, f) != (size_t)n) exit(1);
    fclose(f); *len = n; return b;
}
static double now_s(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec + ts.tv_nsec * 1e-9; }
static double now_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6; }
static int cmp_double(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return (x > y) - (x < y); }
static uint32_t rd32(const uint8_t **p) { uint32_t v; memcpy(&v, *p, 4); *p += 4; return v; }

// ---- layout constants (mirror s2_common.glsl) ----
#define MG_IN_WORDS 48u
#define MG_OUT_WORDS 10244u
#define MG_SCRATCH_WORDS 51200u
#define EX_IN_STRIDE 104u
#define EX_OUT_STRIDE 108u
#define TB_MAGIC 0x4D345442u
#define EX_MAGIC 0x4D344558u
#define DC_MAGIC 0x4D344443u
#define RS_MAGIC 0x4D345253u
#define DEC_WORDS 108u
#define MAX_INST 192u
#define MAX_CHILD 32768u
#define HT_WORDS 491520u  // S19f: 15 ply regions x 32768 words
#define WIDTH 96
#define MAXPLY 15
#define ARENA_CAP 262144u
#define LEAF_CAP 266240u
#define MAX_TILES (MAX_CHILD / 256u)
#define LEAF_SLOTS_MAX (MAX_CHILD + 96u)

#define ST_ERROR 0u
#define ST_ARENA_NEXT 1u
#define ST_LEAVES_NEXT 2u
#define ST_LN1P 3u
#define ST_N_INST 4u
#define ST_N_CHILD 19u
#define ST_ARENA_BASE 34u
#define ST_LEAF_BASE 49u
#define ST_LEAF_COUNT 64u
#define ST_BEAM_COUNT 79u
#define ST_SURV_TOTAL 95u
#define ST_REPAIR_ERR 110u
#define ST_LEAF_SLOTS 125u
#define ST_WORDS 140u

#define PM_SEQ_LEN 0u
#define PM_BOARD_LEN 1u
#define PM_ACTIVE_ROT 2u
#define PM_ACTIVE_X 3u
#define PM_ACTIVE_Y 4u
#define PM_ROOT_HOLD 5u
#define PM_ROOT_CAN_HOLD 6u
#define PM_ROOT_DUE 7u
#define PM_SEQ 8u
#define PM_WORDS 23u
#define PM_OPTS 22u

// ---- rules profile selection (one setting, resolved once) ----
// ATTAX_GPU_PROFILE=s2 (default) keeps the step-26 S2 pipeline
// byte-identical: the same SPV names, the same dispatch stream, and
// params words 0..21 unchanged. ATTAX_GPU_PROFILE=guideline swaps
// five pipelines for their guideline variants at pipeline_init and
// writes movegen opts 0 (no spin evidence, no 180 inputs) into
// params word 22, which only the guideline mg_build reads; the S2
// mg_build hardcodes opts 7 and never reads word 22. The switch is
// resolved here, once per process, never per decision or per child.
static int g_profile_guideline = 0;
static uint32_t g_profile_opts = 7u;
static void profile_resolve(void) {
    const char *p = getenv("ATTAX_GPU_PROFILE");
    if (p && !strcmp(p, "guideline")) {
        g_profile_guideline = 1;
        g_profile_opts = 0u;
    } else {
        g_profile_guideline = 0;
        g_profile_opts = 7u;
    }
    fprintf(stderr, "profile: %s (movegen opts %u)\n",
            g_profile_guideline ? "guideline" : "s2", g_profile_opts);
}

#define ARG_MG 0u
#define ARG_EXB 1u
#define ARG_EXP 2u
#define ARG_TILE 3u
#define ARG_LEAFP 4u
#define ARG_LEAFS 5u
#define ARG_KINDS 6u

static VkPhysicalDeviceMemoryProperties memprops;
static VkDevice dev;
// OPT-STEP21: VK_EXT_conditional_rendering predication of the sort
// train (see s21_pred_begin). g_have_condrend is set in vk_setup when
// the extension is present; the PFNs are loaded after device creation.
static int g_have_condrend = 0;
static PFN_vkCmdBeginConditionalRenderingEXT pfnBeginCR = NULL;
static PFN_vkCmdEndConditionalRenderingEXT pfnEndCR = NULL;
static VkQueue queue;
static VkCommandPool pool;
static VkQueryPool tpool;
static double ts_period_ns = 0.0;
static double g_submit_ms = 0.0;

typedef struct { VkBuffer buf; VkDeviceMemory mem; void *ptr; VkDeviceSize size; uint32_t type; } Buf;

static Buf mkbuf2(VkDeviceSize size, VkBufferUsageFlags usage, VkMemoryPropertyFlags need, VkMemoryPropertyFlags prefer, int map) {
    Buf b; b.size = size; b.ptr = NULL; b.type = UINT32_MAX;
    VkBufferCreateInfo ci = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, NULL, 0, size, usage, VK_SHARING_MODE_EXCLUSIVE, 0, NULL };
    CK(vkCreateBuffer(dev, &ci, NULL, &b.buf));
    VkMemoryRequirements req; vkGetBufferMemoryRequirements(dev, b.buf, &req);
    uint32_t type = UINT32_MAX;
    for (int pass = 0; pass < 2 && type == UINT32_MAX; pass++) {
        for (uint32_t i = 0; i < memprops.memoryTypeCount; i++) {
            if (!(req.memoryTypeBits & (1u << i))) continue;
            VkMemoryPropertyFlags f = memprops.memoryTypes[i].propertyFlags;
            if ((f & need) != need) continue;
            if (pass == 0 && (f & prefer) != prefer) continue;
            type = i; break;
        }
    }
    if (type == UINT32_MAX) { fprintf(stderr, "no memory type for need=0x%x\n", need); exit(1); }
    b.type = type;
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, req.size, type };
    CK(vkAllocateMemory(dev, &ai, NULL, &b.mem));
    CK(vkBindBufferMemory(dev, b.buf, b.mem, 0));
    if (map) CK(vkMapMemory(dev, b.mem, 0, size, 0, &b.ptr));
    return b;
}
static Buf mkbuf(VkDeviceSize size, VkBufferUsageFlags usage) {
    // Step 1.5: prefer a HOST_CACHED type for host-visible buffers.
    return mkbuf2(size, usage, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                  VK_MEMORY_PROPERTY_HOST_CACHED_BIT, 1);
}
static void freebuf(Buf *b) {
    if (b->ptr) vkUnmapMemory(dev, b->mem);
    if (b->buf) vkDestroyBuffer(dev, b->buf, NULL);
    if (b->mem) vkFreeMemory(dev, b->mem, NULL);
    b->ptr = NULL; b->buf = VK_NULL_HANDLE; b->mem = VK_NULL_HANDLE;
}
// Device-local buffer with a hard startup check (the M3 GTT trap as a
// permanent guard, OPT-DESIGN 1.3 / step 1).
static Buf mkbuf_dev(VkDeviceSize size, const char *name) {
    Buf b = mkbuf2(size, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                   VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, 0);
    VkMemoryPropertyFlags f = memprops.memoryTypes[b.type].propertyFlags;
    printf("scratch %-10s memtype %u flags 0x%x heap %u, %.1f KiB\n", name, b.type, f,
           memprops.memoryTypes[b.type].heapIndex, size / 1024.0);
    if (!(f & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) {
        fprintf(stderr, "FATAL: scratch buffer %s is not device-local (memtype %u)\n", name, b.type);
        exit(1);
    }
    return b;
}
static void assert_dev_local(const Buf *b, const char *name) {
    VkMemoryPropertyFlags f = memprops.memoryTypes[b->type].propertyFlags;
    printf("scratch %-10s memtype %u flags 0x%x heap %u, %.1f KiB\n", name, b->type, f,
           memprops.memoryTypes[b->type].heapIndex, b->size / 1024.0);
    if (!(f & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) {
        fprintf(stderr, "FATAL: buffer %s is not device-local (memtype %u)\n", name, b->type);
        exit(1);
    }
}

typedef struct {
    VkDescriptorSetLayout dsl;
    VkPipelineLayout layout;
    VkPipeline pipe;
    VkDescriptorPool dpool;
} Pipe;

static Pipe make_pipe(const char *spvpath, int nbindings, uint32_t push_bytes) {
    Pipe p;
    VkDescriptorSetLayoutBinding binds[12];
    for (int i = 0; i < nbindings; i++)
        binds[i] = (VkDescriptorSetLayoutBinding){ (uint32_t)i, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL };
    VkDescriptorSetLayoutCreateInfo lci = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, NULL, 0, (uint32_t)nbindings, binds };
    CK(vkCreateDescriptorSetLayout(dev, &lci, NULL, &p.dsl));
    VkPushConstantRange pcr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, push_bytes };
    VkPipelineLayoutCreateInfo plci = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, NULL, 0, 1, &p.dsl, push_bytes ? 1 : 0, &pcr };
    if (!push_bytes) plci.pushConstantRangeCount = 0;
    CK(vkCreatePipelineLayout(dev, &plci, NULL, &p.layout));
    VkDescriptorPoolSize dps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 128 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, NULL, 0, 16, 1, &dps };
    CK(vkCreateDescriptorPool(dev, &dpi, NULL, &p.dpool));
    size_t slen; uint8_t *spv = slurp(spvpath, &slen);
    VkShaderModuleCreateInfo smi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, NULL, 0, slen, (uint32_t *)spv };
    VkShaderModule sm; CK(vkCreateShaderModule(dev, &smi, NULL, &sm));
    VkComputePipelineCreateInfo cci = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, NULL, 0,
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, NULL, 0, VK_SHADER_STAGE_COMPUTE_BIT, sm, "main", NULL },
        p.layout, VK_NULL_HANDLE, 0 };
    CK(vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &cci, NULL, &p.pipe));
    free(spv);
    return p;
}

static VkDescriptorSet make_set(Pipe *p, Buf **bufs, int n) {
    VkDescriptorSetAllocateInfo ai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, NULL, p->dpool, 1, &p->dsl };
    VkDescriptorSet set; CK(vkAllocateDescriptorSets(dev, &ai, &set));
    VkWriteDescriptorSet writes[12]; VkDescriptorBufferInfo infos[12];
    for (int i = 0; i < n; i++) {
        infos[i] = (VkDescriptorBufferInfo){ bufs[i]->buf, 0, VK_WHOLE_SIZE };
        writes[i] = (VkWriteDescriptorSet){ VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, set, (uint32_t)i, 0, 1,
                                            VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NULL, &infos[i], NULL };
    }
    vkUpdateDescriptorSets(dev, (uint32_t)n, writes, 0, NULL);
    return set;
}

static VkCommandBuffer begin_cmd(void) {
    VkCommandBufferAllocateInfo ai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer cmd; CK(vkAllocateCommandBuffers(dev, &ai, &cmd));
    VkCommandBufferBeginInfo bi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, NULL };
    CK(vkBeginCommandBuffer(cmd, &bi));
    return cmd;
}
static void submit_wait(VkCommandBuffer cmd) {
    double t0 = now_ms();
    CK(vkEndCommandBuffer(cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cmd, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    CK(vkQueueWaitIdle(queue));
    vkFreeCommandBuffers(dev, pool, 1, &cmd);
    g_submit_ms += now_ms() - t0;
}
// Full compute-to-compute memory barrier between dependent dispatches
// recorded in one command buffer.
static void barrier_rw(VkCommandBuffer cmd) {
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL,
                           VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         0, 1, &mb, 0, NULL, 0, NULL);
}
static void barrier_transfer_to_compute(VkCommandBuffer cmd) {
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL,
                           VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         0, 1, &mb, 0, NULL, 0, NULL);
}
static void barrier_compute_to_transfer(VkCommandBuffer cmd) {
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL,
                           VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         0, 1, &mb, 0, NULL, 0, NULL);
}

static void vk_setup(const char *want) {
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "attax-s2", 1, "none", 1, VK_API_VERSION_1_2 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 0, NULL };
    VkInstance inst; CK(vkCreateInstance(&ici, NULL, &inst));
    uint32_t ndev = 0; CK(vkEnumeratePhysicalDevices(inst, &ndev, NULL));
    VkPhysicalDevice *devs = malloc(ndev * sizeof *devs);
    CK(vkEnumeratePhysicalDevices(inst, &ndev, devs));
    VkPhysicalDevice phys = VK_NULL_HANDLE;
    VkPhysicalDeviceProperties props; memset(&props, 0, sizeof props);
    for (uint32_t i = 0; i < ndev; i++) {
        VkPhysicalDeviceProperties p; vkGetPhysicalDeviceProperties(devs[i], &p);
        VkPhysicalDeviceFeatures f; vkGetPhysicalDeviceFeatures(devs[i], &f);
        if (f.shaderInt64 && strstr(p.deviceName, want)) { phys = devs[i]; props = p; }
    }
    if (phys == VK_NULL_HANDLE) { fprintf(stderr, "no shaderInt64 device matching '%s'\n", want); exit(1); }
    printf("selected: %s (timestampPeriod %.1f ns)\n", props.deviceName, props.limits.timestampPeriod);
    ts_period_ns = props.limits.timestampPeriod;
    vkGetPhysicalDeviceMemoryProperties(phys, &memprops);
    for (uint32_t i = 0; i < memprops.memoryTypeCount; i++) {
        fprintf(stderr, "memtype %u: flags 0x%x heap %u (heap size %.0f MiB)\n", i,
                (unsigned)memprops.memoryTypes[i].propertyFlags, memprops.memoryTypes[i].heapIndex,
                memprops.memoryHeaps[memprops.memoryTypes[i].heapIndex].size / 1048576.0);
    }
    uint32_t nqf = 0; vkGetPhysicalDeviceQueueFamilyProperties(phys, &nqf, NULL);
    VkQueueFamilyProperties *qf = malloc(nqf * sizeof *qf);
    vkGetPhysicalDeviceQueueFamilyProperties(phys, &nqf, qf);
    uint32_t qfi = UINT32_MAX;
    for (uint32_t i = 0; i < nqf; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfi = i; break; }
    if (qfi == UINT32_MAX || qf[qfi].timestampValidBits == 0) { fprintf(stderr, "no compute queue with timestamps\n"); exit(1); }
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, qfi, 1, &prio };
    VkPhysicalDeviceFeatures feats = {0}; feats.shaderInt64 = VK_TRUE;
    uint32_t nexts = 0; vkEnumerateDeviceExtensionProperties(phys, NULL, &nexts, NULL);
    VkExtensionProperties *exts = malloc(nexts * sizeof *exts);
    vkEnumerateDeviceExtensionProperties(phys, NULL, &nexts, exts);
    const char *want_exts[4]; uint32_t nwant = 0;
    for (uint32_t i = 0; i < nexts; i++)
        if (!strcmp(exts[i].extensionName, VK_AMD_SHADER_INFO_EXTENSION_NAME)) want_exts[nwant++] = VK_AMD_SHADER_INFO_EXTENSION_NAME;
    for (uint32_t i = 0; i < nexts; i++)
        if (!strcmp(exts[i].extensionName, VK_EXT_CONDITIONAL_RENDERING_EXTENSION_NAME)) { want_exts[nwant++] = VK_EXT_CONDITIONAL_RENDERING_EXTENSION_NAME; g_have_condrend = 1; }
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, NULL, 0, 1, &qci, 0, NULL, nwant, want_exts, &feats };
    CK(vkCreateDevice(phys, &dci, NULL, &dev));
    vkGetDeviceQueue(dev, qfi, 0, &queue);
    if (g_have_condrend) {
        pfnBeginCR = (PFN_vkCmdBeginConditionalRenderingEXT)vkGetDeviceProcAddr(dev, "vkCmdBeginConditionalRenderingEXT");
        pfnEndCR = (PFN_vkCmdEndConditionalRenderingEXT)vkGetDeviceProcAddr(dev, "vkCmdEndConditionalRenderingEXT");
        if (!pfnBeginCR || !pfnEndCR) g_have_condrend = 0;
    }
    fprintf(stderr, "step21: VK_EXT_conditional_rendering %s\n", g_have_condrend ? "ENABLED" : "unavailable (train recorded live)");
    VkCommandPoolCreateInfo cpi = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, qfi };
    CK(vkCreateCommandPool(dev, &cpi, NULL, &pool));
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, 8, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &tpool));
}

// ---- tables file ----
static Buf load_tables(const char *path) {
    size_t len; uint8_t *raw = slurp(path, &len);
    const uint8_t *p = raw;
    if (rd32(&p) != TB_MAGIC) { fprintf(stderr, "bad tables magic\n"); exit(1); }
    uint32_t n = rd32(&p);
    if (len != 8 + (size_t)n * 8) { fprintf(stderr, "tables size mismatch\n"); exit(1); }
    Buf b = mkbuf((VkDeviceSize)n * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    memcpy(b.ptr, p, (size_t)n * 8);
    free(raw);
    return b;
}

static double bits_f64(uint64_t b) { double v; memcpy(&v, &b, 8); return v; }
static uint64_t ord_key(double v) {
    if (v == 0.0) v = 0.0; // normalize -0 to +0
    uint64_t b; memcpy(&b, &v, 8);
    return (b >> 63) ? ~b : (b | 0x8000000000000000ULL);
}

// ---- output writer (wire format, same as step 1) ----
typedef struct { uint8_t *buf; size_t len, cap; } Out;
static void ow(Out *o, const void *src, size_t n) {
    if (o->len + n > o->cap) {
        o->cap = (o->len + n) * 2 + 65536;
        o->buf = realloc(o->buf, o->cap);
    }
    memcpy(o->buf + o->len, src, n);
    o->len += n;
}
static void ow32(Out *o, uint32_t v) { ow(o, &v, 4); }
static void ow64(Out *o, uint64_t v) { ow(o, &v, 8); }
static void owf64(Out *o, double v) { uint64_t b; memcpy(&b, &v, 8); ow64(o, b); }

// ---- pipeline resources ----
static Buf g_tables;
static Buf g_params, g_root_stage, g_state_mirror, g_state_stage;
static Buf g_stage_in, g_stage_out, g_stage_keys;
static Buf g_state, g_args, g_arena, g_keys_arena, g_beam_idx;
static Buf g_mg_in_d, g_mg_scratch, g_mg_out_d;
static Buf g_inst_meta, g_node_first_inst, g_self_leaf;
static Buf g_inst_child_base, g_child_inst, g_child_local, g_node_arrays;
static Buf g_ex_in_d, g_selkeys, g_idxA, g_idxB, g_idxC, g_tilehist, g_tileoff, g_head, g_surv;
static Buf g_tilehist2;  // S18: pass-A first histogram (fused hist output)
static Buf g_ex_soa_d;  // S23: SoA-transposed expand input
static Buf g_htable;  // S19: dedupe hash table (HT_WORDS words)
static Buf g_leaf_flag, g_leaf_src, g_leaf_tsum, g_leaf_toff, g_leaf_idx;
static Buf g_snap;
static Buf g_binall, g_blk, g_selctl, g_bitargs, g_idxD, g_idxE, g_scanargs;

static Pipe g_init_pipe, g_mg_pipe, g_mgb_pipe, g_exs_pipe, g_exb_pipe, g_ex_pipe;
static Pipe g_prep_pipe, g_hist_pipe, g_scan_pipe, g_scatter_pipe;
static Pipe g_fscat_pipe;
static Pipe g_fhist_pipe;  // S18
static Pipe g_fscatK_pipe;
static Pipe g_segment_pipe, g_repair_pipe, g_flags_pipe, g_compact_pipe, g_idxcopy_pipe;
static Pipe g_mega_pipe;  // S21: single-WG full sort
static Pipe g_passA_pipe;  // S22: single-WG pass A (bytes 6+7)
static Pipe g_h6x_pipe, g_h7f_pipe;  // S22: byte-7 hist byproduct pair
static Pipe g_phx_pipe;  // S26: prep fused into byte-6 histogram
static Pipe g_exs26_pipe;  // S26: ex_scan + leaf tsum zeroing/base snapshot
static Pipe g_leafprep26_pipe, g_leafscatter26_pipe;  // S26: leaf fusion pair
static Pipe g_ext_pipe;  // S23: AoS->SoA transpose
static Pipe g_leafprep_pipe, g_leafsum_pipe, g_leafscan_pipe, g_leafscatter_pipe;
static Pipe g_resolve_pipe;
static Pipe g_htins_pipe, g_htlook_pipe, g_htclr_pipe;  // S19
static Pipe g_snap_pipe;
static Pipe g_binhist_pipe, g_thresh_pipe, g_bitonic_pipe, g_compact5_pipe, g_clear_pipe;
static VkDescriptorSet g_hist_set_pd, g_scatter_set_pd, g_scatter_set_pe;
static VkDescriptorSet g_fscat_set_pd, g_fscat_set_pe;
static VkDescriptorSet g_fhist_set, g_fscat_set_pd2;  // S18
static VkDescriptorSet g_hist_set_a19;  // S19g: pass-A hist1 -> tilehist2
static VkDescriptorSet g_fscatK_set[2];
static VkDescriptorSet g_init_set, g_mg_set, g_mgb_set, g_exs_set, g_exb_set, g_ex_set;
static VkDescriptorSet g_prep_set, g_scan_set, g_segment_set, g_repair_set, g_flags_set, g_compact_set, g_idxcopy_set;
static VkDescriptorSet g_mega_set;  // S21
static VkDescriptorSet g_passA_set;  // S22
static VkDescriptorSet g_h6x_set, g_h7f_set_pd2;  // S22
static VkDescriptorSet g_phx_set;  // S26
static VkDescriptorSet g_exs26_set;  // S26
static VkDescriptorSet g_leafprep26_set, g_leafscatter26_set;  // S26
static VkDescriptorSet g_ex_set_soa, g_exb_set_soa, g_ext_set;  // S23
static VkDescriptorSet g_hist_set[2], g_scatter_set[2];
static VkDescriptorSet g_leafprep_set, g_leafsum_set, g_leafscan_set, g_leafscatter_set;
static VkDescriptorSet g_resolve_set;
static VkDescriptorSet g_htins_set, g_htlook_set, g_htclr_set;  // S19
static VkDescriptorSet g_snap_set;
static VkDescriptorSet g_binhist_set, g_thresh_set, g_bitonic_set, g_compact5_set, g_clear_set;
static uint32_t g_serial_base = 1;

static char *spv_join(const char *ex_spv, const char *name);  // defined below

// Profile-dependent SPV name in the expand SPV's directory.
static char *prof_spv(const char *ex_spv, const char *s2_name, const char *gl_name) {
    return spv_join(ex_spv, g_profile_guideline ? gl_name : s2_name);
}

static char *spv_join(const char *ex_spv, const char *name) {
    const char *slash = strrchr(ex_spv, '/');
    size_t dlen = slash ? (size_t)(slash - ex_spv + 1) : 0;
    char *out = malloc(dlen + strlen(name) + 1);
    memcpy(out, ex_spv, dlen);
    strcpy(out + dlen, name);
    return out;
}

// with_mg=0 skips the movegen-dependent pipes (expandcheck mode).
static void pipeline_init(const char *mg_spv, const char *ex_spv, const char *tables_path, int with_mg) {
    g_tables = load_tables(tables_path);
    g_params = mkbuf((VkDeviceSize)PM_WORDS * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    g_root_stage = mkbuf((VkDeviceSize)EX_OUT_STRIDE * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    g_state_mirror = mkbuf((VkDeviceSize)ST_WORDS * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    g_state_stage = mkbuf((VkDeviceSize)ST_WORDS * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    g_stage_in = mkbuf((VkDeviceSize)MAX_CHILD * EX_IN_STRIDE * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    g_stage_out = mkbuf((VkDeviceSize)MAX_CHILD * EX_OUT_STRIDE * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    g_stage_keys = mkbuf((VkDeviceSize)MAX_CHILD * 4 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);

    g_state = mkbuf_dev((VkDeviceSize)ST_WORDS * 4, "state");
    {
        // args buffer also needs INDIRECT_BUFFER usage
        Buf b = mkbuf2((VkDeviceSize)MAXPLY * ARG_KINDS * 3 * 4,
                       VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                       VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, 0);
        g_args = b;
        assert_dev_local(&g_args, "args");
    }
    g_arena = mkbuf_dev((VkDeviceSize)ARENA_CAP * EX_OUT_STRIDE * 4, "arena");
    g_keys_arena = mkbuf_dev((VkDeviceSize)ARENA_CAP * 4 * 4, "keys-arena");
    g_beam_idx = mkbuf_dev((VkDeviceSize)(MAXPLY + 1) * WIDTH * 4, "beam-idx");
    g_mg_in_d = mkbuf_dev((VkDeviceSize)MAX_INST * MG_IN_WORDS * 4, "mg-in");
    g_mg_scratch = mkbuf2((VkDeviceSize)MAX_INST * MG_SCRATCH_WORDS * 4,
                          VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                          VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, 0, 0);
    assert_dev_local(&g_mg_scratch, "mg-scratch");
    g_mg_out_d = mkbuf_dev((VkDeviceSize)MAX_INST * MG_OUT_WORDS * 4, "mg-out");
    g_inst_meta = mkbuf_dev((VkDeviceSize)MAX_INST * 5 * 4, "inst-meta");
    g_node_first_inst = mkbuf_dev((VkDeviceSize)(WIDTH + 1) * 4, "node-first");
    g_self_leaf = mkbuf_dev((VkDeviceSize)WIDTH * 4, "self-leaf");
    g_inst_child_base = mkbuf_dev((VkDeviceSize)(MAX_INST + 1) * 4, "inst-cbase");
    g_child_inst = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "child-inst");
    g_child_local = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "child-local");
    g_node_arrays = mkbuf_dev((VkDeviceSize)384 * 4, "node-arrays");
    g_ex_in_d = mkbuf_dev((VkDeviceSize)MAX_CHILD * EX_IN_STRIDE * 4, "ex-in");
    g_ex_soa_d = mkbuf_dev((VkDeviceSize)MAX_CHILD * EX_IN_STRIDE * 4, "ex-soa");  // S23
    g_selkeys = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4 * 4, "selkeys");
    g_idxA = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "idxA");
    g_idxB = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "idxB");
    g_idxC = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "idxC");
    g_tilehist = mkbuf_dev((VkDeviceSize)256 * MAX_TILES * 4, "tilehist");
    g_tilehist2 = mkbuf_dev((VkDeviceSize)256 * MAX_TILES * 4, "tilehist2");
    g_htable = mkbuf_dev((VkDeviceSize)HT_WORDS * 4, "htable");
    g_tileoff = mkbuf_dev((VkDeviceSize)256 * MAX_TILES * 4, "tileoff");
    g_head = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "head");
    g_surv = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "surv");
    g_snap = mkbuf((VkDeviceSize)MAXPLY * MAX_CHILD * 4 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    g_binall = mkbuf_dev(131072 * 4, "binall");
    g_blk = mkbuf_dev(512 * 4, "blk");
    g_selctl = mkbuf_dev((VkDeviceSize)MAXPLY * 4, "selctl");
    g_bitargs = mkbuf((VkDeviceSize)MAXPLY * 12, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT | VK_BUFFER_USAGE_CONDITIONAL_RENDERING_BIT_EXT);
    g_idxD = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "idxD");
    g_scanargs = mkbuf((VkDeviceSize)MAXPLY * 12, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT);
    memset(g_scanargs.ptr, 0, MAXPLY * 12);
    g_idxE = mkbuf_dev((VkDeviceSize)MAX_CHILD * 4, "idxE");
    g_leaf_flag = mkbuf_dev((VkDeviceSize)LEAF_SLOTS_MAX * 4, "leaf-flag");
    g_leaf_src = mkbuf_dev((VkDeviceSize)LEAF_SLOTS_MAX * 4, "leaf-src");
    g_leaf_tsum = mkbuf_dev((VkDeviceSize)160 * 4, "leaf-tsum");
    g_leaf_toff = mkbuf_dev((VkDeviceSize)160 * 4, "leaf-toff");
    g_leaf_idx = mkbuf_dev((VkDeviceSize)LEAF_CAP * 4, "leaf-idx");
    fprintf(stderr, "host-visible buffers: params type %u flags 0x%x heap %u\n",
            g_params.type, (unsigned)memprops.memoryTypes[g_params.type].propertyFlags,
            (unsigned)memprops.memoryTypes[g_params.type].heapIndex);

    g_ex_pipe = make_pipe(g_profile_guideline ? spv_join(ex_spv, "expand_gl.spv") : (char *)ex_spv, 5, 4);
    {
        Buf *exbufs[5] = { &g_ex_in_d, &g_arena, &g_tables, &g_keys_arena, &g_state };
        g_ex_set = make_set(&g_ex_pipe, exbufs, 5);
    }
    {   // S23: expand set over the SoA buffer + AoS->SoA transpose pipe
        Buf *exbufs2[5] = { &g_ex_soa_d, &g_arena, &g_tables, &g_keys_arena, &g_state };
        g_ex_set_soa = make_set(&g_ex_pipe, exbufs2, 5);
    }
    g_ext_pipe = make_pipe(spv_join(ex_spv, "ex_transpose23.spv"), 3, 4);
    {
        Buf *b[3] = { &g_ex_in_d, &g_ex_soa_d, &g_state };
        g_ext_set = make_set(&g_ext_pipe, b, 3);
    }
    if (!with_mg) return;

    g_init_pipe = make_pipe(spv_join(ex_spv, "s2_init.spv"), 2, 0);
    {
        Buf *b[2] = { &g_state, &g_beam_idx };
        g_init_set = make_set(&g_init_pipe, b, 2);
    }
    g_mg_pipe = make_pipe(mg_spv, 3, 8);
    {
        Buf *b[3] = { &g_mg_in_d, &g_mg_scratch, &g_mg_out_d };
        g_mg_set = make_set(&g_mg_pipe, b, 3);
    }
    g_mgb_pipe = make_pipe(prof_spv(ex_spv, "mg_build.spv", "mg_build_gl.spv"), 9, 4);
    {
        Buf *b[9] = { &g_params, &g_arena, &g_beam_idx, &g_state, &g_mg_in_d, &g_inst_meta, &g_node_first_inst, &g_self_leaf, &g_args };
        g_mgb_set = make_set(&g_mgb_pipe, b, 9);
    }
    g_exs_pipe = make_pipe(spv_join(ex_spv, "ex_scan.spv"), 9, 4);
    {
        Buf *b[9] = { &g_state, &g_mg_out_d, &g_node_first_inst, &g_self_leaf, &g_inst_child_base, &g_child_inst, &g_child_local, &g_node_arrays, &g_args };
        g_exs_set = make_set(&g_exs_pipe, b, 9);
    }
    g_exs26_pipe = make_pipe(spv_join(ex_spv, "ex_scan26.spv"), 10, 4);
    {
        Buf *b[10] = { &g_state, &g_mg_out_d, &g_node_first_inst, &g_self_leaf, &g_inst_child_base, &g_child_inst, &g_child_local, &g_node_arrays, &g_args, &g_leaf_tsum };
        g_exs26_set = make_set(&g_exs26_pipe, b, 10);
    }
    g_exb_pipe = make_pipe(prof_spv(ex_spv, "ex_build.spv", "ex_build_gl.spv"), 9, 4);
    {
        Buf *b[9] = { &g_state, &g_params, &g_arena, &g_beam_idx, &g_inst_meta, &g_child_inst, &g_child_local, &g_mg_out_d, &g_ex_in_d };
        g_exb_set = make_set(&g_exb_pipe, b, 9);
    }
    {   // S23: ex_build set writing the SoA buffer directly
        Buf *b2[9] = { &g_state, &g_params, &g_arena, &g_beam_idx, &g_inst_meta, &g_child_inst, &g_child_local, &g_mg_out_d, &g_ex_soa_d };
        g_exb_set_soa = make_set(&g_exb_pipe, b2, 9);
    }
    g_prep_pipe = make_pipe(spv_join(ex_spv, "sel_prep_s2.spv"), 5, 4);
    {
        Buf *b[5] = { &g_keys_arena, &g_arena, &g_selkeys, &g_idxA, &g_state };
        g_prep_set = make_set(&g_prep_pipe, b, 5);
    }
    g_hist_pipe = make_pipe(spv_join(ex_spv, "sort_hist_s2.spv"), 4, 12);
    {
        Buf *b0[4] = { &g_selkeys, &g_idxA, &g_tilehist, &g_state };
        Buf *b1[4] = { &g_selkeys, &g_idxB, &g_tilehist, &g_state };
        g_hist_set[0] = make_set(&g_hist_pipe, b0, 4);
        g_hist_set[1] = make_set(&g_hist_pipe, b1, 4);
    }
    g_fhist_pipe = make_pipe(spv_join(ex_spv, "sort_hist_fuse18.spv"), 5, 12);
    {
        Buf *b[5] = { &g_selkeys, &g_idxA, &g_tilehist, &g_tilehist2, &g_state };
        g_fhist_set = make_set(&g_fhist_pipe, b, 5);
    }
    {   // S19g: single pass-A hist1 (K byte 6) into tilehist2.
        Buf *b[4] = { &g_selkeys, &g_idxA, &g_tilehist2, &g_state };
        g_hist_set_a19 = make_set(&g_hist_pipe, b, 4);
    }
    g_scan_pipe = make_pipe(spv_join(ex_spv, "sort_scan_s2.spv"), 3, 4);
    {
        Buf *b[3] = { &g_tilehist, &g_tileoff, &g_state };
        g_scan_set = make_set(&g_scan_pipe, b, 3);
    }
    g_scatter_pipe = make_pipe(spv_join(ex_spv, "sort_scatter_s2.spv"), 5, 12);
    {
        Buf *b0[5] = { &g_selkeys, &g_idxA, &g_idxB, &g_tileoff, &g_state };
        Buf *b1[5] = { &g_selkeys, &g_idxB, &g_idxA, &g_tileoff, &g_state };
        g_scatter_set[0] = make_set(&g_scatter_pipe, b0, 5);
        g_scatter_set[1] = make_set(&g_scatter_pipe, b1, 5);
    }
    g_segment_pipe = make_pipe(spv_join(ex_spv, "sel_segment_s2.spv"), 4, 4);
    {
        Buf *b[4] = { &g_idxA, &g_arena, &g_head, &g_state };
        g_segment_set = make_set(&g_segment_pipe, b, 4);
    }
    g_repair_pipe = make_pipe(spv_join(ex_spv, "sel_repair_s2.spv"), 5, 4);
    {
        Buf *b[5] = { &g_idxA, &g_selkeys, &g_arena, &g_head, &g_state };
        g_repair_set = make_set(&g_repair_pipe, b, 5);
    }
    g_flags_pipe = make_pipe(spv_join(ex_spv, "sel_flags_s2.spv"), 4, 4);
    {
        Buf *b[4] = { &g_idxA, &g_head, &g_surv, &g_state };
        g_flags_set = make_set(&g_flags_pipe, b, 4);
    }
    g_resolve_pipe = make_pipe(spv_join(ex_spv, "sel_resolve_s7.spv"), 6, 4);
    {
        Buf *b[6] = { &g_idxB, &g_selkeys, &g_arena, &g_surv, &g_state, &g_tileoff };
        g_resolve_set = make_set(&g_resolve_pipe, b, 6);
    }
    // S19: hash-table dedupe phases (same binding positions as
    // resolve, binding 5 = htable).
    g_htins_pipe = make_pipe(spv_join(ex_spv, "sel_htins19f.spv"), 6, 4);
    {
        Buf *b[6] = { &g_idxB, &g_selkeys, &g_arena, &g_surv, &g_state, &g_htable };
        g_htins_set = make_set(&g_htins_pipe, b, 6);
    }
    g_htlook_pipe = make_pipe(prof_spv(ex_spv, "sel_htlook19f.spv", "sel_htlook19f_gl.spv"), 6, 4);
    {
        Buf *b[6] = { &g_idxB, &g_selkeys, &g_arena, &g_surv, &g_state, &g_htable };
        g_htlook_set = make_set(&g_htlook_pipe, b, 6);
    }
    g_htclr_pipe = make_pipe(spv_join(ex_spv, "sel_htclr19.spv"), 6, 4);
    {
        Buf *b[6] = { &g_idxB, &g_selkeys, &g_arena, &g_surv, &g_state, &g_htable };
        g_htclr_set = make_set(&g_htclr_pipe, b, 6);
    }
    g_snap_pipe = make_pipe(spv_join(ex_spv, "sel_snap_s5.spv"), 5, 4);
    {
        Buf *b[5] = { &g_selkeys, &g_surv, &g_arena, &g_state, &g_snap };
        g_snap_set = make_set(&g_snap_pipe, b, 5);
    }
    {
        Buf *b[4] = { &g_selkeys, &g_idxD, &g_tilehist, &g_state };
        g_hist_set_pd = make_set(&g_hist_pipe, b, 4);
        Buf *bs1[5] = { &g_selkeys, &g_idxA, &g_idxD, &g_tileoff, &g_state };
        g_scatter_set_pd = make_set(&g_scatter_pipe, bs1, 5);
        Buf *bs2[5] = { &g_selkeys, &g_idxD, &g_idxE, &g_tileoff, &g_state };
        g_scatter_set_pe = make_set(&g_scatter_pipe, bs2, 5);
    }
    g_fscat_pipe = make_pipe(spv_join(ex_spv, "sort_scatter_fused_s12.spv"), 5, 12);
    {
        Buf *bf1[5] = { &g_selkeys, &g_idxA, &g_idxD, &g_tilehist, &g_state };
        g_fscat_set_pd = make_set(&g_fscat_pipe, bf1, 5);
        Buf *bf2[5] = { &g_selkeys, &g_idxD, &g_idxE, &g_tilehist, &g_state };
        g_fscat_set_pe = make_set(&g_fscat_pipe, bf2, 5);
        Buf *bf1b[5] = { &g_selkeys, &g_idxA, &g_idxD, &g_tilehist2, &g_state };
        g_fscat_set_pd2 = make_set(&g_fscat_pipe, bf1b, 5);
    }
    g_fscatK_pipe = make_pipe(spv_join(ex_spv, "sort_scatter_fused_s14.spv"), 5, 12);
    {
        Buf *bk0[5] = { &g_selkeys, &g_idxA, &g_idxB, &g_tilehist, &g_state };
        g_fscatK_set[0] = make_set(&g_fscatK_pipe, bk0, 5);
        Buf *bk1[5] = { &g_selkeys, &g_idxB, &g_idxA, &g_tilehist, &g_state };
        g_fscatK_set[1] = make_set(&g_fscatK_pipe, bk1, 5);
    }
    g_binhist_pipe = make_pipe(spv_join(ex_spv, "sel_binhist16_s5.spv"), 6, 4);
    {
        Buf *b[6] = { &g_selkeys, &g_surv, &g_arena, &g_state, &g_binall, &g_blk };
        g_binhist_set = make_set(&g_binhist_pipe, b, 6);
    }
    g_clear_pipe = make_pipe(spv_join(ex_spv, "sel_clear_s5.spv"), 1, 0);
    {
        Buf *b[1] = { &g_binall };
        g_clear_set = make_set(&g_clear_pipe, b, 1);
    }
    g_thresh_pipe = make_pipe(spv_join(ex_spv, "sel_thresh16_s5.spv"), 7, 4);
    {
        Buf *b[7] = { &g_binall, &g_state, &g_args, &g_selctl, &g_bitargs, &g_blk, &g_scanargs };
        g_thresh_set = make_set(&g_thresh_pipe, b, 7);
    }
    g_bitonic_pipe = make_pipe(spv_join(ex_spv, "sel_bitonic_s5.spv"), 5, 4);
    {
        Buf *b[5] = { &g_idxE, &g_selkeys, &g_idxC, &g_state, &g_selctl };
        g_bitonic_set = make_set(&g_bitonic_pipe, b, 5);
    }
    g_compact5_pipe = make_pipe(spv_join(ex_spv, "sel_compact_s5.spv"), 6, 4);
    {
        Buf *b[6] = { &g_idxC, &g_surv, &g_arena, &g_beam_idx, &g_state, &g_selctl };
        g_compact5_set = make_set(&g_compact5_pipe, b, 6);
    }

    g_compact_pipe = make_pipe(spv_join(ex_spv, "sel_compact_s2.spv"), 5, 4);
    {
        Buf *b[5] = { &g_idxC, &g_surv, &g_arena, &g_beam_idx, &g_state };
        g_compact_set = make_set(&g_compact_pipe, b, 5);
    }
    g_idxcopy_pipe = make_pipe(spv_join(ex_spv, "idx_copy.spv"), 3, 4);
    {
        Buf *b[3] = { &g_idxA, &g_idxC, &g_state };
        g_idxcopy_set = make_set(&g_idxcopy_pipe, b, 3);
    }
    g_mega_pipe = make_pipe(spv_join(ex_spv, "sort_mega21.spv"), 4, 4);
    g_passA_pipe = make_pipe(spv_join(ex_spv, "sel_passA22.spv"), 5, 4);
    g_h6x_pipe = make_pipe(spv_join(ex_spv, "sort_hist_s22_h6x.spv"), 5, 12);
    {
        Buf *b[5] = { &g_selkeys, &g_idxA, &g_tilehist2, &g_tilehist, &g_state };
        g_h6x_set = make_set(&g_h6x_pipe, b, 5);
    }
    g_phx_pipe = make_pipe(spv_join(ex_spv, "sort_hist_s26_phx.spv"), 7, 12);
    {
        Buf *b[7] = { &g_selkeys, &g_idxA, &g_tilehist2, &g_tilehist, &g_state, &g_keys_arena, &g_arena };
        g_phx_set = make_set(&g_phx_pipe, b, 7);
    }
    g_h7f_pipe = make_pipe(spv_join(ex_spv, "sort_scatter_fused_s22h.spv"), 6, 12);
    {
        Buf *b[6] = { &g_selkeys, &g_idxA, &g_idxD, &g_tilehist2, &g_state, &g_tilehist };
        g_h7f_set_pd2 = make_set(&g_h7f_pipe, b, 6);
    }
    {
        Buf *b[5] = { &g_selkeys, &g_idxA, &g_idxD, &g_idxE, &g_state };
        g_passA_set = make_set(&g_passA_pipe, b, 5);
    }
    {
        Buf *b[4] = { &g_selkeys, &g_idxA, &g_idxB, &g_state };
        g_mega_set = make_set(&g_mega_pipe, b, 4);
    }
    g_leafprep_pipe = make_pipe(spv_join(ex_spv, "leaf_prep.spv"), 9, 4);
    {
        Buf *b[9] = { &g_state, &g_arena, &g_beam_idx, &g_self_leaf, &g_node_arrays, &g_child_inst, &g_inst_meta, &g_leaf_flag, &g_leaf_src };
        g_leafprep_set = make_set(&g_leafprep_pipe, b, 9);
    }
    g_leafsum_pipe = make_pipe(spv_join(ex_spv, "leaf_tilesum.spv"), 3, 4);
    {
        Buf *b[3] = { &g_leaf_flag, &g_leaf_tsum, &g_state };
        g_leafsum_set = make_set(&g_leafsum_pipe, b, 3);
    }
    g_leafscan_pipe = make_pipe(spv_join(ex_spv, "leaf_scan.spv"), 3, 4);
    {
        Buf *b[3] = { &g_leaf_tsum, &g_leaf_toff, &g_state };
        g_leafscan_set = make_set(&g_leafscan_pipe, b, 3);
    }
    g_leafscatter_pipe = make_pipe(spv_join(ex_spv, "leaf_scatter.spv"), 5, 4);
    {
        Buf *b[5] = { &g_leaf_flag, &g_leaf_src, &g_leaf_toff, &g_leaf_idx, &g_state };
        g_leafscatter_set = make_set(&g_leafscatter_pipe, b, 5);
    }
    g_leafprep26_pipe = make_pipe(prof_spv(ex_spv, "leaf_prep26.spv", "leaf_prep26_gl.spv"), 10, 4);
    {
        Buf *b[10] = { &g_state, &g_arena, &g_beam_idx, &g_self_leaf, &g_node_arrays, &g_child_inst, &g_inst_meta, &g_leaf_flag, &g_leaf_src, &g_leaf_tsum };
        g_leafprep26_set = make_set(&g_leafprep26_pipe, b, 10);
    }
    g_leafscatter26_pipe = make_pipe(spv_join(ex_spv, "leaf_scatter26.spv"), 5, 4);
    {
        Buf *b[5] = { &g_leaf_flag, &g_leaf_src, &g_leaf_tsum, &g_leaf_idx, &g_state };
        g_leafscatter26_set = make_set(&g_leafscatter26_pipe, b, 5);
    }
    // zero the movegen scratch once (stamps start clean)
    VkCommandBuffer cmd = begin_cmd();
    vkCmdFillBuffer(cmd, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
    vkCmdFillBuffer(cmd, g_binall.buf, 0, VK_WHOLE_SIZE, 0);
    vkCmdFillBuffer(cmd, g_blk.buf, 0, VK_WHOLE_SIZE, 0);
    submit_wait(cmd);
    g_serial_base = 1;
}


// ---- prof mode (step 4): per-stage timestamp decomposition ----
static VkQueryPool ptpool = VK_NULL_HANDLE;
#define PROF_MAXQ 2048
// STEP9: stamp density for the movegen harness-artifact experiments.
// 2 = full (step<=8 behaviour), 1 = movegen brackets + top/tail only,
// 0 = top/tail only. g_stop_ply >= 0 stops recording right after that
// ply's mg_build (mgreplay setup: leaves the ply's movegen inputs and
// indirect args live on the device).
static int g_stamp_mode = 2;
static int g_stop_ply = -1;
static int g_q = 0;
static int g_seq[PROF_MAXQ];
// per-ply stage ids
#define PST_MGB 0
#define PST_MG 1
#define PST_EXS 2
#define PST_EXB 3
#define PST_EXP 4
#define PST_PREP 5
#define PST_HISTK 6
#define PST_SCANK 7
#define PST_SCATK 8
#define PST_COPY 9
#define PST_HISTH 10
#define PST_SCANH 11
#define PST_SCATH 12
#define PST_SEG 13
#define PST_REP 14
#define PST_FLG 15
#define PST_CMP 16
#define PST_LPRE 17
#define PST_LSUM 18
#define PST_LSCN 19
#define PST_LSCT 20
#define PST_DHIST 21
#define PST_DSCAN 22
#define PST_DSCAT 23
#define PST_RESOLV 24
#define PST_NSTAGE 25
#define PST_INIT (PST_NSTAGE * 15)
#define PST_TAIL (PST_NSTAGE * 15 + 1)
#define PST_SLOTS (PST_NSTAGE * 15 + 2)
static void stamp2(VkCommandBuffer cmd, int slot) {
    if (g_stamp_mode == 0 && slot != PST_TAIL) return;
    if (g_stamp_mode == 1 && slot != PST_TAIL && slot >= 30) return;
    g_seq[g_q] = slot;
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, ptpool, (uint32_t)g_q);
    g_q++;
}

// S23: expand-input layout mode. 0 = AoS (step-22 config),
// 1 = ex_build writes SoA directly, 2 = AoS + transpose dispatch.
static int s23_soa(void) { const char *e = getenv("S23_SOA"); return e ? atoi(e) : 0; }

// ---- expandcheck (chunked; the s2 expand reads n/base from state) ----
static int cmd_expandcheck(const char *spv, const char *tables_path, const char *cases_path) {
    size_t len; uint8_t *raw = slurp(cases_path, &len);
    const uint8_t *p = raw;
    if (rd32(&p) != EX_MAGIC) { fprintf(stderr, "bad cases magic\n"); exit(1); }
    (void)rd32(&p);
    uint32_t n = rd32(&p);
    size_t rec_bytes = (size_t)(EX_IN_STRIDE + EX_OUT_STRIDE) * 4;
    if (len != 12 + (size_t)n * rec_bytes) { fprintf(stderr, "cases size mismatch: %zu vs %zu\n", len, 12 + (size_t)n * rec_bytes); exit(1); }
    printf("expandcheck: %u cases\n", n);
    pipeline_init(NULL, spv, tables_path, 0);
    const uint32_t *src = (const uint32_t *)p;

    uint64_t bad_board = 0, bad_flags = 0, bad_scalars = 0, bad_reward = 0, bad_value = 0, bad_step = 0, bad_any = 0, flag_range = 0;
    uint64_t bad_keys = 0;
    double gpu_total_ms = 0.0;
    for (uint32_t base = 0; base < n; base += MAX_CHILD) {
        uint32_t cn = n - base < MAX_CHILD ? n - base : MAX_CHILD;
        // stage inputs + state
        uint32_t *ip = g_stage_in.ptr;
        for (uint32_t i = 0; i < cn; i++)
            memcpy(ip + (size_t)i * EX_IN_STRIDE, src + (size_t)(base + i) * (EX_IN_STRIDE + EX_OUT_STRIDE), EX_IN_STRIDE * 4);
        uint32_t *stp = g_state_stage.ptr;
        memset(stp, 0, ST_WORDS * 4);
        stp[ST_N_CHILD] = cn;
        stp[ST_ARENA_BASE] = 0;
        VkCommandBuffer cmd = begin_cmd();
        VkBufferCopy c1 = { 0, 0, (VkDeviceSize)cn * EX_IN_STRIDE * 4 };
        vkCmdCopyBuffer(cmd, g_stage_in.buf, g_ex_in_d.buf, 1, &c1);
        VkBufferCopy c2 = { 0, 0, (VkDeviceSize)ST_WORDS * 4 };
        vkCmdCopyBuffer(cmd, g_state_stage.buf, g_state.buf, 1, &c2);
        barrier_transfer_to_compute(cmd);
        uint32_t push = 0;
        if (s23_soa()) {  // S23: transpose the staged AoS cases into the SoA buffer
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_ext_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_ext_pipe.layout, 0, 1, &g_ext_set, 0, NULL);
            vkCmdPushConstants(cmd, g_ext_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
            vkCmdDispatch(cmd, (cn + 255) / 256, 1, 1);
            barrier_rw(cmd);
        }
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.layout, 0, 1, s23_soa() ? &g_ex_set_soa : &g_ex_set, 0, NULL);
        vkCmdPushConstants(cmd, g_ex_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
        vkCmdDispatch(cmd, (cn + 63) / 64, 1, 1);
        submit_wait(cmd);

        VkCommandBuffer cmd2 = begin_cmd();
        barrier_compute_to_transfer(cmd2);
        VkBufferCopy c3 = { 0, 0, (VkDeviceSize)cn * EX_OUT_STRIDE * 4 };
        vkCmdCopyBuffer(cmd2, g_arena.buf, g_stage_out.buf, 1, &c3);
        VkBufferCopy c4 = { 0, 0, (VkDeviceSize)cn * 4 * 4 };
        vkCmdCopyBuffer(cmd2, g_keys_arena.buf, g_stage_keys.buf, 1, &c4);
        double t0 = now_ms();
        submit_wait(cmd2);
        gpu_total_ms += now_ms() - t0; // (copy time; dispatch time is inside the first submit)

        uint32_t *op = g_stage_out.ptr, *kp = g_stage_keys.ptr;
        for (uint32_t i = 0; i < cn; i++) {
            const uint32_t *exp = src + (size_t)(base + i) * (EX_IN_STRIDE + EX_OUT_STRIDE) + EX_IN_STRIDE;
            const uint32_t *got = op + (size_t)i * EX_OUT_STRIDE;
            int any = 0;
            for (int k = 0; k < 40; k++) if (got[k] != exp[k]) { bad_board++; any = 1; break; }
            for (int k = 40; k < 80; k++) if (got[k] != exp[k]) { bad_flags++; any = 1; break; }
            for (int k = 80; k < 88; k++) if (got[k] != exp[k]) { bad_scalars++; any = 1; break; }
            if (got[88] != exp[88] || got[89] != exp[89]) { bad_reward++; any = 1; }
            if (got[90] != exp[90] || got[91] != exp[91]) { bad_value++; any = 1; }
            for (int k = 92; k < 106; k++) if (got[k] != exp[k]) { bad_step++; any = 1; break; }
            if (got[106] != 0) flag_range++;
            if (any) {
                bad_any++;
                if (bad_any <= 5) {
                    fprintf(stderr, "case %u: first differing words:", base + i);
                    for (int k = 0; k < 108; k++) if (got[k] != exp[k]) fprintf(stderr, " [%d] got %u exp %u", k, got[k], exp[k]);
                    fprintf(stderr, "\n");
                }
            }
            uint64_t vb = (uint64_t)exp[90] | ((uint64_t)exp[91] << 32);
            uint64_t k_exp = UINT64_MAX - ord_key(bits_f64(vb));
            uint64_t h = 1469598103934665603ULL;
            #define MIXW(x) do { h ^= (uint64_t)(uint32_t)(x); h *= 1099511628211ULL; } while (0)
            MIXW(exp[82]); MIXW(exp[81]); MIXW(exp[83]); MIXW(exp[84]); MIXW(exp[86]); MIXW(exp[85]);
            for (int k = 40; k < 80; k++) MIXW(exp[k]);
            for (int k = 0; k < 40; k++) MIXW(exp[k]);
            #undef MIXW
            uint64_t k_got = (uint64_t)kp[(size_t)i * 4 + 0] | ((uint64_t)kp[(size_t)i * 4 + 1] << 32);
            uint64_t h_got = (uint64_t)kp[(size_t)i * 4 + 2] | ((uint64_t)kp[(size_t)i * 4 + 3] << 32);
            if (k_got != k_exp || h_got != h) {
                bad_keys++;
                if (bad_keys <= 5)
                    fprintf(stderr, "case %u: keys got K %016llx H %016llx, expected K %016llx H %016llx\n", base + i,
                            (unsigned long long)k_got, (unsigned long long)h_got,
                            (unsigned long long)k_exp, (unsigned long long)h);
            }
        }
        printf("expandcheck chunk @%u (%u cases) done; bad so far %llu\n", base, cn, (unsigned long long)bad_any);
        fflush(stdout);
    }
    printf("expandcheck: %u cases; mismatches: any %llu, board %llu, garbage-flags %llu, scalars %llu, reward-bits %llu, value-bits %llu, step/rest %llu; ln1p-range flags %llu\n",
           n, (unsigned long long)bad_any, (unsigned long long)bad_board, (unsigned long long)bad_flags,
           (unsigned long long)bad_scalars, (unsigned long long)bad_reward, (unsigned long long)bad_value,
           (unsigned long long)bad_step, (unsigned long long)flag_range);
    printf("expandcheck keys: %u cases; K/hash mismatches %llu\n", n, (unsigned long long)bad_keys);
    (void)gpu_total_ms;
    return (bad_any || bad_keys) ? 1 : 0;
}

// ---- resident decision ----
static uint64_t g_ln1p_total = 0;

static void rec1(VkCommandBuffer cmd, Pipe *p, VkDescriptorSet set, const void *push, uint32_t psz) {
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->pipe);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->layout, 0, 1, &set, 0, NULL);
    if (psz) vkCmdPushConstants(cmd, p->layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, psz, push);
    vkCmdDispatch(cmd, 1, 1, 1);
}
static void reci(VkCommandBuffer cmd, Pipe *p, VkDescriptorSet set, const void *push, uint32_t psz, uint32_t ply, uint32_t kind) {
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->pipe);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p->layout, 0, 1, &set, 0, NULL);
    if (psz) vkCmdPushConstants(cmd, p->layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, psz, push);
    vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + kind) * 12);
}
// OPT-STEP14: selection-sort train selection + separation probes.
// S14_TRAIN=old keeps the step-13 train (hist/scan/scatter per
// pass); anything else uses the fused train (the scan dispatch is
// folded into the scatter, which recomputes its tile offsets from
// tilehist). S14_SEP=nobar|nodisp|none strips barriers /
// dispatches / both inside the selection train for TIMING-ONLY
// separation runs (results invalid; never gate with it set).
static int s14_fused(void) { const char *e = getenv("S14_TRAIN"); return !(e && !strcmp(e, "old")); }
static int s14_sep(void) { const char *e = getenv("S14_SEP"); if (!e) return 0; if (!strcmp(e, "nobar")) return 1; if (!strcmp(e, "nodisp")) return 2; if (!strcmp(e, "none")) return 3; return 0; }

// OPT-STEP21: predicate the selection sort train + idxcopy on the
// finisher-arm bit sel_thresh16 publishes in bitargs[ply].x (1 =
// finisher armed, 0 = fallback sort needed). With INVERTED, the
// region's dispatch commands are discarded by the device exactly
// when thresh zeroed this ply's ARG_TILE args -- i.e. exactly when
// every dispatch in the region would have launched zero workgroups
// and performed no memory accesses. Pipeline barriers inside the
// region are not affected by conditional rendering and still
// execute, so memory ordering is unchanged in both modes.
// S21_PRED=off (or a missing extension) records the stream exactly
// as before.
static int s21_pred(void) { const char *e = getenv("S21_PRED"); return !(e && !strcmp(e, "off")); }
// OPT-STEP21: S21_MEGA=off keeps the 8-pass train in the run path;
// otherwise the train is replaced by the single-workgroup sort
// (sort_mega21), dispatched indirectly from the scanargs slot that
// sel_thresh16 sets to (1,1,1) on the fallback path and (0,1,1)
// when the finisher is armed.
static int s21_mega(void) { const char *e = getenv("S21_MEGA"); return !(e && !strcmp(e, "off")); }
// OPT-STEP22: S22_PASSA=off keeps the step-21 pass-A stream
// (hist6 / fused scatter / hist7 / fused scatter); otherwise one
// single-workgroup kernel (sel_passA22) produces idxE from idxA.
// Its inputs (selkeys, idxA) are written by prep and read by
// nothing in between (htins/htlook touch idxB/surv/htable only),
// and its outputs (idxD, idxE) have no reader before the bitonic
// finisher, so the relocation is unobservable.
static int s22_passA(void) { const char *e = getenv("S22_PASSA"); return !(e && !strcmp(e, "off")); }
// OPT-STEP22: S22_H7FUSE=off keeps the separate byte-7 histogram
// dispatch (hist_pd); otherwise the byte-6 histogram kernel also
// zeroes tilehist and the byte-6 fused scatter emits the byte-7
// tile histogram as a byproduct (see the two shaders' headers).
static int s22_h7fuse(void) { const char *e = getenv("S22_H7FUSE"); return !(e && !strcmp(e, "off")); }
// OPT-STEP26 toggles (default on; =off restores the step-23 stream).
static int s26_pfuse(void) { const char *e = getenv("S26_PFUSE"); return !(e && !strcmp(e, "off")); }
static int s26_lfuse(void) { const char *e = getenv("S26_LFUSE"); return !(e && !strcmp(e, "off")); }
static int s26_fill(void) { const char *e = getenv("S26_FILL"); return !(e && !strcmp(e, "off")); }
static void s21_pred_begin(VkCommandBuffer cmd, uint32_t ply) {
    if (!g_have_condrend || !s21_pred()) return;
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, NULL,
                           VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_CONDITIONAL_RENDERING_READ_BIT_EXT };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         VK_PIPELINE_STAGE_CONDITIONAL_RENDERING_BIT_EXT, 0, 1, &mb, 0, NULL, 0, NULL);
    VkConditionalRenderingBeginInfoEXT crb = { VK_STRUCTURE_TYPE_CONDITIONAL_RENDERING_BEGIN_INFO_EXT, NULL,
                                               g_bitargs.buf, (VkDeviceSize)ply * 12,
                                               VK_CONDITIONAL_RENDERING_INVERTED_BIT_EXT };
    pfnBeginCR(cmd, &crb);
}
static void s21_pred_end(VkCommandBuffer cmd) {
    if (!g_have_condrend || !s21_pred()) return;
    pfnEndCR(cmd);
}

static void rec_sort(VkCommandBuffer cmd, uint32_t ply, uint32_t keyOff) {
    int sep = s14_sep();
    for (int pass = 0; pass < 8; pass++) {
        int s = pass & 1;
        uint32_t push[3] = { ply, (uint32_t)pass * 8, keyOff };
        if (sep != 2 && sep != 3) reci(cmd, &g_hist_pipe, g_hist_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        if (sep != 2 && sep != 3) {
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_scan_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_scan_pipe.layout, 0, 1, &g_scan_set, 0, NULL);
            vkCmdPushConstants(cmd, g_scan_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
            vkCmdDispatchIndirect(cmd, g_scanargs.buf, (VkDeviceSize)ply * 12);
        }
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        if (sep != 2 && sep != 3) reci(cmd, &g_scatter_pipe, g_scatter_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
    }
}

static void rec_sort_fused(VkCommandBuffer cmd, uint32_t ply, uint32_t keyOff) {
    int sep = s14_sep();
    for (int pass = 0; pass < 8; pass++) {
        int s = pass & 1;
        uint32_t push[3] = { ply, (uint32_t)pass * 8, keyOff };
        if (sep != 2 && sep != 3) reci(cmd, &g_hist_pipe, g_hist_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        if (sep != 2 && sep != 3) reci(cmd, &g_fscatK_pipe, g_fscatK_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
    }
}

static void readback(Buf *dev_buf, void *dst, size_t bytes, Buf *stage, size_t stage_bytes) {
    size_t off = 0;
    while (off < bytes) {
        size_t chunk = bytes - off < stage_bytes ? bytes - off : stage_bytes;
        VkCommandBuffer cmd = begin_cmd();
        barrier_compute_to_transfer(cmd);
        VkBufferCopy c = { (VkDeviceSize)off, 0, (VkDeviceSize)chunk };
        vkCmdCopyBuffer(cmd, dev_buf->buf, stage->buf, 1, &c);
        submit_wait(cmd);
        memcpy((uint8_t *)dst + off, stage->ptr, chunk);
        off += chunk;
    }
}

typedef struct {
    int32_t s_kind, s_rot, s_x, s_y, s_srs, s_tspin, s_used_hold, s_lines, s_attack;
    uint64_t s_reward_bits;
    uint32_t board[40];
    int32_t lift, pending;
} FirstMove;

static void write_wire_record(Out *o, const uint32_t *r, int32_t root_due) {
    for (int i = 0; i < 40; i++) ow32(o, r[i] & 0xFFFFu);
    for (int i = 0; i < 40; i++) ow32(o, r[40 + i] & 0xFFu);
    ow32(o, r[81]); ow32(o, r[82]); ow32(o, r[83]); ow32(o, r[84]); ow32(o, r[85]);
    ow32(o, r[86]); ow32(o, r[87]);
    ow64(o, (uint64_t)r[88] | ((uint64_t)r[89] << 32));
    ow64(o, (uint64_t)r[90] | ((uint64_t)r[91] << 32));
    ow32(o, r[92]); ow32(o, r[93]); ow32(o, r[94]);
    ow32(o, r[94] == 0 ? 0u : 1u); // step_present: root 0, children 1
    ow32(o, r[95]); ow32(o, r[96]); ow32(o, r[97]); ow32(o, r[98]); ow32(o, r[99]);
    ow32(o, r[100]); ow32(o, r[101]); ow32(o, r[102]); ow32(o, r[103]);
    ow64(o, (uint64_t)r[104] | ((uint64_t)r[105] << 32));
    ow32(o, r[80]);
    ow32(o, r[94] == 0 ? (uint32_t)root_due : 0u);
}

// Run one decision in a single submit. Writes the wire result record
// to `out` unless out==NULL (bench mode: status mirror only).
// Returns status (0 ok, 1 no result, 2 kernel error).
static int run_decision_s2(const uint32_t *dec, Out *out, double *wall_ms, double *gpu_ms) {
    double t_start = now_s();
    int32_t root_due = (int32_t)dec[104];

    uint32_t *pm = g_params.ptr;
    pm[PM_SEQ_LEN] = dec[81];
    pm[PM_BOARD_LEN] = dec[80];
    pm[PM_ACTIVE_ROT] = dec[96];
    pm[PM_ACTIVE_X] = dec[97];
    pm[PM_ACTIVE_Y] = dec[98];
    pm[PM_ROOT_HOLD] = dec[99];
    pm[PM_ROOT_CAN_HOLD] = dec[100];
    pm[PM_ROOT_DUE] = dec[104];
    for (int i = 0; i < 14; i++) pm[PM_SEQ + i] = dec[82 + i];
    pm[PM_OPTS] = g_profile_opts;

    uint32_t *rs = g_root_stage.ptr;
    memset(rs, 0, EX_OUT_STRIDE * 4);
    for (int i = 0; i < 40; i++) { rs[i] = dec[i] & 0xFFFFu; rs[40 + i] = dec[40 + i] & 0xFFu; }
    rs[80] = dec[80]; rs[81] = dec[99]; rs[82] = 0; rs[83] = dec[103]; rs[84] = dec[101];
    rs[85] = dec[102]; rs[86] = 0; rs[87] = dec[105]; rs[93] = 0xFFFFFFFFu;

    VkCommandBuffer cmd = begin_cmd();
    vkCmdResetQueryPool(cmd, tpool, 0, 2);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, tpool, 0);
    if (g_serial_base + MAXPLY - 1 > 240) {
        vkCmdFillBuffer(cmd, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
        g_serial_base = 1;
    }
    {
        VkBufferCopy rc = { 0, 0, (VkDeviceSize)EX_OUT_STRIDE * 4 };
        vkCmdCopyBuffer(cmd, g_root_stage.buf, g_arena.buf, 1, &rc);
    }
    barrier_transfer_to_compute(cmd);
    rec1(cmd, &g_init_pipe, g_init_set, NULL, 0);
    barrier_rw(cmd);
    vkCmdFillBuffer(cmd, g_htable.buf, 0, VK_WHOLE_SIZE, 0);  // S19
    barrier_transfer_to_compute(cmd);
    for (uint32_t ply = 0; ply < MAXPLY; ply++) {
        rec1(cmd, &g_mgb_pipe, g_mgb_set, &ply, 4);
        barrier_rw(cmd);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.layout, 0, 1, &g_mg_set, 0, NULL);
        uint32_t mgpc[2] = { 1, g_serial_base + ply };
        vkCmdPushConstants(cmd, g_mg_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, mgpc);
        vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + ARG_MG) * 12);
        barrier_rw(cmd);
        if (s26_lfuse()) rec1(cmd, &g_exs26_pipe, g_exs26_set, &ply, 4);
        else rec1(cmd, &g_exs_pipe, g_exs_set, &ply, 4);
        barrier_rw(cmd);
        reci(cmd, &g_exb_pipe, s23_soa() == 1 ? g_exb_set_soa : g_exb_set, &ply, 4, ply, ARG_EXB);
        barrier_rw(cmd);
        if (s23_soa() == 2) { reci(cmd, &g_ext_pipe, g_ext_set, &ply, 4, ply, ARG_EXB); barrier_rw(cmd); }  // S23 transpose
        reci(cmd, &g_ex_pipe, s23_soa() ? g_ex_set_soa : g_ex_set, &ply, 4, ply, ARG_EXP);
        barrier_rw(cmd);
        if (!s26_pfuse() || s22_passA()) { reci(cmd, &g_prep_pipe, g_prep_set, &ply, 4, ply, ARG_TILE); barrier_rw(cmd); }
        {   // OPT-STEP4 sortless dedupe: one stable radix pass on hash
            // bits 48..55 groups equal-hash children in index order;
            // sel_resolve keeps the first child of each full key.
            uint32_t dpush[3] = { ply, 48u, 2u };
            uint32_t apushA19[3] = { ply, 48u, 0u };  // S19g
            if (!s22_passA()) { if (s26_pfuse()) reci(cmd, &g_phx_pipe, g_phx_set, apushA19, 12, ply, ARG_TILE); else if (s22_h7fuse()) reci(cmd, &g_h6x_pipe, g_h6x_set, apushA19, 12, ply, ARG_TILE); else reci(cmd, &g_hist_pipe, g_hist_set_a19, apushA19, 12, ply, ARG_TILE); }  // S19g hist1; S22: h6x also zeroes tilehist; S26: phx also runs prep
            barrier_rw(cmd);
        }
        // S19: hash-table dedupe (insert -> lookup -> cleanup)
        reci(cmd, &g_htins_pipe, g_htins_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        reci(cmd, &g_htlook_pipe, g_htlook_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        {   // OPT-STEP5 partial selection: two stable radix passes
            // (K byte 6, then byte 7) group children by the top 16
            // bits of K into scratch buffer idxE, leaving idxA's
            // identity array and idxB's dedupe order untouched so the
            // fallback below stays exact. binhist16 builds the joint
            // (total, selected) histogram over the 65536 top-16 bins;
            // thresh16 finds the threshold bin and the region end,
            // writes surv_total, and either arms the bitonic finisher
            // (zeroing this ply's ARG_TILE args so the full sort and
            // idxcopy become no-ops) or leaves the full sort as the
            // fallback path.
            uint32_t apush1[3] = { ply, 48u, 0u };
            uint32_t apush2[3] = { ply, 56u, 0u };
            // S18: pass-A first histogram is computed by the fused
            // hist dispatch at the dedupe position (into tilehist2).
            barrier_rw(cmd);
            if (s22_passA()) {
                rec1(cmd, &g_passA_pipe, g_passA_set, &ply, 4);  // S22: fused pass A
                barrier_rw(cmd);
            } else {
                if (s22_h7fuse()) reci(cmd, &g_h7f_pipe, g_h7f_set_pd2, apush1, 12, ply, ARG_TILE); else reci(cmd, &g_fscat_pipe, g_fscat_set_pd2, apush1, 12, ply, ARG_TILE);  // S22: h7f emits the byte-7 tile histogram
                barrier_rw(cmd);
                if (!s22_h7fuse()) reci(cmd, &g_hist_pipe, g_hist_set_pd, apush2, 12, ply, ARG_TILE);  // S22: byte-7 hist is the h7f byproduct when fused
                barrier_rw(cmd);
                reci(cmd, &g_fscat_pipe, g_fscat_set_pe, apush2, 12, ply, ARG_TILE);
                barrier_rw(cmd);
            }
            reci(cmd, &g_binhist_pipe, g_binhist_set, &ply, 4, ply, ARG_TILE);
            barrier_rw(cmd);
            rec1(cmd, &g_thresh_pipe, g_thresh_set, &ply, 4);
            barrier_rw(cmd);
            if (s26_fill()) { vkCmdFillBuffer(cmd, g_binall.buf, 0, VK_WHOLE_SIZE, 0); barrier_transfer_to_compute(cmd); }
            else {
                vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.pipe);
                vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.layout, 0, 1, &g_clear_set, 0, NULL);
                vkCmdDispatch(cmd, 512, 1, 1);
                barrier_rw(cmd);
            }
        }
        s21_pred_begin(cmd, ply);
        if (s21_mega()) {
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mega_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mega_pipe.layout, 0, 1, &g_mega_set, 0, NULL);
            vkCmdPushConstants(cmd, g_mega_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
            vkCmdDispatchIndirect(cmd, g_scanargs.buf, (VkDeviceSize)ply * 12);
            barrier_rw(cmd);
        } else if (s14_fused()) rec_sort_fused(cmd, ply, 0); else rec_sort(cmd, ply, 0); // by composite key K (fallback; no-op when finisher armed)
        reci(cmd, &g_idxcopy_pipe, g_idxcopy_set, &ply, 4, ply, ARG_TILE);
        s21_pred_end(cmd);
        barrier_rw(cmd);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.layout, 0, 1, &g_bitonic_set, 0, NULL);
        vkCmdPushConstants(cmd, g_bitonic_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
        vkCmdDispatchIndirect(cmd, g_bitargs.buf, (VkDeviceSize)ply * 12);
        barrier_rw(cmd);
        rec1(cmd, &g_compact5_pipe, g_compact5_set, &ply, 4);
        barrier_rw(cmd);
        if (s26_lfuse()) {
            reci(cmd, &g_leafprep26_pipe, g_leafprep26_set, &ply, 4, ply, ARG_LEAFP);
            barrier_rw(cmd);
            reci(cmd, &g_leafscatter26_pipe, g_leafscatter26_set, &ply, 4, ply, ARG_LEAFS);
            barrier_rw(cmd);
        } else {
            reci(cmd, &g_leafprep_pipe, g_leafprep_set, &ply, 4, ply, ARG_LEAFP);
            barrier_rw(cmd);
            reci(cmd, &g_leafsum_pipe, g_leafsum_set, &ply, 4, ply, ARG_LEAFS);
            barrier_rw(cmd);
            rec1(cmd, &g_leafscan_pipe, g_leafscan_set, &ply, 4);
            barrier_rw(cmd);
            reci(cmd, &g_leafscatter_pipe, g_leafscatter_set, &ply, 4, ply, ARG_LEAFS);
            barrier_rw(cmd);
        }
    }
    barrier_compute_to_transfer(cmd);
    {
        VkBufferCopy sc = { 0, 0, (VkDeviceSize)ST_WORDS * 4 };
        vkCmdCopyBuffer(cmd, g_state.buf, g_state_mirror.buf, 1, &sc);
    }
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, tpool, 1);

    double t0 = now_ms();
    CK(vkEndCommandBuffer(cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cmd, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    CK(vkQueueWaitIdle(queue));
    vkFreeCommandBuffers(dev, pool, 1, &cmd);
    g_submit_ms += now_ms() - t0;
    uint64_t ts[2] = {0, 0};
    CK(vkGetQueryPoolResults(dev, tpool, 0, 2, sizeof ts, ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double gpu_span = (double)(ts[1] - ts[0]) * ts_period_ns * 1e-6;
    g_serial_base += MAXPLY;

    uint32_t *st = g_state_mirror.ptr;
    int status = 0;
    if (st[ST_ERROR]) status = 2;
    for (int p = 0; p < MAXPLY; p++) if (st[ST_REPAIR_ERR + p]) status = 2;
    g_ln1p_total += st[ST_LN1P];
    uint64_t nodes = 0;
    for (int p = 0; p < MAXPLY; p++) nodes += st[ST_N_CHILD + p];
    double wall = (now_s() - t_start) * 1e3;
    if (wall_ms) *wall_ms = wall;
    if (gpu_ms) *gpu_ms = gpu_span;

    if (out) {
        uint32_t arena_next = st[ST_ARENA_NEXT];
        uint32_t leaves_next = st[ST_LEAVES_NEXT];
        uint32_t *recs = malloc((size_t)(arena_next ? arena_next : 1) * EX_OUT_STRIDE * 4);
        readback(&g_arena, recs, (size_t)arena_next * EX_OUT_STRIDE * 4, &g_stage_out, MAX_CHILD * EX_OUT_STRIDE * 4);
        uint32_t *leaf_idx = malloc((size_t)(leaves_next ? leaves_next : 1) * 4);
        readback(&g_leaf_idx, leaf_idx, (size_t)leaves_next * 4, &g_stage_keys, MAX_CHILD * 4 * 4);
        uint32_t beam_idx_ram[(MAXPLY + 1) * WIDTH];
        readback(&g_beam_idx, beam_idx_ram, sizeof beam_idx_ram, &g_stage_keys, MAX_CHILD * 4 * 4);

        int ply_count = MAXPLY;
        for (int p = 1; p <= MAXPLY; p++) if (st[ST_BEAM_COUNT + p] == 0) { ply_count = p; break; }
        int deepest_slice = 0;
        for (int s = 1; s <= MAXPLY; s++) if (st[ST_BEAM_COUNT + s] > 0) deepest_slice = s;

        // first moves from the ply-0 children (fm index = child index)
        uint32_t nc0 = st[ST_N_CHILD + 0];
        uint32_t ab0 = st[ST_ARENA_BASE + 0];
        FirstMove *fms = malloc((size_t)(nc0 ? nc0 : 1) * sizeof(FirstMove));
        for (uint32_t c = 0; c < nc0; c++) {
            const uint32_t *r = recs + (size_t)(ab0 + c) * EX_OUT_STRIDE;
            FirstMove *fm = &fms[c];
            memset(fm, 0, sizeof *fm);
            fm->s_kind = (int32_t)r[95]; fm->s_rot = (int32_t)r[96]; fm->s_x = (int32_t)r[97];
            fm->s_y = (int32_t)r[98]; fm->s_srs = (int32_t)r[99]; fm->s_tspin = (int32_t)r[100];
            fm->s_used_hold = (int32_t)r[101]; fm->s_lines = (int32_t)r[102]; fm->s_attack = (int32_t)r[103];
            fm->s_reward_bits = (uint64_t)r[104] | ((uint64_t)r[105] << 32);
            memcpy(fm->board, r, 40 * 4);
            fm->lift = (int32_t)r[86]; fm->pending = (int32_t)r[85];
        }

        // ---- final selection (step-1 host semantics) ----
        int32_t best_idx = -1;
        double best_val = 0.0;
        int32_t best_root = -1, best_depth = 0;
        int32_t rb_root[4096]; double rb_val[4096]; int rb_len = 0;
        const uint32_t *lv = NULL;
        size_t nlv = 0;
        uint32_t deepest_ram[WIDTH];
        if (status == 0) {
            if (leaves_next > 0) { lv = leaf_idx; nlv = leaves_next; }
            else if (deepest_slice > 0) {
                uint32_t bc = st[ST_BEAM_COUNT + deepest_slice];
                for (uint32_t i = 0; i < bc; i++) deepest_ram[i] = beam_idx_ram[deepest_slice * WIDTH + i];
                lv = deepest_ram; nlv = bc;
            }
            for (size_t li = 0; li < nlv; li++) {
                const uint32_t *r = recs + (size_t)lv[li] * EX_OUT_STRIDE;
                if (r[94] == 0) continue;
                double v = bits_f64((uint64_t)r[90] | ((uint64_t)r[91] << 32));
                if (best_idx < 0 || v > best_val) {
                    best_idx = (int32_t)lv[li]; best_val = v;
                    best_root = (int32_t)r[93]; best_depth = (int32_t)r[94];
                }
                int32_t root = (int32_t)r[93];
                int pos = -1;
                for (int i = 0; i < rb_len; i++) if (rb_root[i] == root) { pos = i; break; }
                if (pos >= 0) {
                    if (v > rb_val[pos]) rb_val[pos] = v;
                } else if (rb_len < 4096) {
                    rb_root[rb_len] = root; rb_val[rb_len] = v; rb_len++;
                }
            }
            if (best_idx < 0) status = 1;
        }

        ow32(out, (uint32_t)status);
        if (status != 0) {
            for (int i = 0; i < 6; i++) ow32(out, 0);
            ow32(out, 0); ow64(out, 0); ow64(out, 0); ow32(out, 0);
            ow32(out, 0); ow32(out, 0);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, 0.0);
        } else {
            FirstMove *fn = &fms[best_root];
            ow32(out, (uint32_t)fn->s_kind);
            ow32(out, (uint32_t)fn->s_rot);
            ow32(out, (uint32_t)fn->s_x);
            ow32(out, (uint32_t)fn->s_y);
            ow32(out, (uint32_t)fn->s_srs);
            ow32(out, (uint32_t)fn->s_tspin);
            ow32(out, (uint32_t)fn->s_used_hold);
            uint64_t bv; { double v = best_val; memcpy(&bv, &v, 8); }
            ow64(out, bv);
            ow64(out, nodes);
            ow32(out, (uint32_t)best_depth);
            int32_t idxs[4096];
            for (int i = 0; i < rb_len; i++) idxs[i] = i;
            for (int i = 1; i < rb_len; i++) {
                int32_t t = idxs[i]; int j = i - 1;
                while (j >= 0 && rb_val[idxs[j]] < rb_val[t]) { idxs[j + 1] = idxs[j]; j--; }
                idxs[j + 1] = t;
            }
            ow32(out, (uint32_t)rb_len);
            for (int i = 0; i < rb_len; i++) {
                FirstMove *fm = &fms[rb_root[idxs[i]]];
                ow32(out, (uint32_t)fm->s_kind);
                ow32(out, (uint32_t)fm->s_rot);
                ow32(out, (uint32_t)fm->s_x);
                ow32(out, (uint32_t)fm->s_y);
                ow32(out, (uint32_t)fm->s_srs);
                ow32(out, (uint32_t)fm->s_tspin);
                ow32(out, (uint32_t)fm->s_used_hold);
                uint64_t cv; { double v = rb_val[idxs[i]]; memcpy(&cv, &v, 8); }
                ow64(out, cv);
            }
            ow32(out, (uint32_t)ply_count);
            for (int p = 0; p < ply_count; p++) {
                uint32_t bc = st[ST_BEAM_COUNT + p + 1];
                ow32(out, bc);
                for (uint32_t i = 0; i < bc; i++)
                    write_wire_record(out, recs + (size_t)beam_idx_ram[(p + 1) * WIDTH + i] * EX_OUT_STRIDE, root_due);
                uint32_t lc = st[ST_LEAF_COUNT + p];
                uint32_t lb = st[ST_LEAF_BASE + p];
                ow32(out, lc);
                for (uint32_t i = 0; i < lc; i++)
                    write_wire_record(out, recs + (size_t)leaf_idx[lb + i] * EX_OUT_STRIDE, root_due);
            }
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, wall - gpu_span);
        }
        free(recs); free(leaf_idx); free(fms);
    }
    return status;
}

static uint32_t *load_decisions(const char *path, uint32_t *n_out) {
    size_t len; uint8_t *raw = slurp(path, &len);
    const uint8_t *p = raw;
    if (rd32(&p) != DC_MAGIC) { fprintf(stderr, "bad decisions magic\n"); exit(1); }
    uint32_t n = rd32(&p);
    if (len != 8 + (size_t)n * DEC_WORDS * 4) { fprintf(stderr, "decisions size mismatch: %zu vs %zu\n", len, 8 + (size_t)n * DEC_WORDS * 4); exit(1); }
    uint32_t *dec = malloc((size_t)n * DEC_WORDS * 4);
    memcpy(dec, p, (size_t)n * DEC_WORDS * 4);
    free(raw);
    *n_out = n;
    return dec;
}


// ---- expandtime (step 3 ablation timing; outputs are NOT verified) ----
typedef VkResult (VKAPI_PTR *PFN_vkGetShaderInfoAMD_s3)(VkDevice, VkPipeline, VkShaderStageFlagBits, VkShaderInfoTypeAMD, size_t *, void *);
static void try_shader_info(void) {
    PFN_vkGetShaderInfoAMD_s3 fn = (PFN_vkGetShaderInfoAMD_s3)vkGetDeviceProcAddr(dev, "vkGetShaderInfoAMD");
    if (!fn) { printf("shader-info: vkGetShaderInfoAMD unavailable\n"); return; }
    VkShaderStatisticsInfoAMD st; size_t sz = sizeof st; memset(&st, 0, sizeof st);
    VkResult r = fn(dev, g_ex_pipe.pipe, VK_SHADER_STAGE_COMPUTE_BIT, VK_SHADER_INFO_TYPE_STATISTICS_AMD, &sz, &st);
    if (r != VK_SUCCESS) { printf("shader-info: query failed (%d)\n", (int)r); return; }
    printf("shader-info: usedVgprs %u, usedSgprs %u, physicalVgprs %u, physicalSgprs %u, "
           "ldsPerWG %u, ldsUsage %u, scratch %zu B/invocation, wgSize %u %u %u\n",
           st.resourceUsage.numUsedVgprs, st.resourceUsage.numUsedSgprs,
           st.numPhysicalVgprs, st.numPhysicalSgprs,
           st.resourceUsage.ldsSizePerLocalWorkGroup, st.resourceUsage.ldsUsageSizeInBytes,
           st.resourceUsage.scratchMemUsageInBytes,
           st.computeWorkGroupSize[0], st.computeWorkGroupSize[1], st.computeWorkGroupSize[2]);
}

static int cmd_expandtime(const char *spv, const char *tables_path, const char *cases_path, int reps, int ls) {
    size_t len; uint8_t *raw = slurp(cases_path, &len);
    const uint8_t *p = raw;
    if (rd32(&p) != EX_MAGIC) { fprintf(stderr, "bad cases magic\n"); exit(1); }
    (void)rd32(&p);
    uint32_t n = rd32(&p);
    printf("expandtime: %u cases, %d reps, local_size %d\n", n, reps, ls);
    pipeline_init(NULL, spv, tables_path, 0);
    try_shader_info();
    const uint32_t *src = (const uint32_t *)p;
    double total_gpu = 0.0; uint64_t total_inv = 0;
    for (uint32_t base = 0; base < n; base += MAX_CHILD) {
        uint32_t cn = n - base < MAX_CHILD ? n - base : MAX_CHILD;
        uint32_t *ip = g_stage_in.ptr;
        for (uint32_t i = 0; i < cn; i++)
            memcpy(ip + (size_t)i * EX_IN_STRIDE, src + (size_t)(base + i) * (EX_IN_STRIDE + EX_OUT_STRIDE), EX_IN_STRIDE * 4);
        uint32_t *stp = g_state_stage.ptr;
        memset(stp, 0, ST_WORDS * 4);
        stp[ST_N_CHILD] = cn;
        stp[ST_ARENA_BASE] = 0;
        VkCommandBuffer cmd = begin_cmd();
        VkBufferCopy c1 = { 0, 0, (VkDeviceSize)cn * EX_IN_STRIDE * 4 };
        vkCmdCopyBuffer(cmd, g_stage_in.buf, g_ex_in_d.buf, 1, &c1);
        VkBufferCopy c2 = { 0, 0, (VkDeviceSize)ST_WORDS * 4 };
        vkCmdCopyBuffer(cmd, g_state_stage.buf, g_state.buf, 1, &c2);
        barrier_transfer_to_compute(cmd);
        submit_wait(cmd);
        uint32_t groups = (cn + (uint32_t)ls - 1) / (uint32_t)ls;
        uint32_t push = 0;
        VkCommandBuffer cw = begin_cmd();
        vkCmdBindPipeline(cw, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.pipe);
        vkCmdBindDescriptorSets(cw, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.layout, 0, 1, &g_ex_set, 0, NULL);
        vkCmdPushConstants(cw, g_ex_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
        for (int r = 0; r < 3; r++) { vkCmdDispatch(cw, groups, 1, 1); if (r < 2) barrier_rw(cw); }
        submit_wait(cw);
        VkCommandBuffer ct = begin_cmd();
        vkCmdResetQueryPool(ct, tpool, 0, 2);
        vkCmdWriteTimestamp(ct, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, tpool, 0);
        vkCmdBindPipeline(ct, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.pipe);
        vkCmdBindDescriptorSets(ct, VK_PIPELINE_BIND_POINT_COMPUTE, g_ex_pipe.layout, 0, 1, &g_ex_set, 0, NULL);
        vkCmdPushConstants(ct, g_ex_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
        for (int r = 0; r < reps; r++) { vkCmdDispatch(ct, groups, 1, 1); if (r + 1 < reps) barrier_rw(ct); }
        vkCmdWriteTimestamp(ct, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, tpool, 1);
        submit_wait(ct);
        uint64_t ts[2];
        CK(vkGetQueryPoolResults(dev, tpool, 0, 2, sizeof ts, ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
        double ms = (double)(ts[1] - ts[0]) * ts_period_ns * 1e-6;
        total_gpu += ms; total_inv += (uint64_t)cn * (uint64_t)reps;
        printf("expandtime chunk @%u: %u cases x %d reps = %.3f ms\n", base, cn, reps, ms);
        fflush(stdout);
    }
    printf("EXPANDTIME total %.3f ms for %llu invocations: %.1f ns/child, %.0f children/ms\n",
           total_gpu, (unsigned long long)total_inv,
           total_gpu * 1e6 / (double)total_inv, (double)total_inv / total_gpu);
    return 0;
}


static void rec_sort_prof(VkCommandBuffer cmd, uint32_t ply, uint32_t keyOff, int base_stage) {
    int sep = s14_sep();
    for (int pass = 0; pass < 8; pass++) {
        int s = pass & 1;
        uint32_t push[3] = { ply, (uint32_t)pass * 8, keyOff };
        if (sep != 2 && sep != 3) reci(cmd, &g_hist_pipe, g_hist_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        stamp2(cmd, base_stage * 15 + (int)ply);
        if (sep != 2 && sep != 3) {
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_scan_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_scan_pipe.layout, 0, 1, &g_scan_set, 0, NULL);
            vkCmdPushConstants(cmd, g_scan_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
            vkCmdDispatchIndirect(cmd, g_scanargs.buf, (VkDeviceSize)ply * 12);
        }
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        stamp2(cmd, (base_stage + 1) * 15 + (int)ply);
        if (sep != 2 && sep != 3) reci(cmd, &g_scatter_pipe, g_scatter_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        stamp2(cmd, (base_stage + 2) * 15 + (int)ply);
    }
}

static void rec_sort_prof_fused(VkCommandBuffer cmd, uint32_t ply, uint32_t keyOff, int base_stage) {
    int sep = s14_sep();
    for (int pass = 0; pass < 8; pass++) {
        int s = pass & 1;
        uint32_t push[3] = { ply, (uint32_t)pass * 8, keyOff };
        if (sep != 2 && sep != 3) reci(cmd, &g_hist_pipe, g_hist_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        stamp2(cmd, base_stage * 15 + (int)ply);
        stamp2(cmd, (base_stage + 1) * 15 + (int)ply); // no scan stage: SCANK bucket ~ 0
        if (sep != 2 && sep != 3) reci(cmd, &g_fscatK_pipe, g_fscatK_set[s], push, 12, ply, ARG_TILE);
        if (sep != 1 && sep != 3) barrier_rw(cmd);
        stamp2(cmd, (base_stage + 2) * 15 + (int)ply);
    }
}

static int run_decision_prof(const uint32_t *dec, double *wall_ms, double *gpu_ms, double *acc, uint32_t *nch) {
    Out *out = NULL;
    double t_start = now_s();
    int32_t root_due = (int32_t)dec[104];

    uint32_t *pm = g_params.ptr;
    pm[PM_SEQ_LEN] = dec[81];
    pm[PM_BOARD_LEN] = dec[80];
    pm[PM_ACTIVE_ROT] = dec[96];
    pm[PM_ACTIVE_X] = dec[97];
    pm[PM_ACTIVE_Y] = dec[98];
    pm[PM_ROOT_HOLD] = dec[99];
    pm[PM_ROOT_CAN_HOLD] = dec[100];
    pm[PM_ROOT_DUE] = dec[104];
    for (int i = 0; i < 14; i++) pm[PM_SEQ + i] = dec[82 + i];
    pm[PM_OPTS] = g_profile_opts;

    uint32_t *rs = g_root_stage.ptr;
    memset(rs, 0, EX_OUT_STRIDE * 4);
    for (int i = 0; i < 40; i++) { rs[i] = dec[i] & 0xFFFFu; rs[40 + i] = dec[40 + i] & 0xFFu; }
    rs[80] = dec[80]; rs[81] = dec[99]; rs[82] = 0; rs[83] = dec[103]; rs[84] = dec[101];
    rs[85] = dec[102]; rs[86] = 0; rs[87] = dec[105]; rs[93] = 0xFFFFFFFFu;

    VkCommandBuffer cmd = begin_cmd();
    vkCmdResetQueryPool(cmd, ptpool, 0, PROF_MAXQ);
    g_q = 0;
    g_seq[g_q] = -1;
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, ptpool, 0);
    g_q++;
    if (g_serial_base + MAXPLY - 1 > 240) {
        vkCmdFillBuffer(cmd, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
        g_serial_base = 1;
    }
    {
        VkBufferCopy rc = { 0, 0, (VkDeviceSize)EX_OUT_STRIDE * 4 };
        vkCmdCopyBuffer(cmd, g_root_stage.buf, g_arena.buf, 1, &rc);
    }
    barrier_transfer_to_compute(cmd);
    rec1(cmd, &g_init_pipe, g_init_set, NULL, 0);
    barrier_rw(cmd);
    stamp2(cmd, PST_INIT);
    int stopped = 0;
    vkCmdFillBuffer(cmd, g_htable.buf, 0, VK_WHOLE_SIZE, 0);  // S19
    barrier_transfer_to_compute(cmd);
    for (uint32_t ply = 0; ply < MAXPLY; ply++) {
        rec1(cmd, &g_mgb_pipe, g_mgb_set, &ply, 4);
        barrier_rw(cmd);
        stamp2(cmd, PST_MGB * 15 + (int)ply);
        if ((int)ply == g_stop_ply) { stopped = 1; break; }
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.layout, 0, 1, &g_mg_set, 0, NULL);
        uint32_t mgpc[2] = { 1, g_serial_base + ply };
        vkCmdPushConstants(cmd, g_mg_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, mgpc);
        vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + ARG_MG) * 12);
        barrier_rw(cmd);
        stamp2(cmd, PST_MG * 15 + (int)ply);
        rec1(cmd, &g_exs_pipe, g_exs_set, &ply, 4);
        barrier_rw(cmd);
        stamp2(cmd, PST_EXS * 15 + (int)ply);
        reci(cmd, &g_exb_pipe, s23_soa() == 1 ? g_exb_set_soa : g_exb_set, &ply, 4, ply, ARG_EXB);
        barrier_rw(cmd);
        if (s23_soa() == 2) { reci(cmd, &g_ext_pipe, g_ext_set, &ply, 4, ply, ARG_EXB); barrier_rw(cmd); }  // S23 transpose
        stamp2(cmd, PST_EXB * 15 + (int)ply);
        reci(cmd, &g_ex_pipe, s23_soa() ? g_ex_set_soa : g_ex_set, &ply, 4, ply, ARG_EXP);
        barrier_rw(cmd);
        stamp2(cmd, PST_EXP * 15 + (int)ply);
        reci(cmd, &g_prep_pipe, g_prep_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        stamp2(cmd, PST_PREP * 15 + (int)ply);
        {   // OPT-STEP4 sortless dedupe: one stable radix pass on hash
            // bits 48..55 groups equal-hash children in index order;
            // sel_resolve keeps the first child of each full key.
            uint32_t dpush[3] = { ply, 48u, 2u };
            uint32_t apushA19[3] = { ply, 48u, 0u };  // S19g
            if (!s22_passA()) { if (s22_h7fuse()) reci(cmd, &g_h6x_pipe, g_h6x_set, apushA19, 12, ply, ARG_TILE); else reci(cmd, &g_hist_pipe, g_hist_set_a19, apushA19, 12, ply, ARG_TILE); }  // S19g hist1; S22: h6x also zeroes tilehist
            barrier_rw(cmd);
            stamp2(cmd, PST_DHIST * 15 + (int)ply);
            stamp2(cmd, PST_DSCAN * 15 + (int)ply);
            stamp2(cmd, PST_DSCAT * 15 + (int)ply);
        }
        // S19: hash-table dedupe (insert -> lookup -> cleanup)
        reci(cmd, &g_htins_pipe, g_htins_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        reci(cmd, &g_htlook_pipe, g_htlook_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        stamp2(cmd, PST_RESOLV * 15 + (int)ply);
        {
            uint32_t apush1[3] = { ply, 48u, 0u };
            uint32_t apush2[3] = { ply, 56u, 0u };
            // S18: pass-A first histogram is computed by the fused
            // hist dispatch at the dedupe position (into tilehist2).
            barrier_rw(cmd);
            if (s22_passA()) {
                rec1(cmd, &g_passA_pipe, g_passA_set, &ply, 4);  // S22: fused pass A (bucket: histH)
                barrier_rw(cmd);
                stamp2(cmd, PST_HISTH * 15 + (int)ply);
                stamp2(cmd, PST_SCANH * 15 + (int)ply);
            } else {
                if (s22_h7fuse()) reci(cmd, &g_h7f_pipe, g_h7f_set_pd2, apush1, 12, ply, ARG_TILE); else reci(cmd, &g_fscat_pipe, g_fscat_set_pd2, apush1, 12, ply, ARG_TILE);  // S22: h7f emits the byte-7 tile histogram
                barrier_rw(cmd);
                stamp2(cmd, PST_HISTH * 15 + (int)ply);
                if (!s22_h7fuse()) reci(cmd, &g_hist_pipe, g_hist_set_pd, apush2, 12, ply, ARG_TILE);  // S22: byte-7 hist is the h7f byproduct when fused
                barrier_rw(cmd);
                reci(cmd, &g_fscat_pipe, g_fscat_set_pe, apush2, 12, ply, ARG_TILE);
                barrier_rw(cmd);
                stamp2(cmd, PST_SCANH * 15 + (int)ply);
            }
            reci(cmd, &g_binhist_pipe, g_binhist_set, &ply, 4, ply, ARG_TILE);
            barrier_rw(cmd);
            stamp2(cmd, PST_SCATH * 15 + (int)ply);
            rec1(cmd, &g_thresh_pipe, g_thresh_set, &ply, 4);
            barrier_rw(cmd);
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.layout, 0, 1, &g_clear_set, 0, NULL);
            vkCmdDispatch(cmd, 512, 1, 1);
            barrier_rw(cmd);
            stamp2(cmd, PST_SEG * 15 + (int)ply);
        }
        s21_pred_begin(cmd, ply);
        if (s14_fused()) rec_sort_prof_fused(cmd, ply, 0, PST_HISTK); else rec_sort_prof(cmd, ply, 0, PST_HISTK);
        reci(cmd, &g_idxcopy_pipe, g_idxcopy_set, &ply, 4, ply, ARG_TILE);
        s21_pred_end(cmd);
        barrier_rw(cmd);
        stamp2(cmd, PST_COPY * 15 + (int)ply);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.layout, 0, 1, &g_bitonic_set, 0, NULL);
        vkCmdPushConstants(cmd, g_bitonic_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
        vkCmdDispatchIndirect(cmd, g_bitargs.buf, (VkDeviceSize)ply * 12);
        barrier_rw(cmd);
        stamp2(cmd, PST_REP * 15 + (int)ply);
        rec1(cmd, &g_compact5_pipe, g_compact5_set, &ply, 4);
        barrier_rw(cmd);
        stamp2(cmd, PST_CMP * 15 + (int)ply);
        reci(cmd, &g_leafprep_pipe, g_leafprep_set, &ply, 4, ply, ARG_LEAFP);
        barrier_rw(cmd);
        stamp2(cmd, PST_LPRE * 15 + (int)ply);
        reci(cmd, &g_leafsum_pipe, g_leafsum_set, &ply, 4, ply, ARG_LEAFS);
        barrier_rw(cmd);
        stamp2(cmd, PST_LSUM * 15 + (int)ply);
        rec1(cmd, &g_leafscan_pipe, g_leafscan_set, &ply, 4);
        barrier_rw(cmd);
        stamp2(cmd, PST_LSCN * 15 + (int)ply);
        reci(cmd, &g_leafscatter_pipe, g_leafscatter_set, &ply, 4, ply, ARG_LEAFS);
        barrier_rw(cmd);
        stamp2(cmd, PST_LSCT * 15 + (int)ply);
    }
    if (!stopped) {
        barrier_compute_to_transfer(cmd);
        VkBufferCopy sc = { 0, 0, (VkDeviceSize)ST_WORDS * 4 };
        vkCmdCopyBuffer(cmd, g_state.buf, g_state_mirror.buf, 1, &sc);
        stamp2(cmd, PST_TAIL);
    }

    double t0 = now_ms();
    CK(vkEndCommandBuffer(cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cmd, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    CK(vkQueueWaitIdle(queue));
    vkFreeCommandBuffers(dev, pool, 1, &cmd);
    g_submit_ms += now_ms() - t0;
    static uint64_t ts[PROF_MAXQ];
    CK(vkGetQueryPoolResults(dev, ptpool, 0, (uint32_t)g_q, sizeof ts, ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double gpu_span = (double)(ts[g_q - 1] - ts[0]) * ts_period_ns * 1e-6;
    for (int k = 1; k < g_q; k++) {
        int slot = g_seq[k];
        if (slot >= 0) acc[slot] += (double)(ts[k] - ts[k - 1]) * ts_period_ns * 1e-3; // us
    }
    g_serial_base += MAXPLY;

    uint32_t *st = g_state_mirror.ptr;
    int status = 0;
    if (st[ST_ERROR]) status = 2;
    for (int p = 0; p < MAXPLY; p++) if (st[ST_REPAIR_ERR + p]) status = 2;
    g_ln1p_total += st[ST_LN1P];
    uint64_t nodes = 0;
    for (int p = 0; p < MAXPLY; p++) { nodes += st[ST_N_CHILD + p]; nch[p] = st[ST_N_CHILD + p]; }
    double wall = (now_s() - t_start) * 1e3;
    if (wall_ms) *wall_ms = wall;
    if (gpu_ms) *gpu_ms = gpu_span;

    if (out) {
        uint32_t arena_next = st[ST_ARENA_NEXT];
        uint32_t leaves_next = st[ST_LEAVES_NEXT];
        uint32_t *recs = malloc((size_t)(arena_next ? arena_next : 1) * EX_OUT_STRIDE * 4);
        readback(&g_arena, recs, (size_t)arena_next * EX_OUT_STRIDE * 4, &g_stage_out, MAX_CHILD * EX_OUT_STRIDE * 4);
        uint32_t *leaf_idx = malloc((size_t)(leaves_next ? leaves_next : 1) * 4);
        readback(&g_leaf_idx, leaf_idx, (size_t)leaves_next * 4, &g_stage_keys, MAX_CHILD * 4 * 4);
        uint32_t beam_idx_ram[(MAXPLY + 1) * WIDTH];
        readback(&g_beam_idx, beam_idx_ram, sizeof beam_idx_ram, &g_stage_keys, MAX_CHILD * 4 * 4);

        int ply_count = MAXPLY;
        for (int p = 1; p <= MAXPLY; p++) if (st[ST_BEAM_COUNT + p] == 0) { ply_count = p; break; }
        int deepest_slice = 0;
        for (int s = 1; s <= MAXPLY; s++) if (st[ST_BEAM_COUNT + s] > 0) deepest_slice = s;

        // first moves from the ply-0 children (fm index = child index)
        uint32_t nc0 = st[ST_N_CHILD + 0];
        uint32_t ab0 = st[ST_ARENA_BASE + 0];
        FirstMove *fms = malloc((size_t)(nc0 ? nc0 : 1) * sizeof(FirstMove));
        for (uint32_t c = 0; c < nc0; c++) {
            const uint32_t *r = recs + (size_t)(ab0 + c) * EX_OUT_STRIDE;
            FirstMove *fm = &fms[c];
            memset(fm, 0, sizeof *fm);
            fm->s_kind = (int32_t)r[95]; fm->s_rot = (int32_t)r[96]; fm->s_x = (int32_t)r[97];
            fm->s_y = (int32_t)r[98]; fm->s_srs = (int32_t)r[99]; fm->s_tspin = (int32_t)r[100];
            fm->s_used_hold = (int32_t)r[101]; fm->s_lines = (int32_t)r[102]; fm->s_attack = (int32_t)r[103];
            fm->s_reward_bits = (uint64_t)r[104] | ((uint64_t)r[105] << 32);
            memcpy(fm->board, r, 40 * 4);
            fm->lift = (int32_t)r[86]; fm->pending = (int32_t)r[85];
        }

        // ---- final selection (step-1 host semantics) ----
        int32_t best_idx = -1;
        double best_val = 0.0;
        int32_t best_root = -1, best_depth = 0;
        int32_t rb_root[4096]; double rb_val[4096]; int rb_len = 0;
        const uint32_t *lv = NULL;
        size_t nlv = 0;
        uint32_t deepest_ram[WIDTH];
        if (status == 0) {
            if (leaves_next > 0) { lv = leaf_idx; nlv = leaves_next; }
            else if (deepest_slice > 0) {
                uint32_t bc = st[ST_BEAM_COUNT + deepest_slice];
                for (uint32_t i = 0; i < bc; i++) deepest_ram[i] = beam_idx_ram[deepest_slice * WIDTH + i];
                lv = deepest_ram; nlv = bc;
            }
            for (size_t li = 0; li < nlv; li++) {
                const uint32_t *r = recs + (size_t)lv[li] * EX_OUT_STRIDE;
                if (r[94] == 0) continue;
                double v = bits_f64((uint64_t)r[90] | ((uint64_t)r[91] << 32));
                if (best_idx < 0 || v > best_val) {
                    best_idx = (int32_t)lv[li]; best_val = v;
                    best_root = (int32_t)r[93]; best_depth = (int32_t)r[94];
                }
                int32_t root = (int32_t)r[93];
                int pos = -1;
                for (int i = 0; i < rb_len; i++) if (rb_root[i] == root) { pos = i; break; }
                if (pos >= 0) {
                    if (v > rb_val[pos]) rb_val[pos] = v;
                } else if (rb_len < 4096) {
                    rb_root[rb_len] = root; rb_val[rb_len] = v; rb_len++;
                }
            }
            if (best_idx < 0) status = 1;
        }

        ow32(out, (uint32_t)status);
        if (status != 0) {
            for (int i = 0; i < 6; i++) ow32(out, 0);
            ow32(out, 0); ow64(out, 0); ow64(out, 0); ow32(out, 0);
            ow32(out, 0); ow32(out, 0);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, 0.0);
        } else {
            FirstMove *fn = &fms[best_root];
            ow32(out, (uint32_t)fn->s_kind);
            ow32(out, (uint32_t)fn->s_rot);
            ow32(out, (uint32_t)fn->s_x);
            ow32(out, (uint32_t)fn->s_y);
            ow32(out, (uint32_t)fn->s_srs);
            ow32(out, (uint32_t)fn->s_tspin);
            ow32(out, (uint32_t)fn->s_used_hold);
            uint64_t bv; { double v = best_val; memcpy(&bv, &v, 8); }
            ow64(out, bv);
            ow64(out, nodes);
            ow32(out, (uint32_t)best_depth);
            int32_t idxs[4096];
            for (int i = 0; i < rb_len; i++) idxs[i] = i;
            for (int i = 1; i < rb_len; i++) {
                int32_t t = idxs[i]; int j = i - 1;
                while (j >= 0 && rb_val[idxs[j]] < rb_val[t]) { idxs[j + 1] = idxs[j]; j--; }
                idxs[j + 1] = t;
            }
            ow32(out, (uint32_t)rb_len);
            for (int i = 0; i < rb_len; i++) {
                FirstMove *fm = &fms[rb_root[idxs[i]]];
                ow32(out, (uint32_t)fm->s_kind);
                ow32(out, (uint32_t)fm->s_rot);
                ow32(out, (uint32_t)fm->s_x);
                ow32(out, (uint32_t)fm->s_y);
                ow32(out, (uint32_t)fm->s_srs);
                ow32(out, (uint32_t)fm->s_tspin);
                ow32(out, (uint32_t)fm->s_used_hold);
                uint64_t cv; { double v = rb_val[idxs[i]]; memcpy(&cv, &v, 8); }
                ow64(out, cv);
            }
            ow32(out, (uint32_t)ply_count);
            for (int p = 0; p < ply_count; p++) {
                uint32_t bc = st[ST_BEAM_COUNT + p + 1];
                ow32(out, bc);
                for (uint32_t i = 0; i < bc; i++)
                    write_wire_record(out, recs + (size_t)beam_idx_ram[(p + 1) * WIDTH + i] * EX_OUT_STRIDE, root_due);
                uint32_t lc = st[ST_LEAF_COUNT + p];
                uint32_t lb = st[ST_LEAF_BASE + p];
                ow32(out, lc);
                for (uint32_t i = 0; i < lc; i++)
                    write_wire_record(out, recs + (size_t)leaf_idx[lb + i] * EX_OUT_STRIDE, root_due);
            }
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, wall - gpu_span);
        }
        free(recs); free(leaf_idx); free(fms);
    }
    return status;
}

static const char *pstage_names[PST_NSTAGE] = {
    "mg_build", "movegen", "ex_scan", "ex_build", "expand", "prep",
    "histK", "scanK", "scatterK", "idxcopy", "histH", "scanH", "scatterH",
    "segment", "repair", "flags", "compact",
    "leaf_prep", "leaf_tsum", "leaf_scan", "leaf_scatter",
    "dd_hist", "dd_scan", "dd_scat", "resolve"
};
static int cmd_prof(const char *mg_spv, const char *ex_spv, const char *tables_path, const char *dec_path, int reps) {
    uint32_t n;
    uint32_t *decs = load_decisions(dec_path, &n);
    pipeline_init(mg_spv, ex_spv, tables_path, 1);
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, PROF_MAXQ, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &ptpool));
    static double acc[PST_SLOTS];
    static uint64_t nch_sum[MAXPLY];
    memset(acc, 0, sizeof acc); memset(nch_sum, 0, sizeof nch_sum);
    double span_sum = 0.0, wall_sum = 0.0;
    int bad = 0;
    uint64_t total_dec = 0;
    for (int r = 0; r < reps; r++) {
        for (uint32_t i = 0; i < n; i++) {
            double cur[PST_SLOTS]; memset(cur, 0, sizeof cur);
            uint32_t nch[MAXPLY]; memset(nch, 0, sizeof nch);
            double wall, gpu;
            int st = run_decision_prof(decs + (size_t)i * DEC_WORDS, &wall, &gpu, cur, nch);
            if (st != 0) bad++;
            for (int s = 0; s < PST_SLOTS; s++) acc[s] += cur[s];
            for (int p = 0; p < MAXPLY; p++) nch_sum[p] += nch[p];
            span_sum += gpu; wall_sum += wall; total_dec++;
        }
        printf("prof rep %d done (bad %d)\n", r, bad); fflush(stdout);
    }
    double nd = (double)total_dec;
    printf("PROF %llu decisions, %d non-ok; GPU span mean %.3f ms, wall mean %.3f ms\n",
           (unsigned long long)total_dec, bad, span_sum / nd, wall_sum / nd);
    double stage_tot[PST_NSTAGE];
    for (int s = 0; s < PST_NSTAGE; s++) {
        stage_tot[s] = 0.0;
        for (int p = 0; p < MAXPLY; p++) stage_tot[s] += acc[s * 15 + p];
    }
    double accounted = acc[PST_INIT] + acc[PST_TAIL];
    for (int s = 0; s < PST_NSTAGE; s++) accounted += stage_tot[s];
    printf("stage totals (us/decision, share of span):\n");
    printf("  %-10s %9.1f  %5.1f%%\n", "init", acc[PST_INIT] / nd, 100.0 * acc[PST_INIT] / (span_sum * 1e3));
    for (int s = 0; s < PST_NSTAGE; s++)
        printf("  %-10s %9.1f  %5.1f%%\n", pstage_names[s], stage_tot[s] / nd, 100.0 * stage_tot[s] / (span_sum * 1e3));
    printf("  %-10s %9.1f  %5.1f%%\n", "tail", acc[PST_TAIL] / nd, 100.0 * acc[PST_TAIL] / (span_sum * 1e3));
    printf("  accounted %.1f us of span %.1f us (%.1f%%)\n", accounted / nd, span_sum * 1e3 / nd, 100.0 * accounted / (span_sum * 1e3));
    printf("per-ply detail (us/decision): ply n_child mg movegen exscan exbuild expand prep sortK dedupe compact leaf4 total\n");
    for (int p = 0; p < MAXPLY; p++) {
        double sortK = (acc[PST_HISTK * 15 + p] + acc[PST_SCANK * 15 + p] + acc[PST_SCATK * 15 + p]) / nd;
        double dedupe = (acc[PST_DHIST * 15 + p] + acc[PST_DSCAN * 15 + p] + acc[PST_DSCAT * 15 + p] + acc[PST_RESOLV * 15 + p]) / nd;
        double leaf4 = (acc[PST_LPRE * 15 + p] + acc[PST_LSUM * 15 + p] + acc[PST_LSCN * 15 + p] + acc[PST_LSCT * 15 + p]) / nd;
        double all = 0.0; for (int s = 0; s < PST_NSTAGE; s++) all += acc[s * 15 + p];
        printf("  ply %2d: n %7.1f | %7.1f %7.1f %7.1f %7.1f %7.1f %7.1f %7.1f %7.1f %7.1f %7.1f | total %8.1f\n",
               p, (double)nch_sum[p] / nd,
               acc[PST_MGB * 15 + p] / nd, acc[PST_MG * 15 + p] / nd, acc[PST_EXS * 15 + p] / nd,
               acc[PST_EXB * 15 + p] / nd, acc[PST_EXP * 15 + p] / nd, acc[PST_PREP * 15 + p] / nd,
               sortK, dedupe, acc[PST_CMP * 15 + p] / nd, leaf4, all / nd);
    }
    printf("per-ply s13 buckets (us/decision): ply repair dd_scat dd_scan scatK scanK histK nch\n");
    for (int p = 0; p < MAXPLY; p++)
        printf("  s13 ply %2d: %8.1f %8.1f %8.1f %8.1f %8.1f %8.1f %8.1f\n", p,
               acc[PST_REP * 15 + p] / nd, acc[PST_DSCAT * 15 + p] / nd,
               acc[PST_DSCAN * 15 + p] / nd, acc[PST_SCATK * 15 + p] / nd,
               acc[PST_SCANK * 15 + p] / nd, acc[PST_HISTK * 15 + p] / nd,
               (double)nch_sum[p] / nd);
    return bad ? 1 : 0;
}

// STEP9 mgreplay: run one decision's chain up to (and including) the
// target ply's mg_build, then re-dispatch that ply's movegen K times
// back-to-back in a single submit (fresh serials, production barrier
// shape), stamping every dispatch in-chain. This measures the movegen
// dispatch's true GPU latency in chain shape, with no other stage and
// no per-stage prof stamps interleaved.
static int cmd_mgreplay(const char *mg_spv, const char *ex_spv, const char *tables_path, const char *dec_path, int deci, int ply, int K) {
    uint32_t n;
    uint32_t *decs = load_decisions(dec_path, &n);
    if (deci < 0 || (uint32_t)deci >= n) { fprintf(stderr, "deci out of range\n"); return 64; }
    if (K < 1 || K > 200) { fprintf(stderr, "K out of range\n"); return 64; }
    pipeline_init(mg_spv, ex_spv, tables_path, 1);
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, PROF_MAXQ, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &ptpool));
    const uint32_t *dec = decs + (size_t)deci * DEC_WORDS;
    double wall, gpu, acc[PST_SLOTS]; uint32_t nch[MAXPLY];
    // warm-up: 3 full decisions (clocks + caches), stamps off
    g_stamp_mode = 0; g_stop_ply = -1;
    for (int i = 0; i < 3; i++) { memset(acc, 0, sizeof acc); run_decision_prof(dec, &wall, &gpu, acc, nch); }
    // stopped run: leaves mg_in + args for `ply` live on the device
    g_stop_ply = ply;
    memset(acc, 0, sizeof acc);
    run_decision_prof(dec, &wall, &gpu, acc, nch);
    g_stop_ply = -1;
    // instance count for the ply (state readback)
    uint32_t stmp[ST_WORDS];
    readback(&g_state, stmp, sizeof stmp, &g_state_mirror, sizeof stmp);
    uint32_t n_inst = stmp[ST_N_INST + ply];
    // replay pool
    VkQueryPool rpool;
    VkQueryPoolCreateInfo rqi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, 256, 0 };
    CK(vkCreateQueryPool(dev, &rqi, NULL, &rpool));
    uint32_t sbase = g_serial_base + 40;
    if (sbase + (uint32_t)K > 241) {
        VkCommandBuffer fc = begin_cmd();
        vkCmdFillBuffer(fc, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
        submit_wait(fc);
        sbase = 60;
    }
    VkCommandBuffer cmd = begin_cmd();
    vkCmdResetQueryPool(cmd, rpool, 0, (uint32_t)K + 1);
    for (int k = 0; k < K; k++) {
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, rpool, (uint32_t)k);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.layout, 0, 1, &g_mg_set, 0, NULL);
        uint32_t mgpc[2] = { 1, sbase + (uint32_t)k };
        vkCmdPushConstants(cmd, g_mg_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, mgpc);
        vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + ARG_MG) * 12);
        barrier_rw(cmd);
    }
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, rpool, (uint32_t)K);
    double t0 = now_ms();
    submit_wait(cmd);
    double submit_ms = now_ms() - t0;
    static uint64_t ts[256];
    CK(vkGetQueryPoolResults(dev, rpool, 0, (uint32_t)K + 1, sizeof(uint64_t) * (K + 1), ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double d[200];
    for (int k = 0; k < K; k++) d[k] = (double)(ts[k + 1] - ts[k]) * ts_period_ns * 1e-3; // us
    double sorted[200]; memcpy(sorted, d, sizeof(double) * K);
    for (int i = 0; i < K; i++) for (int j = i + 1; j < K; j++) if (sorted[j] < sorted[i]) { double t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t; }
    double sum = 0; for (int k = 0; k < K; k++) sum += d[k];
    printf("MGREPLAY deci %d ply %d n_inst %u K %d: per-dispatch us: first %.1f, median %.1f, mean %.1f, min %.1f, max %.1f; span %.1f us, submit wall %.1f us\n",
           deci, ply, n_inst, K, d[0], sorted[K / 2], sum / K, sorted[0], sorted[K - 1],
           (double)(ts[K] - ts[0]) * ts_period_ns * 1e-3, submit_ms * 1e3);
    printf("MGREPLAY series:");
    for (int k = 0; k < K; k++) printf(" %.0f", d[k]);
    printf("\n");
    return 0;
}

static int cmd_mgreplay2(const char *mg_spv, const char *replay_mg_spv, const char *ex_spv, const char *tables_path, const char *dec_path, int deci, int ply, int K) {
    uint32_t n;
    uint32_t *decs = load_decisions(dec_path, &n);
    if (deci < 0 || (uint32_t)deci >= n) { fprintf(stderr, "deci out of range\n"); return 64; }
    if (K < 1 || K > 200) { fprintf(stderr, "K out of range\n"); return 64; }
    pipeline_init(mg_spv, ex_spv, tables_path, 1);
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, PROF_MAXQ, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &ptpool));
    const uint32_t *dec = decs + (size_t)deci * DEC_WORDS;
    double wall, gpu, acc[PST_SLOTS]; uint32_t nch[MAXPLY];
    // warm-up: 3 full decisions (clocks + caches), stamps off
    g_stamp_mode = 0; g_stop_ply = -1;
    for (int i = 0; i < 3; i++) { memset(acc, 0, sizeof acc); run_decision_prof(dec, &wall, &gpu, acc, nch); }
    // stopped run: leaves mg_in + args for `ply` live on the device
    g_stop_ply = ply;
    memset(acc, 0, sizeof acc);
    run_decision_prof(dec, &wall, &gpu, acc, nch);
    g_stop_ply = -1;
    // instance count for the ply (state readback)
    uint32_t stmp[ST_WORDS];
    readback(&g_state, stmp, sizeof stmp, &g_state_mirror, sizeof stmp);
    uint32_t n_inst = stmp[ST_N_INST + ply];
    // replay pool
    VkQueryPool rpool;
    VkQueryPoolCreateInfo rqi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, 256, 0 };
    CK(vkCreateQueryPool(dev, &rqi, NULL, &rpool));
    uint32_t sbase = g_serial_base + 40;
    if (sbase + (uint32_t)K > 241) {
        VkCommandBuffer fc = begin_cmd();
        vkCmdFillBuffer(fc, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
        submit_wait(fc);
        sbase = 60;
    }
    Pipe rp = make_pipe(replay_mg_spv, 3, 8);
    VkDescriptorSet rset;
    { Buf *b[3] = { &g_mg_in_d, &g_mg_scratch, &g_mg_out_d }; rset = make_set(&rp, b, 3); }
    VkCommandBuffer cmd = begin_cmd();
    vkCmdResetQueryPool(cmd, rpool, 0, (uint32_t)K + 1);
    for (int k = 0; k < K; k++) {
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, rpool, (uint32_t)k);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, rp.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, rp.layout, 0, 1, &rset, 0, NULL);
        uint32_t mgpc[2] = { 1, sbase + (uint32_t)k };
        vkCmdPushConstants(cmd, rp.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, mgpc);
        vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + ARG_MG) * 12);
        barrier_rw(cmd);
    }
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, rpool, (uint32_t)K);
    double t0 = now_ms();
    submit_wait(cmd);
    double submit_ms = now_ms() - t0;
    static uint64_t ts[256];
    CK(vkGetQueryPoolResults(dev, rpool, 0, (uint32_t)K + 1, sizeof(uint64_t) * (K + 1), ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double d[200];
    for (int k = 0; k < K; k++) d[k] = (double)(ts[k + 1] - ts[k]) * ts_period_ns * 1e-3; // us
    double sorted[200]; memcpy(sorted, d, sizeof(double) * K);
    for (int i = 0; i < K; i++) for (int j = i + 1; j < K; j++) if (sorted[j] < sorted[i]) { double t = sorted[i]; sorted[i] = sorted[j]; sorted[j] = t; }
    double sum = 0; for (int k = 0; k < K; k++) sum += d[k];
    printf("MGREPLAY2 deci %d ply %d n_inst %u K %d: per-dispatch us: first %.1f, median %.1f, mean %.1f, min %.1f, max %.1f; span %.1f us, submit wall %.1f us\n",
           deci, ply, n_inst, K, d[0], sorted[K / 2], sum / K, sorted[0], sorted[K - 1],
           (double)(ts[K] - ts[0]) * ts_period_ns * 1e-3, submit_ms * 1e3);
    printf("MGREPLAY2 series:");
    for (int k = 0; k < K; k++) printf(" %.0f", d[k]);
    printf("\n");
    return 0;
}

static int run_decision_dump(const uint32_t *dec, Out *out, double *wall_ms, double *gpu_ms) {
    double t_start = now_s();
    int32_t root_due = (int32_t)dec[104];

    uint32_t *pm = g_params.ptr;
    pm[PM_SEQ_LEN] = dec[81];
    pm[PM_BOARD_LEN] = dec[80];
    pm[PM_ACTIVE_ROT] = dec[96];
    pm[PM_ACTIVE_X] = dec[97];
    pm[PM_ACTIVE_Y] = dec[98];
    pm[PM_ROOT_HOLD] = dec[99];
    pm[PM_ROOT_CAN_HOLD] = dec[100];
    pm[PM_ROOT_DUE] = dec[104];
    for (int i = 0; i < 14; i++) pm[PM_SEQ + i] = dec[82 + i];
    pm[PM_OPTS] = g_profile_opts;

    uint32_t *rs = g_root_stage.ptr;
    memset(rs, 0, EX_OUT_STRIDE * 4);
    for (int i = 0; i < 40; i++) { rs[i] = dec[i] & 0xFFFFu; rs[40 + i] = dec[40 + i] & 0xFFu; }
    rs[80] = dec[80]; rs[81] = dec[99]; rs[82] = 0; rs[83] = dec[103]; rs[84] = dec[101];
    rs[85] = dec[102]; rs[86] = 0; rs[87] = dec[105]; rs[93] = 0xFFFFFFFFu;

    VkCommandBuffer cmd = begin_cmd();
    vkCmdResetQueryPool(cmd, tpool, 0, 2);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, tpool, 0);
    if (g_serial_base + MAXPLY - 1 > 240) {
        vkCmdFillBuffer(cmd, g_mg_scratch.buf, 0, VK_WHOLE_SIZE, 0);
        g_serial_base = 1;
    }
    {
        VkBufferCopy rc = { 0, 0, (VkDeviceSize)EX_OUT_STRIDE * 4 };
        vkCmdCopyBuffer(cmd, g_root_stage.buf, g_arena.buf, 1, &rc);
    }
    barrier_transfer_to_compute(cmd);
    rec1(cmd, &g_init_pipe, g_init_set, NULL, 0);
    barrier_rw(cmd);
    vkCmdFillBuffer(cmd, g_htable.buf, 0, VK_WHOLE_SIZE, 0);  // S19
    barrier_transfer_to_compute(cmd);
    for (uint32_t ply = 0; ply < MAXPLY; ply++) {
        rec1(cmd, &g_mgb_pipe, g_mgb_set, &ply, 4);
        barrier_rw(cmd);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_mg_pipe.layout, 0, 1, &g_mg_set, 0, NULL);
        uint32_t mgpc[2] = { 1, g_serial_base + ply };
        vkCmdPushConstants(cmd, g_mg_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 8, mgpc);
        vkCmdDispatchIndirect(cmd, g_args.buf, (VkDeviceSize)(ply * ARG_KINDS + ARG_MG) * 12);
        barrier_rw(cmd);
        rec1(cmd, &g_exs_pipe, g_exs_set, &ply, 4);
        barrier_rw(cmd);
        reci(cmd, &g_exb_pipe, s23_soa() == 1 ? g_exb_set_soa : g_exb_set, &ply, 4, ply, ARG_EXB);
        barrier_rw(cmd);
        if (s23_soa() == 2) { reci(cmd, &g_ext_pipe, g_ext_set, &ply, 4, ply, ARG_EXB); barrier_rw(cmd); }  // S23 transpose
        reci(cmd, &g_ex_pipe, s23_soa() ? g_ex_set_soa : g_ex_set, &ply, 4, ply, ARG_EXP);
        barrier_rw(cmd);
        reci(cmd, &g_prep_pipe, g_prep_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        {   // OPT-STEP4 sortless dedupe: one stable radix pass on hash
            // bits 48..55 groups equal-hash children in index order;
            // sel_resolve keeps the first child of each full key.
            uint32_t dpush[3] = { ply, 48u, 2u };
            uint32_t apushA19[3] = { ply, 48u, 0u };  // S19g
            if (!s22_passA()) { if (s22_h7fuse()) reci(cmd, &g_h6x_pipe, g_h6x_set, apushA19, 12, ply, ARG_TILE); else reci(cmd, &g_hist_pipe, g_hist_set_a19, apushA19, 12, ply, ARG_TILE); }  // S19g hist1; S22: h6x also zeroes tilehist
            barrier_rw(cmd);
        }
        // S19: hash-table dedupe (insert -> lookup -> cleanup)
        reci(cmd, &g_htins_pipe, g_htins_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        reci(cmd, &g_htlook_pipe, g_htlook_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        {   // OPT-STEP5 partial selection: two stable radix passes
            // (K byte 6, then byte 7) group children by the top 16
            // bits of K into scratch buffer idxE, leaving idxA's
            // identity array and idxB's dedupe order untouched so the
            // fallback below stays exact. binhist16 builds the joint
            // (total, selected) histogram over the 65536 top-16 bins;
            // thresh16 finds the threshold bin and the region end,
            // writes surv_total, and either arms the bitonic finisher
            // (zeroing this ply's ARG_TILE args so the full sort and
            // idxcopy become no-ops) or leaves the full sort as the
            // fallback path.
            uint32_t apush1[3] = { ply, 48u, 0u };
            uint32_t apush2[3] = { ply, 56u, 0u };
            // S18: pass-A first histogram is computed by the fused
            // hist dispatch at the dedupe position (into tilehist2).
            barrier_rw(cmd);
            if (s22_passA()) {
                rec1(cmd, &g_passA_pipe, g_passA_set, &ply, 4);  // S22: fused pass A
                barrier_rw(cmd);
            } else {
                if (s22_h7fuse()) reci(cmd, &g_h7f_pipe, g_h7f_set_pd2, apush1, 12, ply, ARG_TILE); else reci(cmd, &g_fscat_pipe, g_fscat_set_pd2, apush1, 12, ply, ARG_TILE);  // S22: h7f emits the byte-7 tile histogram
                barrier_rw(cmd);
                if (!s22_h7fuse()) reci(cmd, &g_hist_pipe, g_hist_set_pd, apush2, 12, ply, ARG_TILE);  // S22: byte-7 hist is the h7f byproduct when fused
                barrier_rw(cmd);
                reci(cmd, &g_fscat_pipe, g_fscat_set_pe, apush2, 12, ply, ARG_TILE);
                barrier_rw(cmd);
            }
            reci(cmd, &g_binhist_pipe, g_binhist_set, &ply, 4, ply, ARG_TILE);
            barrier_rw(cmd);
            rec1(cmd, &g_thresh_pipe, g_thresh_set, &ply, 4);
            barrier_rw(cmd);
            vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.pipe);
            vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_clear_pipe.layout, 0, 1, &g_clear_set, 0, NULL);
            vkCmdDispatch(cmd, 512, 1, 1);
            barrier_rw(cmd);
        }
        s21_pred_begin(cmd, ply);
        rec_sort(cmd, ply, 0); // by composite key K (fallback; no-op when finisher armed)
        reci(cmd, &g_idxcopy_pipe, g_idxcopy_set, &ply, 4, ply, ARG_TILE);
        s21_pred_end(cmd);
        barrier_rw(cmd);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.pipe);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_bitonic_pipe.layout, 0, 1, &g_bitonic_set, 0, NULL);
        vkCmdPushConstants(cmd, g_bitonic_pipe.layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &ply);
        vkCmdDispatchIndirect(cmd, g_bitargs.buf, (VkDeviceSize)ply * 12);
        barrier_rw(cmd);
        rec1(cmd, &g_compact5_pipe, g_compact5_set, &ply, 4);
        barrier_rw(cmd);
        reci(cmd, &g_snap_pipe, g_snap_set, &ply, 4, ply, ARG_TILE);
        barrier_rw(cmd);
        reci(cmd, &g_leafprep_pipe, g_leafprep_set, &ply, 4, ply, ARG_LEAFP);
        barrier_rw(cmd);
        reci(cmd, &g_leafsum_pipe, g_leafsum_set, &ply, 4, ply, ARG_LEAFS);
        barrier_rw(cmd);
        rec1(cmd, &g_leafscan_pipe, g_leafscan_set, &ply, 4);
        barrier_rw(cmd);
        reci(cmd, &g_leafscatter_pipe, g_leafscatter_set, &ply, 4, ply, ARG_LEAFS);
        barrier_rw(cmd);
    }
    barrier_compute_to_transfer(cmd);
    {
        VkBufferCopy sc = { 0, 0, (VkDeviceSize)ST_WORDS * 4 };
        vkCmdCopyBuffer(cmd, g_state.buf, g_state_mirror.buf, 1, &sc);
    }
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, tpool, 1);

    double t0 = now_ms();
    CK(vkEndCommandBuffer(cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cmd, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, VK_NULL_HANDLE));
    CK(vkQueueWaitIdle(queue));
    vkFreeCommandBuffers(dev, pool, 1, &cmd);
    g_submit_ms += now_ms() - t0;
    uint64_t ts[2] = {0, 0};
    CK(vkGetQueryPoolResults(dev, tpool, 0, 2, sizeof ts, ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double gpu_span = (double)(ts[1] - ts[0]) * ts_period_ns * 1e-6;
    g_serial_base += MAXPLY;

    uint32_t *st = g_state_mirror.ptr;
    int status = 0;
    if (st[ST_ERROR]) status = 2;
    for (int p = 0; p < MAXPLY; p++) if (st[ST_REPAIR_ERR + p]) status = 2;
    g_ln1p_total += st[ST_LN1P];
    uint64_t nodes = 0;
    for (int p = 0; p < MAXPLY; p++) nodes += st[ST_N_CHILD + p];
    double wall = (now_s() - t_start) * 1e3;
    if (wall_ms) *wall_ms = wall;
    if (gpu_ms) *gpu_ms = gpu_span;

    if (out) {
        uint32_t arena_next = st[ST_ARENA_NEXT];
        uint32_t leaves_next = st[ST_LEAVES_NEXT];
        uint32_t *recs = malloc((size_t)(arena_next ? arena_next : 1) * EX_OUT_STRIDE * 4);
        readback(&g_arena, recs, (size_t)arena_next * EX_OUT_STRIDE * 4, &g_stage_out, MAX_CHILD * EX_OUT_STRIDE * 4);
        uint32_t *leaf_idx = malloc((size_t)(leaves_next ? leaves_next : 1) * 4);
        readback(&g_leaf_idx, leaf_idx, (size_t)leaves_next * 4, &g_stage_keys, MAX_CHILD * 4 * 4);
        uint32_t beam_idx_ram[(MAXPLY + 1) * WIDTH];
        readback(&g_beam_idx, beam_idx_ram, sizeof beam_idx_ram, &g_stage_keys, MAX_CHILD * 4 * 4);

        int ply_count = MAXPLY;
        for (int p = 1; p <= MAXPLY; p++) if (st[ST_BEAM_COUNT + p] == 0) { ply_count = p; break; }
        int deepest_slice = 0;
        for (int s = 1; s <= MAXPLY; s++) if (st[ST_BEAM_COUNT + s] > 0) deepest_slice = s;

        // first moves from the ply-0 children (fm index = child index)
        uint32_t nc0 = st[ST_N_CHILD + 0];
        uint32_t ab0 = st[ST_ARENA_BASE + 0];
        FirstMove *fms = malloc((size_t)(nc0 ? nc0 : 1) * sizeof(FirstMove));
        for (uint32_t c = 0; c < nc0; c++) {
            const uint32_t *r = recs + (size_t)(ab0 + c) * EX_OUT_STRIDE;
            FirstMove *fm = &fms[c];
            memset(fm, 0, sizeof *fm);
            fm->s_kind = (int32_t)r[95]; fm->s_rot = (int32_t)r[96]; fm->s_x = (int32_t)r[97];
            fm->s_y = (int32_t)r[98]; fm->s_srs = (int32_t)r[99]; fm->s_tspin = (int32_t)r[100];
            fm->s_used_hold = (int32_t)r[101]; fm->s_lines = (int32_t)r[102]; fm->s_attack = (int32_t)r[103];
            fm->s_reward_bits = (uint64_t)r[104] | ((uint64_t)r[105] << 32);
            memcpy(fm->board, r, 40 * 4);
            fm->lift = (int32_t)r[86]; fm->pending = (int32_t)r[85];
        }

        // ---- final selection (step-1 host semantics) ----
        int32_t best_idx = -1;
        double best_val = 0.0;
        int32_t best_root = -1, best_depth = 0;
        int32_t rb_root[4096]; double rb_val[4096]; int rb_len = 0;
        const uint32_t *lv = NULL;
        size_t nlv = 0;
        uint32_t deepest_ram[WIDTH];
        if (status == 0) {
            if (leaves_next > 0) { lv = leaf_idx; nlv = leaves_next; }
            else if (deepest_slice > 0) {
                uint32_t bc = st[ST_BEAM_COUNT + deepest_slice];
                for (uint32_t i = 0; i < bc; i++) deepest_ram[i] = beam_idx_ram[deepest_slice * WIDTH + i];
                lv = deepest_ram; nlv = bc;
            }
            for (size_t li = 0; li < nlv; li++) {
                const uint32_t *r = recs + (size_t)lv[li] * EX_OUT_STRIDE;
                if (r[94] == 0) continue;
                double v = bits_f64((uint64_t)r[90] | ((uint64_t)r[91] << 32));
                if (best_idx < 0 || v > best_val) {
                    best_idx = (int32_t)lv[li]; best_val = v;
                    best_root = (int32_t)r[93]; best_depth = (int32_t)r[94];
                }
                int32_t root = (int32_t)r[93];
                int pos = -1;
                for (int i = 0; i < rb_len; i++) if (rb_root[i] == root) { pos = i; break; }
                if (pos >= 0) {
                    if (v > rb_val[pos]) rb_val[pos] = v;
                } else if (rb_len < 4096) {
                    rb_root[rb_len] = root; rb_val[rb_len] = v; rb_len++;
                }
            }
            if (best_idx < 0) status = 1;
        }

        ow32(out, (uint32_t)status);
        if (status != 0) {
            for (int i = 0; i < 6; i++) ow32(out, 0);
            ow32(out, 0); ow64(out, 0); ow64(out, 0); ow32(out, 0);
            ow32(out, 0); ow32(out, 0);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, 0.0);
        } else {
            FirstMove *fn = &fms[best_root];
            ow32(out, (uint32_t)fn->s_kind);
            ow32(out, (uint32_t)fn->s_rot);
            ow32(out, (uint32_t)fn->s_x);
            ow32(out, (uint32_t)fn->s_y);
            ow32(out, (uint32_t)fn->s_srs);
            ow32(out, (uint32_t)fn->s_tspin);
            ow32(out, (uint32_t)fn->s_used_hold);
            uint64_t bv; { double v = best_val; memcpy(&bv, &v, 8); }
            ow64(out, bv);
            ow64(out, nodes);
            ow32(out, (uint32_t)best_depth);
            int32_t idxs[4096];
            for (int i = 0; i < rb_len; i++) idxs[i] = i;
            for (int i = 1; i < rb_len; i++) {
                int32_t t = idxs[i]; int j = i - 1;
                while (j >= 0 && rb_val[idxs[j]] < rb_val[t]) { idxs[j + 1] = idxs[j]; j--; }
                idxs[j + 1] = t;
            }
            ow32(out, (uint32_t)rb_len);
            for (int i = 0; i < rb_len; i++) {
                FirstMove *fm = &fms[rb_root[idxs[i]]];
                ow32(out, (uint32_t)fm->s_kind);
                ow32(out, (uint32_t)fm->s_rot);
                ow32(out, (uint32_t)fm->s_x);
                ow32(out, (uint32_t)fm->s_y);
                ow32(out, (uint32_t)fm->s_srs);
                ow32(out, (uint32_t)fm->s_tspin);
                ow32(out, (uint32_t)fm->s_used_hold);
                uint64_t cv; { double v = rb_val[idxs[i]]; memcpy(&cv, &v, 8); }
                ow64(out, cv);
            }
            ow32(out, (uint32_t)ply_count);
            for (int p = 0; p < ply_count; p++) {
                uint32_t bc = st[ST_BEAM_COUNT + p + 1];
                ow32(out, bc);
                for (uint32_t i = 0; i < bc; i++)
                    write_wire_record(out, recs + (size_t)beam_idx_ram[(p + 1) * WIDTH + i] * EX_OUT_STRIDE, root_due);
                uint32_t lc = st[ST_LEAF_COUNT + p];
                uint32_t lb = st[ST_LEAF_BASE + p];
                ow32(out, lc);
                for (uint32_t i = 0; i < lc; i++)
                    write_wire_record(out, recs + (size_t)leaf_idx[lb + i] * EX_OUT_STRIDE, root_due);
            }
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, wall - gpu_span);
        }
        free(recs); free(leaf_idx); free(fms);
    }
    return status;
}

// ---- dump mode (step 5 evaluation): snapshot selection inputs ----
static int cmd_dump(const char *mg_spv, const char *ex_spv, const char *tables_path, const char *dec_path, const char *out_path, int ndec) {
    uint32_t n;
    uint32_t *decs = load_decisions(dec_path, &n);
    if (ndec > (int)n) ndec = (int)n;
    pipeline_init(mg_spv, ex_spv, tables_path, 1);
    FILE *f = fopen(out_path, "wb");
    if (!f) { fprintf(stderr, "cannot write %s\n", out_path); return 1; }
    uint32_t hdr[4] = { 0x35355044u, 1u, (uint32_t)ndec, MAX_CHILD };
    fwrite(hdr, 4, 4, f);
    int bad = 0;
    for (int d = 0; d < ndec; d++) {
        double wall, gpu;
        int st = run_decision_dump(decs + (size_t)d * DEC_WORDS, NULL, &wall, &gpu);
        if (st != 0) bad++;
        uint32_t *sm = (uint32_t *)g_state_mirror.ptr;
        uint32_t nch[MAXPLY];
        for (int p = 0; p < MAXPLY; p++) nch[p] = sm[ST_N_CHILD + p];
        fwrite(nch, 4, MAXPLY, f);
        fwrite(g_snap.ptr, 4, (size_t)MAXPLY * MAX_CHILD * 4, f);
        printf("dump dec %d status %d wall %.3f ms\n", d, st, wall); fflush(stdout);
    }
    fclose(f);
    printf("dump done: %d decisions, %d non-ok; wrote %s\n", ndec, bad, out_path);
    return bad ? 1 : 0;
}

// ---- serve mode (product path): long-lived engine process ----
// Protocol (binary, stdin -> stdout):
//   request:  one decision record, DEC_WORDS u32 (432 bytes), no header.
//   response: u32 status, u32 block_bytes, then the exact per-decision
//             block run_decision_s2 appends in run mode (the same bytes
//             that follow the RS_MAGIC + count header in a results
//             file), so existing results parsers consume serve output
//             unchanged.
// EOF on stdin at a record boundary ends the process with status 0.
// All diagnostics go to stderr: pipeline_init's stdout chatter is
// redirected to stderr during setup so the protocol channel stays
// clean. Vulkan init is paid once per process, not per decision.
static int cmd_serve(const char *mg_spv, const char *ex_spv, const char *tables_path, const char *want) {
    fflush(stdout);
    int saved = dup(1);
    if (saved < 0 || dup2(2, 1) < 0) { fprintf(stderr, "serve: cannot redirect stdout\n"); return 1; }
    vk_setup(want);  // vk_setup also prints to stdout; keep it off the protocol channel
    pipeline_init(mg_spv, ex_spv, tables_path, 1);
    fflush(stdout);
    if (dup2(saved, 1) < 0) { fprintf(stderr, "serve: cannot restore stdout\n"); return 1; }
    close(saved);
    static uint32_t dec[DEC_WORDS];
    for (;;) {
        size_t got = fread(dec, 4, DEC_WORDS, stdin);
        if (got == 0) return 0;  // clean EOF at a record boundary
        if (got != DEC_WORDS) { fprintf(stderr, "serve: truncated decision record\n"); return 1; }
        Out out = {0};
        double wall, gpu;
        int st = run_decision_s2(dec, &out, &wall, &gpu);
        uint32_t hdr[2] = { (uint32_t)st, (uint32_t)out.len };
        fwrite(hdr, 4, 2, stdout);
        if (out.len) fwrite(out.buf, 1, out.len, stdout);
        fflush(stdout);
        free(out.buf);
    }
}

int main(int argc, char **argv) {
    profile_resolve();
    if (argc < 2) {
        fprintf(stderr, "usage:\n"
                        "  vkrunner_s3 expandtime <expand.spv> <tables.bin> <cases.bin> [reps] [local_size] [device]\n"
                        "  vkrunner_s2 expandcheck <expand.spv> <tables.bin> <cases.bin> [device]\n"
                        "  vkrunner_s2 run <movegen.spv> <expand.spv> <tables.bin> <decisions.bin> <out.bin> [max_decisions] [device]\n"
                        "  vkrunner_s2 bench <movegen.spv> <expand.spv> <tables.bin> <decisions.bin> <reps> [device]\n"
                        "  vkrunner_s2 serve <movegen.spv> <expand.spv> <tables.bin> [device]\n");
        return 64;
    }
    const char *mode = argv[1];
    const char *want = "RX 6400";
    if (!strcmp(mode, "expandtime")) {
        if (argc > 7) want = argv[7];
        vk_setup(want);
        int reps = argc > 5 ? atoi(argv[5]) : 10;
        int ls = argc > 6 ? atoi(argv[6]) : 64;
        return cmd_expandtime(argv[2], argv[3], argv[4], reps, ls);
    }
    if (!strcmp(mode, "expandcheck")) {
        if (argc > 5) want = argv[5];
        vk_setup(want);
        return cmd_expandcheck(argv[2], argv[3], argv[4]);
    }
    if (!strcmp(mode, "serve")) {
        if (argc > 5) want = argv[5];
        return cmd_serve(argv[2], argv[3], argv[4], want);
    }
    if (!strcmp(mode, "run")) {
        if (argc > 8) want = argv[8];
        else if (argc > 7 && atoi(argv[7]) == 0 && strcmp(argv[7], "0")) want = argv[7];
        vk_setup(want);
        uint32_t n;
        uint32_t *decs = load_decisions(argv[5], &n);
        uint32_t maxd = n;
        if (argc > 7 && atoi(argv[7]) > 0) maxd = (uint32_t)atoi(argv[7]);
        if (maxd > n) maxd = n;
        pipeline_init(argv[2], argv[3], argv[4], 1);
        int mgctr = getenv("S14_MGCTR") != NULL;
        uint32_t mgh0[4] = {0, 0, 0, 0}, mgh1[4] = {0, 0, 0, 0};
        if (mgctr) readback(&g_mg_out_d, mgh0, 16, &g_state_stage, ST_WORDS * 4);
        Out out = {0};
        ow32(&out, RS_MAGIC);
        ow32(&out, maxd);
        int bad = 0;
        for (uint32_t i = 0; i < maxd; i++) {
            double wall, gpu;
            int st = run_decision_s2(decs + (size_t)i * DEC_WORDS, &out, &wall, &gpu);
            if (st != 0) bad++;
            printf("decision %u: status %d, wall %.3f ms (GPU span %.3f ms)\n", i, st, wall, gpu);
            fflush(stdout);
        }
        FILE *f = fopen(argv[6], "wb");
        if (!f) { fprintf(stderr, "cannot write %s\n", argv[6]); return 1; }
        fwrite(out.buf, 1, out.len, f);
        fclose(f);
        printf("run done: %u decisions, %d non-ok, ln1p-range flags %llu; wrote %s (%zu bytes)\n",
               maxd, bad, (unsigned long long)g_ln1p_total, argv[6], out.len);
        if (mgctr) {
            readback(&g_mg_out_d, mgh1, 16, &g_state_stage, ST_WORDS * 4);
            printf("mgctr: emit_invocations %u, over_threshold %u\n",
                   mgh1[1] - mgh0[1], mgh1[2] - mgh0[2]);
        }
        return bad ? 1 : 0;
    }
    if (!strcmp(mode, "bench")) {
        if (argc > 7) want = argv[7];
        vk_setup(want);
        uint32_t n;
        uint32_t *decs = load_decisions(argv[5], &n);
        int reps = atoi(argv[6]);
        pipeline_init(argv[2], argv[3], argv[4], 1);
        double *walls = malloc((size_t)n * reps * sizeof(double));
        double *gpus = malloc((size_t)n * reps * sizeof(double));
        int bad = 0;
        for (int r = 0; r < reps; r++) {
            for (uint32_t i = 0; i < n; i++) {
                double wall, gpu;
                int st = run_decision_s2(decs + (size_t)i * DEC_WORDS, NULL, &wall, &gpu);
                if (st != 0) bad++;
                walls[(size_t)r * n + i] = wall;
                gpus[(size_t)r * n + i] = gpu;
            }
            printf("bench rep %d done (bad so far %d)\n", r, bad);
            fflush(stdout);
        }
        size_t total = (size_t)n * reps;
        double *sorted = malloc(total * sizeof(double));
        memcpy(sorted, walls, total * sizeof(double));
        qsort(sorted, total, sizeof(double), cmp_double);
        double sum_wall = 0, sum_gpu = 0;
        for (size_t i = 0; i < total; i++) { sum_wall += walls[i]; sum_gpu += gpus[i]; }
        printf("BENCH %zu decisions x %d reps, %d non-ok, ln1p-range flags %llu\n",
               (size_t)n, reps, bad, (unsigned long long)g_ln1p_total);
        printf("  wall/decision: median %.3f ms, p95 %.3f ms, min %.3f ms, mean %.3f ms\n",
               sorted[total / 2], sorted[(size_t)(total * 0.95) < total ? (size_t)(total * 0.95) : total - 1],
               sorted[0], sum_wall / total);
        printf("  GPU span mean %.3f ms/decision, submit wall mean %.3f ms/decision, pure host (record+params) mean %.3f ms/decision\n",
               sum_gpu / total, g_submit_ms / total, (sum_wall - g_submit_ms) / total);
        return bad ? 1 : 0;
    }
    if (!strcmp(mode, "prof")) {
        if (argc > 7) want = argv[7];
        vk_setup(want);
        int reps = argc > 6 ? atoi(argv[6]) : 2;
        return cmd_prof(argv[2], argv[3], argv[4], argv[5], reps);
    }
    if (!strcmp(mode, "prof9")) {
        // prof9 <mg> <ex> <T> <D> <reps> <density 0|1|2> [device]
        if (argc > 8) want = argv[8];
        vk_setup(want);
        int reps = argc > 6 ? atoi(argv[6]) : 2;
        g_stamp_mode = argc > 7 ? atoi(argv[7]) : 2;
        return cmd_prof(argv[2], argv[3], argv[4], argv[5], reps);
    }
    if (!strcmp(mode, "mgreplay")) {
        // mgreplay <mg> <ex> <T> <D> <deci> <ply> <K> [device]
        if (argc > 9) want = argv[9];
        vk_setup(want);
        int deci = argc > 6 ? atoi(argv[6]) : 0;
        int ply = argc > 7 ? atoi(argv[7]) : 0;
        int K = argc > 8 ? atoi(argv[8]) : 40;
        return cmd_mgreplay(argv[2], argv[3], argv[4], argv[5], deci, ply, K);
    }
    if (!strcmp(mode, "mgreplay2")) {
        // mgreplay2 <setup_mg> <replay_mg> <ex> <T> <D> <deci> <ply> <K> [device]
        if (argc > 10) want = argv[10];
        vk_setup(want);
        int deci = argc > 7 ? atoi(argv[7]) : 0;
        int ply = argc > 8 ? atoi(argv[8]) : 0;
        int K = argc > 9 ? atoi(argv[9]) : 40;
        return cmd_mgreplay2(argv[2], argv[3], argv[4], argv[5], argv[6], deci, ply, K);
    }
    if (!strcmp(mode, "dump")) {
        if (argc > 8) want = argv[8];
        vk_setup(want);
        int ndec = argc > 7 ? atoi(argv[7]) : 3;
        return cmd_dump(argv[2], argv[3], argv[4], argv[5], argv[6], ndec);
    }
    fprintf(stderr, "unknown mode '%s'\n", mode);
    return 64;
}
