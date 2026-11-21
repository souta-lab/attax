// pfserve.c — Persistent sub-0.7ms live GPU engine host for Attax (S2 & Guideline/TBP).
//
// Modes:
//   pfserve serve <pfl_r15_serve.spv> <tables.bin> [G=96] [device]
//   pfserve serve <movegen.spv> <expand.spv> <tables.bin> [device]   (drop-in vkrunner_s26 serve CLI compatibility)
//   pfserve bench <pfl_r15_serve.spv> <tables.bin> <decisions.bin> [reps=3] [G=96]
//   pfserve run   <pfl_r15_serve.spv> <tables.bin> <decisions.bin> <out.bin> [max_decisions] [G=96]
//
// Env:
//   ATTAX_GPU_PROFILE=s2|guideline  (default s2; guideline sets flags |= 2)
//   ATTAX_GPU_G=<multiples of 12>   (default 96)
//   ATTAX_GPU=<device substring>    (default "RX 6400")
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <sched.h>
#include <vulkan/vulkan.h>

#define CK(x) do { VkResult _r = (x); if (_r != VK_SUCCESS) { fprintf(stderr, "VK %d at %s:%d\n", _r, __FILE__, __LINE__); exit(1); } } while (0)

#define TB_MAGIC  0x4D345442u
#define DC_MAGIC  0x4D344443u
#define RS_MAGIC  0x4D345253u
#define DEC_WORDS 108u
#define STATE_WORDS 524288u
#define OUT_WORDS   4096u

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec * 1e-9;
}
static int cmp_double(const void *a, const void *b) {
    double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}
static uint32_t rd32(const uint8_t **p) {
    uint32_t v;
    memcpy(&v, *p, 4);
    *p += 4;
    return v;
}
static uint8_t *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "cannot open %s\n", path); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(n ? (size_t)n : 1);
    if (n && fread(b, 1, (size_t)n, f) != (size_t)n) exit(1);
    fclose(f); *len = (size_t)n; return b;
}

static int g_profile_guideline = 0;
static void profile_resolve(void) {
    const char *p = getenv("ATTAX_GPU_PROFILE");
    if (p && !strcmp(p, "guideline")) g_profile_guideline = 1;
    else g_profile_guideline = 0;
    fprintf(stderr, "profile: %s (persistent r15)\n", g_profile_guideline ? "guideline" : "s2");
}

static VkDevice dev;
static VkQueue queue;
static VkCommandPool pool;
static VkPhysicalDeviceMemoryProperties mp;
static VkQueryPool qpool;
static double tsp_ns;
static VkCommandBuffer cb;
static VkFence g_fence;
static VkPipeline kpipe;
static VkPipelineLayout lay;
static VkDescriptorSet dset;

typedef struct { VkBuffer buf; VkDeviceMemory mem; uint8_t *ptr; } Buf;
static Buf bctrl, buni, btab, bstate, bout, bdummy;

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
    int t = -1;
    if (devlocal) {
        t = find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    } else {
        t = find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT);
        if (t < 0) t = find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT | VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
        if (t < 0) t = find_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    }
    if (t < 0) { fprintf(stderr, "no memory type\n"); exit(1); }
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, NULL, mr.size, (uint32_t)t };
    CK(vkAllocateMemory(dev, &ai, NULL, &b.mem));
    CK(vkBindBufferMemory(dev, b.buf, b.mem, 0));
    if (!devlocal) CK(vkMapMemory(dev, b.mem, 0, VK_WHOLE_SIZE, 0, (void **)&b.ptr));
    return b;
}

static void vk_setup(const char *want) {
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, NULL, "pfserve", 1, "pfserve", 1, VK_API_VERSION_1_3 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, NULL, 0, &app, 0, NULL, 0, NULL };
    VkInstance vi; CK(vkCreateInstance(&ici, NULL, &vi));
    uint32_t nd = 0; CK(vkEnumeratePhysicalDevices(vi, &nd, NULL));
    VkPhysicalDevice ds[8]; CK(vkEnumeratePhysicalDevices(vi, &nd, ds));
    VkPhysicalDevice ph = VK_NULL_HANDLE; VkPhysicalDeviceProperties pr;
    const char *wantGpu = getenv("ATTAX_GPU");
    if (!wantGpu || !wantGpu[0]) wantGpu = want;
    if (wantGpu && wantGpu[0]) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (strstr(pr.deviceName, wantGpu)) { ph = ds[i]; break; } }
    }
    if (!ph) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (strstr(pr.deviceName, "RX 6400")) { ph = ds[i]; break; } }
    }
    if (!ph) {
        for (uint32_t i = 0; i < nd; i++) { vkGetPhysicalDeviceProperties(ds[i], &pr); if (pr.deviceType == VK_PHYSICAL_DEVICE_TYPE_DISCRETE_GPU) { ph = ds[i]; break; } }
    }
    if (!ph) { fprintf(stderr, "no discrete Vulkan GPU found\n"); exit(1); }
    // Print the exact device banner expected by TbpGpuServer / GpuServeClient ("selected: <name> (timestampPeriod ...)")
    fprintf(stderr, "selected: %s (timestampPeriod %.1f ns)\n", pr.deviceName, pr.limits.timestampPeriod);
    tsp_ns = pr.limits.timestampPeriod;
    vkGetPhysicalDeviceMemoryProperties(ph, &mp);
    uint32_t nq = 0; vkGetPhysicalDeviceQueueFamilyProperties(ph, &nq, NULL);
    VkQueueFamilyProperties qf[16]; vkGetPhysicalDeviceQueueFamilyProperties(ph, &nq, qf);
    uint32_t qfi = 0; for (uint32_t i = 0; i < nq; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { qfi = i; break; }
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, NULL, 0, qfi, 1, &prio };
    VkPhysicalDeviceFeatures feats = { 0 }; feats.shaderInt64 = VK_TRUE; feats.shaderFloat64 = VK_TRUE;
    VkPhysicalDeviceSubgroupSizeControlFeatures sscf = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_FEATURES, NULL, VK_TRUE, VK_FALSE };
    VkPhysicalDeviceShaderAtomicInt64Features af = {
        .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_ATOMIC_INT64_FEATURES,
        .pNext = &sscf,
        .shaderBufferInt64Atomics = VK_TRUE,
        .shaderSharedInt64Atomics = VK_FALSE,
    };
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, &af, 0, 1, &qci, 0, NULL, 0, NULL, &feats };
    CK(vkCreateDevice(ph, &dci, NULL, &dev));
    vkGetDeviceQueue(dev, qfi, 0, &queue);
    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, NULL, VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT, qfi };
    CK(vkCreateCommandPool(dev, &cpci, NULL, &pool));
    VkCommandBufferAllocateInfo cai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, NULL, pool, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    CK(vkAllocateCommandBuffers(dev, &cai, &cb));
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, NULL, 0, VK_QUERY_TYPE_TIMESTAMP, 2, 0 };
    CK(vkCreateQueryPool(dev, &qpi, NULL, &qpool));
    VkFenceCreateInfo fci = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, NULL, 0 };
    CK(vkCreateFence(dev, &fci, NULL, &g_fence));
}

static void buffers_and_pipe_setup(const char *spvp, const char *tables_path, uint32_t G) {
    size_t tlen; uint8_t *traw = slurp(tables_path, &tlen);
    const uint8_t *tp = traw;
    if (rd32(&tp) != TB_MAGIC || rd32(&tp) != 180 || tlen != 8 + 180 * 8) {
        fprintf(stderr, "bad tables.bin: %s\n", tables_path); exit(1);
    }
    const VkBufferUsageFlags SB = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
    bctrl = mkbuf(8192 * 4, SB | VK_BUFFER_USAGE_TRANSFER_DST_BIT, false);
    buni = mkbuf(4096, SB, false);
    btab = mkbuf(180 * 8, SB, false); memcpy(btab.ptr, tp, 180 * 8);
    free(traw);
    bstate = mkbuf((VkDeviceSize)STATE_WORDS * 4, SB, true);
    bout = mkbuf((VkDeviceSize)OUT_WORDS * 4, SB, false);
    bdummy = mkbuf(4096, SB, true);

    VkDescriptorSetLayoutBinding bd[19];
    for (int i = 0; i < 19; i++) {
        bd[i].binding = (uint32_t)i;
        bd[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        bd[i].descriptorCount = 1;
        bd[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
        bd[i].pImmutableSamplers = NULL;
    }
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
        { bctrl.buf, 0, VK_WHOLE_SIZE },
        { buni.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { btab.buf, 0, VK_WHOLE_SIZE },
        { bstate.buf, 262144ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 0, VK_WHOLE_SIZE },
        { bout.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { bdummy.buf, 0, VK_WHOLE_SIZE },
        { bstate.buf, 188608ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 0, VK_WHOLE_SIZE },
        { bstate.buf, 32768ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 188480ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 188544ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 147456ull * 4, VK_WHOLE_SIZE },
        { bstate.buf, 262144ull * 4, VK_WHOLE_SIZE },
    };
    VkWriteDescriptorSet wr[19];
    for (int i = 0; i < 19; i++) {
        VkWriteDescriptorSet w = { VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, NULL, dset, (uint32_t)i, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, NULL, &ii_[i], NULL };
        wr[i] = w;
    }
    vkUpdateDescriptorSets(dev, 19, wr, 0, NULL);

    size_t slen; uint8_t *spv = slurp(spvp, &slen);
    VkShaderModuleCreateInfo smi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, NULL, 0, slen, (uint32_t *)spv };
    VkShaderModule sm; CK(vkCreateShaderModule(dev, &smi, NULL, &sm));
    VkComputePipelineCreateInfo cci = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, NULL, 0,
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, NULL, 0, VK_SHADER_STAGE_COMPUTE_BIT, sm, "main", NULL }, lay, VK_NULL_HANDLE, 0 };
    CK(vkCreateComputePipelines(dev, VK_NULL_HANDLE, 1, &cci, NULL, &kpipe));
    free(spv);

    // Pre-record the reusable command buffer once!
    uint32_t flags = g_profile_guideline ? 2u : 0u;
    VkCommandBufferBeginInfo bgi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, NULL, 0, NULL };
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
    CK(vkEndCommandBuffer(cb));
}

typedef struct { uint8_t *buf; size_t len, cap; } Out;
static void ow(Out *o, const void *src, size_t n) {
    if (o->len + n > o->cap) {
        o->cap = (o->len + n) * 2 + 4096;
        o->buf = realloc(o->buf, o->cap);
    }
    memcpy(o->buf + o->len, src, n);
    o->len += n;
}
static void ow32(Out *o, uint32_t v) { ow(o, &v, 4); }
static void ow64(Out *o, uint64_t v) { ow(o, &v, 8); }
static void owf64(Out *o, double v) { uint64_t b; memcpy(&b, &v, 8); ow64(o, b); }

typedef struct {
    int32_t kind, rot, x, y, srs, tspin, used_hold;
    uint32_t vord32, depth, root_id;
    double val;
} RootCand;

static double vord32_to_f64(uint32_t vord32) {
    uint32_t vbits = (vord32 & 0x80000000u) ? (vord32 & 0x7FFFFFFFu) : ~vord32;
    float f;
    memcpy(&f, &vbits, 4);
    return (double)f;
}

static int run_decision_r15(const uint32_t *dec, Out *out, double *wall_ms, double *gpu_ms) {
    double t_start = now_s();
    memcpy(buni.ptr, dec, DEC_WORDS * 4);
    uint32_t *ctrl = (uint32_t *)bctrl.ptr;
    ctrl[0] = 0; ctrl[1] = 0;

    CK(vkResetFences(dev, 1, &g_fence));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO, NULL, 0, NULL, NULL, 1, &cb, 0, NULL };
    CK(vkQueueSubmit(queue, 1, &si, g_fence));

    int fault = 0;
    for (int i = 0; i < 400000; i++) {
        uint32_t done = __atomic_load_n(&ctrl[0], __ATOMIC_ACQUIRE);
        uint32_t err = __atomic_load_n(&ctrl[1], __ATOMIC_ACQUIRE);
        if (err) { fault = 1; break; }
        if (done) break;
        if ((i & 4095) == 4095) sched_yield();
    }
    CK(vkWaitForFences(dev, 1, &g_fence, VK_TRUE, UINT64_MAX));
    if (ctrl[1]) fault = 1;

    uint64_t tq[2] = { 0, 0 };
    CK(vkGetQueryPoolResults(dev, qpool, 0, 2, sizeof tq, tq, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
    double gpu_span = (double)(tq[1] - tq[0]) * tsp_ns * 1e-6;
    double wall = (now_s() - t_start) * 1e3;
    if (wall_ms) *wall_ms = wall;
    if (gpu_ms) *gpu_ms = gpu_span;

    if (fault) {
        if (out) {
            ow32(out, 2u);
            for (int i = 0; i < 6; i++) ow32(out, 0);
            ow32(out, 0); ow64(out, 0); ow64(out, 0); ow32(out, 0);
            ow32(out, 0); ow32(out, 0);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, 0.0);
        }
        return 2;
    }

    const uint32_t *sv = (const uint32_t *)bout.ptr;
    uint32_t nc0 = sv[0];
    uint64_t nodes = sv[1];

    RootCand cands[256];
    int n_cand = 0;
    int best_i = -1;
    uint32_t best_vord = 0;
    uint32_t best_depth = 0;

    for (uint32_t c = 0; c < nc0 && c < 256u; c++) {
        const uint32_t *w = sv + 16 + c * 6;
        uint32_t w0 = w[0], w1 = w[1], w2 = w[2], w4 = w[4], w5 = w[5];
        bool is_dead = (w2 & 2u) != 0u;
        if (g_profile_guideline && is_dead) continue;
        // w4 = low 32 bits of bestPk = (depth << 16); w5 = high 32 bits = vord32
        uint32_t depth = (w4 >> 16) & 0xFFu;
        uint32_t vord32 = w5;
        if (depth == 0) continue; // No leaf or beam node survived under this root move

        RootCand *rc = &cands[n_cand];
        rc->kind = (int32_t)(w0 & 0xFFu);
        rc->rot = (int32_t)((w0 >> 8) & 3u);
        rc->srs = (int32_t)((w0 >> 16) & 7u);
        rc->tspin = (int32_t)((w0 >> 24) & 3u);
        rc->x = (int32_t)(int16_t)(w1 & 0xFFFFu);
        rc->y = (int32_t)(int16_t)(w1 >> 16);
        rc->used_hold = (int32_t)(w2 & 1u);
        rc->vord32 = vord32;
        rc->depth = depth;
        rc->root_id = c;
        rc->val = vord32_to_f64(vord32);

        if (best_i < 0 || vord32 > best_vord) {
            best_i = n_cand;
            best_vord = vord32;
            best_depth = depth;
        }
        n_cand++;
    }

    int status = (best_i >= 0) ? 0 : 1;
    if (out) {
        ow32(out, (uint32_t)status);
        if (status != 0) {
            for (int i = 0; i < 6; i++) ow32(out, 0);
            ow32(out, 0); ow64(out, 0); ow64(out, 0); ow32(out, 0);
            ow32(out, 0); ow32(out, 0);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, 0.0);
        } else {
            RootCand *fn = &cands[best_i];
            ow32(out, (uint32_t)fn->kind);
            ow32(out, (uint32_t)fn->rot);
            ow32(out, (uint32_t)fn->x);
            ow32(out, (uint32_t)fn->y);
            ow32(out, (uint32_t)fn->srs);
            ow32(out, (uint32_t)fn->tspin);
            ow32(out, (uint32_t)fn->used_hold);
            owf64(out, fn->val);
            ow64(out, nodes);
            ow32(out, best_depth);

            int idxs[256];
            for (int i = 0; i < n_cand; i++) idxs[i] = i;
            for (int i = 1; i < n_cand; i++) {
                int t = idxs[i], j = i - 1;
                while (j >= 0 && cands[idxs[j]].vord32 < cands[t].vord32) {
                    idxs[j + 1] = idxs[j];
                    j--;
                }
                idxs[j + 1] = t;
            }
            ow32(out, (uint32_t)n_cand);
            for (int i = 0; i < n_cand; i++) {
                RootCand *fm = &cands[idxs[i]];
                ow32(out, (uint32_t)fm->kind);
                ow32(out, (uint32_t)fm->rot);
                ow32(out, (uint32_t)fm->x);
                ow32(out, (uint32_t)fm->y);
                ow32(out, (uint32_t)fm->srs);
                ow32(out, (uint32_t)fm->tspin);
                ow32(out, (uint32_t)fm->used_hold);
                owf64(out, fm->val);
            }
            // Write nPlies = 0 (compact serve block: omits unused 250KB full-tree WireNode dump)
            ow32(out, 0u);
            owf64(out, wall); owf64(out, gpu_span); owf64(out, 0.0); owf64(out, wall - gpu_span);
        }
    }
    return status;
}

static uint32_t *load_decisions(const char *path, uint32_t *n_out) {
    size_t len; uint8_t *raw = slurp(path, &len);
    const uint8_t *p = raw;
    if (rd32(&p) != DC_MAGIC) { fprintf(stderr, "bad decisions magic\n"); exit(1); }
    uint32_t n = rd32(&p);
    if (len != 8 + (size_t)n * DEC_WORDS * 4) { fprintf(stderr, "decisions size mismatch\n"); exit(1); }
    uint32_t *dec = malloc((size_t)n * DEC_WORDS * 4);
    memcpy(dec, p, (size_t)n * DEC_WORDS * 4);
    free(raw);
    *n_out = n;
    return dec;
}

int main(int argc, char **argv) {
    profile_resolve();
    if (argc < 4) {
        fprintf(stderr, "usage:\n"
                        "  pfserve serve <pfl_r15_serve.spv> <tables.bin> [G=96] [device]\n"
                        "  pfserve bench <pfl_r15_serve.spv> <tables.bin> <decisions.bin> [reps=3] [G=96]\n"
                        "  pfserve run   <pfl_r15_serve.spv> <tables.bin> <decisions.bin> <out.bin> [max_dec] [G=96]\n");
        return 64;
    }
    const char *mode = argv[1];
    uint32_t G = 96u;
    const char *ge = getenv("ATTAX_GPU_G");
    if (ge && atoi(ge) > 0) G = (uint32_t)atoi(ge);

    if (!strcmp(mode, "serve")) {
        const char *spvp = argv[2];
        const char *tabp = argv[3];
        const char *want = "RX 6400";
        // Support both `pfserve serve <r15.spv> <tables.bin> [device]`
        // and drop-in `pfserve serve <mg.spv> <ex.spv> <tables.bin> [device]`
        if (argc >= 5 && strstr(argv[4], ".bin")) {
            tabp = argv[4];
            if (argc >= 6) want = argv[5];
        } else {
            if (argc >= 5) {
                int g_arg = atoi(argv[4]);
                if (g_arg > 0 && g_arg % 12 == 0) G = (uint32_t)g_arg;
                else want = argv[4];
            }
            if (argc >= 6) want = argv[5];
        }
        vk_setup(want);
        buffers_and_pipe_setup(spvp, tabp, G);
        static uint32_t dec[DEC_WORDS];
        for (;;) {
            size_t got = fread(dec, 4, DEC_WORDS, stdin);
            if (got == 0) return 0;
            if (got != DEC_WORDS) { fprintf(stderr, "pfserve: truncated decision record\n"); return 1; }
            Out out = { 0 };
            double wall, gpu;
            int st = run_decision_r15(dec, &out, &wall, &gpu);
            uint32_t hdr[2] = { (uint32_t)st, (uint32_t)out.len };
            fwrite(hdr, 4, 2, stdout);
            if (out.len) fwrite(out.buf, 1, out.len, stdout);
            fflush(stdout);
            free(out.buf);
        }
    }

    if (!strcmp(mode, "bench")) {
        const char *spvp = argv[2], *tabp = argv[3], *decp = argv[4];
        int reps = (argc >= 6) ? atoi(argv[5]) : 3;
        if (argc >= 7) G = (uint32_t)atoi(argv[6]);
        vk_setup("RX 6400");
        buffers_and_pipe_setup(spvp, tabp, G);
        uint32_t n = 0;
        uint32_t *decs = load_decisions(decp, &n);
        double *walls = malloc((size_t)n * reps * sizeof(double));
        double *gpus = malloc((size_t)n * reps * sizeof(double));
        int bad = 0;
        for (uint32_t i = 0; i < (n < 20 ? n : 20); i++) {
            double w, g;
            run_decision_r15(decs + (size_t)i * DEC_WORDS, NULL, &w, &g);
        }
        for (int r = 0; r < reps; r++) {
            for (uint32_t i = 0; i < n; i++) {
                double w, g;
                int st = run_decision_r15(decs + (size_t)i * DEC_WORDS, NULL, &w, &g);
                if (st != 0) bad++;
                walls[(size_t)r * n + i] = w;
                gpus[(size_t)r * n + i] = g;
            }
        }
        size_t total = (size_t)n * reps;
        double *sw = malloc(total * sizeof(double));
        double *sg = malloc(total * sizeof(double));
        memcpy(sw, walls, total * sizeof(double));
        memcpy(sg, gpus, total * sizeof(double));
        qsort(sw, total, sizeof(double), cmp_double);
        qsort(sg, total, sizeof(double), cmp_double);
        double sum_w = 0, sum_g = 0;
        for (size_t i = 0; i < total; i++) { sum_w += walls[i]; sum_g += gpus[i]; }
        printf("PFSERVE BENCH (G=%u, profile=%s): %u decisions x %d reps, %d non-ok\n",
               G, g_profile_guideline ? "guideline" : "s2", n, reps, bad);
        printf("  GPU span: mean %.3f ms (%.1f us), median %.3f ms (%.1f us), min %.3f ms\n",
               sum_g / total, (sum_g / total) * 1e3, sg[total / 2], sg[total / 2] * 1e3, sg[0]);
        printf("  Wall:     mean %.3f ms (%.1f us), median %.3f ms (%.1f us), p95 %.3f ms\n",
               sum_w / total, (sum_w / total) * 1e3, sw[total / 2], sw[total / 2] * 1e3,
               sw[(size_t)(total * 0.95) < total ? (size_t)(total * 0.95) : total - 1]);
        return bad ? 1 : 0;
    }

    if (!strcmp(mode, "run")) {
        const char *spvp = argv[2], *tabp = argv[3], *decp = argv[4], *outp = argv[5];
        uint32_t n = 0;
        uint32_t *decs = load_decisions(decp, &n);
        uint32_t maxd = n;
        if (argc >= 7 && atoi(argv[6]) > 0) maxd = (uint32_t)atoi(argv[6]);
        if (maxd > n) maxd = n;
        if (argc >= 8) G = (uint32_t)atoi(argv[7]);
        vk_setup("RX 6400");
        buffers_and_pipe_setup(spvp, tabp, G);
        Out out = { 0 };
        ow32(&out, RS_MAGIC);
        ow32(&out, maxd);
        int bad = 0;
        double sum_w = 0, sum_g = 0;
        for (uint32_t i = 0; i < maxd; i++) {
            double w, g;
            int st = run_decision_r15(decs + (size_t)i * DEC_WORDS, &out, &w, &g);
            if (st != 0) bad++;
            sum_w += w; sum_g += g;
        }
        FILE *f = fopen(outp, "wb");
        if (!f) { perror(outp); return 1; }
        fwrite(out.buf, 1, out.len, f);
        fclose(f);
        printf("pfserve run done: %u decisions, %d non-ok, mean wall %.3f ms (GPU %.3f ms) -> %s\n",
               maxd, bad, sum_w / maxd, sum_g / maxd, outp);
        return bad ? 1 : 0;
    }

    fprintf(stderr, "unknown mode '%s'\n", mode);
    return 64;
}
