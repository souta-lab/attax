// STAGE 3 selection-fusion harness (RX 6400, Vulkan).
// Modes:
//   bench1   <bxdump> <spvdir>  per-phase spans on representative plies
//   benchall <bxdump> <spvdir>  all 2,492 plies once, summed spans
// Modeled on the bxpg host pattern: host-visible coherent buffers,
// per-dispatch GPU timestamps (host gaps excluded).
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <vulkan/vulkan.h>

#define CK(x) do { VkResult r = (x); if (r != VK_SUCCESS) { fprintf(stderr, "vk fail %d at %s:%d\n", r, __FILE__, __LINE__); exit(1); } } while (0)
static uint32_t rd32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static uint64_t rd64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
#define FNV_PRIME 0x100000001B3ULL

static uint64_t bx_fp(const uint8_t *inst, const uint8_t *ch) {
    uint64_t hh = 0x14650FB0739D0383ULL;
    #define MIXW(v) do { hh = (hh ^ (uint64_t)(v)) * FNV_PRIME; } while (0)
    int32_t hk = (int32_t)rd32(inst + 28);
    MIXW(rd32(inst + 24));
    MIXW(hk < 0 ? 0xFFFFFFFFULL : (uint64_t)(uint32_t)hk);
    MIXW(rd32(ch + 196)); MIXW(rd32(ch + 192)); MIXW(0); MIXW(rd32(ch + 188));
    for (int i = 0; i < 40; i++) MIXW(ch[88 + i]);
    for (int i = 0; i < 40; i++) MIXW(rd32(ch + 8 + 2 * i) & 0xFFFF);
    return hh;
    #undef MIXW
}
static uint64_t ord_of(uint64_t bits) { return (bits >> 63) ? ~bits : (bits | 0x8000000000000000ULL); }

// ---------------- corpus ----------------
typedef struct { uint32_t dec, depth, n; uint64_t *fp, *ord; } Ply;
static Ply *plies; static uint32_t nplies;
static void load_corpus(const char *path) {
    int fd = open(path, O_RDONLY); if (fd < 0) { perror(path); exit(1); }
    struct stat st; fstat(fd, &st);
    uint8_t *bx = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (bx == MAP_FAILED) { perror("mmap"); exit(1); }
    if (memcmp(bx, "BXD1", 4)) { fprintf(stderr, "bad BXD1\n"); exit(1); }
    uint64_t n_inst = rd64(bx + 8);
    const uint8_t *bp = bx + 32;
    uint32_t cur_dec = 0xFFFFFFFF, cur_depth = 0xFFFFFFFF;
    Ply *cur = NULL;
    for (uint64_t ii = 0; ii < n_inst; ii++) {
        const uint8_t *inst = bp;
        uint32_t dec = rd32(inst), depth = rd32(inst + 12), nch = rd32(inst + 20);
        if (dec != cur_dec || depth != cur_depth) {
            cur_dec = dec; cur_depth = depth;
            plies = realloc(plies, (nplies + 1) * sizeof(Ply));
            cur = &plies[nplies++];
            cur->dec = dec; cur->depth = depth; cur->n = 0; cur->fp = NULL; cur->ord = NULL;
        }
        const uint8_t *ch = inst + 196;
        for (uint32_t ci = 0; ci < nch; ci++, ch += 228) {
            if (ch[201]) continue;
            cur->fp = realloc(cur->fp, (cur->n + 1) * 8);
            cur->ord = realloc(cur->ord, (cur->n + 1) * 8);
            cur->fp[cur->n] = bx_fp(inst, ch);
            cur->ord[cur->n] = ord_of(rd64(ch + 220));
            cur->n++;
        }
        bp = ch;
    }
    // drop all-dead plies (not in the dedupe input stream)
    uint32_t w = 0;
    for (uint32_t i = 0; i < nplies; i++) if (plies[i].n) plies[w++] = plies[i];
    nplies = w;
    printf("corpus: %u plies\n", nplies);
}

// CPU expectation: representative set (sorted child indices)
typedef struct { uint64_t fp, ord; uint32_t idx; } CEnt;
static int cmp_cent(const void *a, const void *b) {
    const CEnt *x = a, *y = b;
    if (x->fp != y->fp) return x->fp < y->fp ? -1 : 1;
    if (x->ord != y->ord) return x->ord > y->ord ? -1 : 1; // ord desc
    return x->idx < y->idx ? -1 : (x->idx > y->idx);
}
static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : (x > y); }
static uint32_t cpu_reps(Ply *p, uint32_t *out) {
    CEnt *v = malloc(p->n * sizeof(CEnt));
    for (uint32_t i = 0; i < p->n; i++) { v[i].fp = p->fp[i]; v[i].ord = p->ord[i]; v[i].idx = i; }
    qsort(v, p->n, sizeof(CEnt), cmp_cent);
    uint32_t m = 0;
    for (uint32_t i = 0; i < p->n; i++) if (i == 0 || v[i].fp != v[i - 1].fp) out[m++] = v[i].idx;
    free(v);
    qsort(out, m, 4, cmp_u32);
    return m;
}

// ---------------- vulkan ----------------
static VkInstance g_inst; static VkPhysicalDevice g_pd; static VkDevice g_dev;
static VkQueue g_q; static uint32_t g_qf;
static VkCommandPool g_pool;
static double g_ts_period; // ns per tick

typedef struct { VkBuffer buf; VkDeviceMemory mem; void *ptr; VkDeviceSize size; } Buf;
static Buf mkbuf_props(VkDeviceSize size, VkBufferUsageFlags use, VkMemoryPropertyFlags want) {
    Buf b; b.size = size; b.ptr = NULL;
    VkBufferCreateInfo bi = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
    bi.size = size; bi.usage = use; bi.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    CK(vkCreateBuffer(g_dev, &bi, NULL, &b.buf));
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(g_dev, b.buf, &mr);
    VkPhysicalDeviceMemoryProperties mp; vkGetPhysicalDeviceMemoryProperties(g_pd, &mp);
    uint32_t type = 0xFFFFFFFF;
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((mr.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) { type = i; break; }
    if (type == 0xFFFFFFFF && (want & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) {
        want &= ~(VkMemoryPropertyFlags)VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT; // fall back to plain host-visible
        for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
            if ((mr.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) { type = i; break; }
    }
    if (type == 0xFFFFFFFF) { fprintf(stderr, "no memory type for props 0x%x\n", want); exit(1); }
    static int printed = 0;
    if (!printed) { printed = 1; fprintf(stderr, "mkbuf: memtype %u flags 0x%x heap %u\n", type, mp.memoryTypes[type].propertyFlags, mp.memoryTypes[type].heapIndex); }
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };
    ai.allocationSize = mr.size; ai.memoryTypeIndex = type;
    CK(vkAllocateMemory(g_dev, &ai, NULL, &b.mem));
    CK(vkBindBufferMemory(g_dev, b.buf, b.mem, 0));
    if (want & VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT) CK(vkMapMemory(g_dev, b.mem, 0, size, 0, &b.ptr));
    return b;
}
static Buf mkbuf(VkDeviceSize size, VkBufferUsageFlags use) {
    // Prefer the BAR heap (DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT):
    // plain host-visible memory on this stack is uncached sysmem over
    // PCIe, where scattered GPU reads cost ~20 us per tiny dispatch.
    return mkbuf_props(size, use, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT | VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
}
static Buf mkbuf_local(VkDeviceSize size, VkBufferUsageFlags use) {
    return mkbuf_props(size, use, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
}

static void vk_init(void) {
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO };
    app.apiVersion = VK_API_VERSION_1_2;
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO };
    ici.pApplicationInfo = &app;
    CK(vkCreateInstance(&ici, NULL, &g_inst));
    uint32_t ndev = 0; CK(vkEnumeratePhysicalDevices(g_inst, &ndev, NULL));
    VkPhysicalDevice *devs = malloc(ndev * sizeof(VkPhysicalDevice));
    CK(vkEnumeratePhysicalDevices(g_inst, &ndev, devs));
    g_pd = devs[0];
    for (uint32_t i = 0; i < ndev; i++) {
        VkPhysicalDeviceProperties pr; vkGetPhysicalDeviceProperties(devs[i], &pr);
        printf("device: %s\n", pr.deviceName);
        if (strstr(pr.deviceName, "6400")) g_pd = devs[i];
    }
    VkPhysicalDeviceProperties pr; vkGetPhysicalDeviceProperties(g_pd, &pr);
    printf("using: %s (tsPeriod %.3f ns)\n", pr.deviceName, pr.limits.timestampPeriod);
    g_ts_period = pr.limits.timestampPeriod;
    {
        VkPhysicalDeviceMemoryProperties mp; vkGetPhysicalDeviceMemoryProperties(g_pd, &mp);
        for (uint32_t i = 0; i < mp.memoryHeapCount; i++)
            printf("heap %u: %llu MB flags 0x%x\n", i, (unsigned long long)(mp.memoryHeaps[i].size >> 20), mp.memoryHeaps[i].flags);
        for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
            printf("memtype %u: props 0x%x heap %u\n", i, mp.memoryTypes[i].propertyFlags, mp.memoryTypes[i].heapIndex);
    }
    uint32_t nqf = 0; vkGetPhysicalDeviceQueueFamilyProperties(g_pd, &nqf, NULL);
    VkQueueFamilyProperties *qfs = malloc(nqf * sizeof(VkQueueFamilyProperties));
    vkGetPhysicalDeviceQueueFamilyProperties(g_pd, &nqf, qfs);
    g_qf = 0xFFFFFFFF;
    for (uint32_t i = 0; i < nqf; i++) if (qfs[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { g_qf = i; break; }
    // int64 atomics support
    VkPhysicalDeviceShaderAtomicInt64Features af = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_ATOMIC_INT64_FEATURES };
    VkPhysicalDeviceFeatures2 f2 = { VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
    f2.pNext = &af;
    vkGetPhysicalDeviceFeatures2(g_pd, &f2);
    printf("shaderBufferInt64Atomics: %d, shaderSharedInt64Atomics: %d\n", af.shaderBufferInt64Atomics, af.shaderSharedInt64Atomics);
    if (!af.shaderBufferInt64Atomics) { fprintf(stderr, "FATAL: no int64 buffer atomics\n"); exit(1); }
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO };
    qci.queueFamilyIndex = g_qf; qci.queueCount = 1; qci.pQueuePriorities = &prio;
    VkPhysicalDeviceFeatures df = { 0 };
    df.shaderInt64 = VK_TRUE;
    df.shaderFloat64 = VK_TRUE; // BX bound/eval kernels are f64
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO };
    dci.queueCreateInfoCount = 1; dci.pQueueCreateInfos = &qci;
    dci.pEnabledFeatures = &df; dci.pNext = &af;
    CK(vkCreateDevice(g_pd, &dci, NULL, &g_dev));
    vkGetDeviceQueue(g_dev, g_qf, 0, &g_q);
    VkCommandPoolCreateInfo cpi = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
    cpi.queueFamilyIndex = g_qf; cpi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    CK(vkCreateCommandPool(g_dev, &cpi, NULL, &g_pool));
}

static uint8_t *read_file(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb"); if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END); *len = (size_t)ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(*len); if (fread(b, 1, *len, f) != *len) { fprintf(stderr, "short read %s\n", path); exit(1); }
    fclose(f); return b;
}

static VkPipeline mkpipe(const char *spvpath, VkPipelineLayout layout) {
    size_t len; uint8_t *code = read_file(spvpath, &len);
    VkShaderModuleCreateInfo smi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO };
    smi.codeSize = len; smi.pCode = (const uint32_t *)code;
    VkShaderModule sm; CK(vkCreateShaderModule(g_dev, &smi, NULL, &sm));
    VkComputePipelineCreateInfo cpi = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO };
    cpi.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    cpi.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; cpi.stage.module = sm; cpi.stage.pName = "main";
    cpi.layout = layout;
    VkPipeline p; CK(vkCreateComputePipelines(g_dev, VK_NULL_HANDLE, 1, &cpi, NULL, &p));
    vkDestroyShaderModule(g_dev, sm, NULL); free(code);
    return p;
}

// ---------------- dedupe bench (sustained-load form) ----------------
// Cold/idle-clock submits measure wake artifacts (~100+ us per tiny
// dispatch at sclk 500 MHz), so all measurement happens inside large
// command buffers with warm-up sequences, and an sclk sampler thread
// records the clock actually seen during the run.
#include <pthread.h>
#include <unistd.h>
#define MAXN 8192
#define MAXT 32768
#define BATCH 64
static Buf b_fpin, b_ordin, b_tabfp, b_tabord, b_tabmeta, b_reps, b_cnt, b_read;
static VkDescriptorSetLayout g_dsl; static VkPipelineLayout g_layout;
static VkDescriptorSet g_dset;
static VkPipeline g_pipe[4];
static VkQueryPool g_qpool;
static VkCommandBuffer g_cmd;

static volatile int g_sample_run = 1;
static int g_sclk_max = 0, g_sclk_last = 0;
static void *sclk_thread(void *arg) {
    (void)arg;
    // find the AMD card's pp_dpm_sclk (the one listing a 2320 level)
    char path[256] = { 0 };
    for (int c = 0; c < 4 && !path[0]; c++) {
        char cand[256]; snprintf(cand, sizeof cand, "/sys/class/drm/card%d/device/pp_dpm_sclk", c);
        FILE *f = fopen(cand, "r"); if (!f) continue;
        char line[128]; int has = 0;
        while (fgets(line, sizeof line, f)) if (strstr(line, "2320")) has = 1;
        fclose(f);
        if (has) snprintf(path, sizeof path, "%s", cand);
    }
    if (!path[0]) return NULL;
    while (g_sample_run) {
        FILE *f = fopen(path, "r"); if (!f) break;
        char line[128];
        while (fgets(line, sizeof line, f)) {
            char *star = strchr(line, '*');
            if (star) { int mhz = atoi(line + strcspn(line, " ")); (void)mhz;
                        int v = 0; sscanf(line, "%*d: %dMhz", &v);
                        if (v) { g_sclk_last = v; if (v > g_sclk_max) g_sclk_max = v; } }
        }
        fclose(f);
        usleep(5000);
    }
    return NULL;
}

static void dedupe_setup(const char *spvdir) {
    b_fpin = mkbuf((VkDeviceSize)BATCH * MAXN * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    b_ordin = mkbuf((VkDeviceSize)BATCH * MAXN * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    // tables / reps / counters are DEVICE_LOCAL: scattered 64-bit atomics
    // into host-visible (PCIe) memory cost ~100 us per tiny dispatch.
    b_tabfp = mkbuf_local(MAXT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    b_tabord = mkbuf_local(MAXT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    b_tabmeta = mkbuf_local(MAXT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    b_reps = mkbuf_local((VkDeviceSize)BATCH * MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    b_cnt = mkbuf_local(BATCH * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    b_read = mkbuf(BATCH * 4 + (VkDeviceSize)MAXN * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    VkDescriptorSetLayoutBinding binds[7];
    for (int i = 0; i < 7; i++) {
        binds[i].binding = i; binds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        binds[i].descriptorCount = 1; binds[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; binds[i].pImmutableSamplers = NULL;
    }
    VkDescriptorSetLayoutCreateInfo dli = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
    dli.bindingCount = 7; dli.pBindings = binds;
    CK(vkCreateDescriptorSetLayout(g_dev, &dli, NULL, &g_dsl));
    VkPushConstantRange pcr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 20 };
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
    pli.setLayoutCount = 1; pli.pSetLayouts = &g_dsl; pli.pushConstantRangeCount = 1; pli.pPushConstantRanges = &pcr;
    CK(vkCreatePipelineLayout(g_dev, &pli, NULL, &g_layout));
    VkDescriptorPoolSize dps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 7 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO };
    dpi.maxSets = 1; dpi.poolSizeCount = 1; dpi.pPoolSizes = &dps;
    VkDescriptorPool dpool; CK(vkCreateDescriptorPool(g_dev, &dpi, NULL, &dpool));
    VkDescriptorSetAllocateInfo dai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO };
    dai.descriptorPool = dpool; dai.descriptorSetCount = 1; dai.pSetLayouts = &g_dsl;
    CK(vkAllocateDescriptorSets(g_dev, &dai, &g_dset));
    Buf *bufs[7] = { &b_fpin, &b_ordin, &b_tabfp, &b_tabord, &b_tabmeta, &b_reps, &b_cnt };
    VkWriteDescriptorSet wr[7]; VkDescriptorBufferInfo infos[7];
    for (int i = 0; i < 7; i++) {
        infos[i].buffer = bufs[i]->buf; infos[i].offset = 0; infos[i].range = VK_WHOLE_SIZE;
        wr[i] = (VkWriteDescriptorSet){ VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET };
        wr[i].dstSet = g_dset; wr[i].dstBinding = i; wr[i].descriptorCount = 1;
        wr[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; wr[i].pBufferInfo = &infos[i];
    }
    vkUpdateDescriptorSets(g_dev, 7, wr, 0, NULL);
    char path[512];
    for (int ph = 0; ph < 4; ph++) {
        snprintf(path, sizeof path, "%s/dedup_ph%d.spv", spvdir, ph + 1);
        g_pipe[ph] = mkpipe(path, g_layout);
    }
    VkQueryPoolCreateInfo qpi = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO };
    qpi.queryType = VK_QUERY_TYPE_TIMESTAMP; qpi.queryCount = 8192;
    CK(vkCreateQueryPool(g_dev, &qpi, NULL, &g_qpool));
    VkCommandBufferAllocateInfo cai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO };
    cai.commandPool = g_pool; cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cai.commandBufferCount = 1;
    CK(vkAllocateCommandBuffers(g_dev, &cai, &g_cmd));
}

static int g_nobarrier = -1;
static void barrier_all(VkCommandBuffer cmd) {
    if (g_nobarrier < 0) g_nobarrier = getenv("SELG_NOBARRIER") ? 1 : 0;
    if (g_nobarrier) return;
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER };
    mb.srcAccessMask = VK_ACCESS_MEMORY_WRITE_BIT; mb.dstAccessMask = VK_ACCESS_MEMORY_READ_BIT | VK_ACCESS_MEMORY_WRITE_BIT;
    if (getenv("SELG_NARROWBAR")) {
        vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0, NULL);
    } else {
        vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &mb, 0, NULL, 0, NULL);
    }
}

static void record_fills(VkCommandBuffer cmd, uint32_t slot, uint32_t T) {
    vkCmdFillBuffer(cmd, b_tabfp.buf, 0, T * 8, 0xFFFFFFFFu);
    vkCmdFillBuffer(cmd, b_tabord.buf, 0, T * 8, 0);
    vkCmdFillBuffer(cmd, b_tabmeta.buf, 0, T * 8, 0xFFFFFFFFu);
    vkCmdFillBuffer(cmd, b_cnt.buf, slot * 4, 4, 0);
}

// Append one (fill + 4 phases) sequence for ply p staged at the given
// slot. Uses 6 timestamps starting at *tq.
static void record_seq(VkCommandBuffer cmd, uint32_t slot, Ply *p, uint32_t T, int *tq) {
    barrier_all(cmd); // previous sequence's compute must finish before the fills
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, g_qpool, (*tq)++);
    record_fills(cmd, slot, T);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, g_qpool, (*tq)++);
    barrier_all(cmd);
    uint32_t pc[5] = { p->n, T - 1, slot * MAXN, slot * MAXN, slot };
    for (int ph = 0; ph < 4; ph++) {
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_pipe[ph]);
        vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_layout, 0, 1, &g_dset, 0, NULL);
        vkCmdPushConstants(cmd, g_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 20, pc);
        vkCmdDispatch(cmd, (p->n + 255) / 256, 1, 1);
        vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_qpool, (*tq)++);
        if (ph < 3) barrier_all(cmd);
    }
}

// copy counters (all slots) and one reps region into the host readback buf
static void record_readback(VkCommandBuffer cmd, uint32_t reps_slot) {
    barrier_all(cmd);
    VkBufferCopy c1 = { 0, 0, BATCH * 4 };
    vkCmdCopyBuffer(cmd, b_cnt.buf, b_read.buf, 1, &c1);
    VkBufferCopy c2 = { (VkDeviceSize)reps_slot * MAXN * 4, BATCH * 4, (VkDeviceSize)MAXN * 4 };
    vkCmdCopyBuffer(cmd, b_reps.buf, b_read.buf, 1, &c2);
}

static void stage_ply(uint32_t slot, Ply *p) {
    memcpy((uint64_t *)b_fpin.ptr + (size_t)slot * MAXN, p->fp, p->n * 8);
    memcpy((uint64_t *)b_ordin.ptr + (size_t)slot * MAXN, p->ord, p->n * 8);
}

static void submit_cmd(void) {
    CK(vkEndCommandBuffer(g_cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO };
    si.commandBufferCount = 1; si.pCommandBuffers = &g_cmd;
    CK(vkQueueSubmit(g_q, 1, &si, VK_NULL_HANDLE));
    CK(vkQueueWaitIdle(g_q));
}
static void begin_cmd(void) {
    CK(vkResetCommandBuffer(g_cmd, 0));
    VkCommandBufferBeginInfo cbbi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    CK(vkBeginCommandBuffer(g_cmd, &cbbi));
    vkCmdResetQueryPool(g_cmd, g_qpool, 0, 8192);
}
static void read_ts(int n, uint64_t *ts) {
    CK(vkGetQueryPoolResults(g_dev, g_qpool, 0, n, (size_t)n * 8, ts, 8, VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT));
}

// sustained dummy load to raise clocks before measuring
static void warmup(void) {
    Ply big = { 0, 0, MAXN, malloc(MAXN * 8), malloc(MAXN * 8) };
    uint64_t s = 0x9E3779B97F4A7C15ULL;
    for (uint32_t i = 0; i < MAXN; i++) {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        big.fp[i] = s ^ (s >> 33); big.ord[i] = ord_of(0x3FF0000000000000ULL + i);
    }
    for (uint32_t slot = 0; slot < BATCH; slot++) stage_ply(slot, &big);
    begin_cmd();
    int tq = 0;
    uint32_t seqs = 40; const char *e = getenv("SELG_WARM_SEQS"); if (e) seqs = (uint32_t)atoi(e);
    for (uint32_t r = 0; r < seqs; r++) record_seq(g_cmd, r % BATCH, &big, 32768, &tq);
    submit_cmd();
    free(big.fp); free(big.ord);
}

static int cmp_dbl(const void *a, const void *b) { double x = *(const double *)a, y = *(const double *)b; return x < y ? -1 : (x > y); }
static int cmp_ply_n(const void *a, const void *b) { return (int)((const Ply *)a)->n - (int)((const Ply *)b)->n; }

static void bench1(void) {
    warmup();
    Ply *sorted = malloc(nplies * sizeof(Ply)); memcpy(sorted, plies, nplies * sizeof(Ply));
    qsort(sorted, nplies, sizeof(Ply), cmp_ply_n);
    Ply *pick[3] = { &sorted[nplies / 2], &sorted[(nplies * 9) / 10], &sorted[nplies - 1] };
    const char *names[3] = { "median", "p90", "max" };
    uint32_t *exp = malloc(MAXN * 4), *got = malloc(MAXN * 4);
    enum { R = 15 };
    for (int pi = 0; pi < 3; pi++) {
        Ply *p = pick[pi];
        uint32_t nexp = cpu_reps(p, exp);
        for (uint32_t slot = 0; slot < BATCH; slot++) stage_ply(slot, p);
        for (uint32_t T = 8192; T <= 32768; T *= 2) {
            if (T <= p->n) continue;
            begin_cmd();
            int tq = 0;
            for (int r = 0; r < R; r++) record_seq(g_cmd, (uint32_t)r, p, T, &tq);
            record_readback(g_cmd, R - 1);
            submit_cmd();
            uint64_t *ts = malloc((size_t)tq * 8); read_ts(tq, ts);
            // verify last rep's set
            uint32_t ngot = ((uint32_t *)b_read.ptr)[R - 1];
            int lax = getenv("SELG_NOBARRIER") != NULL;
            if (ngot != nexp) { printf("FAIL %s T=%u: rep count gpu=%u cpu=%u\n", names[pi], T, ngot, nexp); if (!lax) exit(1); }
            if (ngot <= MAXN) { memcpy(got, (uint32_t *)((uint8_t *)b_read.ptr + BATCH * 4), ngot * 4);
            qsort(got, ngot, 4, cmp_u32);
            if (ngot == nexp && memcmp(got, exp, ngot * 4)) { printf("FAIL %s T=%u: rep set differs\n", names[pi], T); if (!lax) exit(1); } }
            double med[5], tot = 0;
            for (int sgm = 0; sgm < 5; sgm++) {
                double col[R];
                for (int r = 0; r < R; r++) col[r] = (double)(ts[r * 6 + sgm + 1] - ts[r * 6 + sgm]) * g_ts_period / 1000.0;
                qsort(col, R, sizeof(double), cmp_dbl); med[sgm] = col[R / 2]; tot += med[sgm];
            }
            printf("ply %s (dec=%u depth=%u n=%u distinct=%u) T=%u: fill %.2f insert %.2f argmaxU %.2f argmaxGen %.2f emit %.2f | total %.2f us\n",
                   names[pi], p->dec, p->depth, p->n, nexp, T, med[0], med[1], med[2], med[3], med[4], tot);
            free(ts);
        }
    }
    printf("BENCH1 OK (rep sets verified; sclk max %d MHz, last %d MHz)\n", g_sclk_max, g_sclk_last);
}

static void benchall(void) {
    warmup();
    uint32_t T = 16384;
    uint32_t *exp_cnt = malloc(nplies * 4);
    uint32_t *exp = malloc(MAXN * 4);
    for (uint32_t i = 0; i < nplies; i++) exp_cnt[i] = cpu_reps(&plies[i], exp);
    for (int pass = 0; pass < 3; pass++) {
        double tot[5] = { 0 }, worst = 0; uint32_t worst_n = 0;
        for (uint32_t base = 0; base < nplies; base += BATCH) {
            uint32_t chunk = nplies - base < BATCH ? nplies - base : BATCH;
            for (uint32_t s = 0; s < chunk; s++) stage_ply(s, &plies[base + s]);
            begin_cmd();
            int tq = 0;
            for (uint32_t s = 0; s < chunk; s++) record_seq(g_cmd, s, &plies[base + s], T, &tq);
            record_readback(g_cmd, 0);
            submit_cmd();
            uint64_t *ts = malloc((size_t)tq * 8); read_ts(tq, ts);
            for (uint32_t s = 0; s < chunk; s++) {
                uint32_t ngot = ((uint32_t *)b_read.ptr)[s];
                if (ngot != exp_cnt[base + s]) { printf("FAIL pass%d ply dec=%u depth=%u: gpu reps=%u cpu=%u\n", pass, plies[base + s].dec, plies[base + s].depth, ngot, exp_cnt[base + s]); exit(1); }
                double sum = 0;
                for (int k = 0; k < 5; k++) { double v = (double)(ts[s * 6 + k + 1] - ts[s * 6 + k]) * g_ts_period / 1000.0; tot[k] += v; sum += v; }
                if (sum > worst) { worst = sum; worst_n = plies[base + s].n; }
            }
            free(ts);
        }
        double all = 0; for (int k = 0; k < 5; k++) all += tot[k];
        printf("BENCHALL pass%d T=%u: fill %.1f insert %.1f argmaxU %.1f argmaxGen %.1f emit %.1f us total | per-decision %.2f us | per-ply mean %.3f | worst ply %.2f (n=%u) | sclk max %d last %d\n",
               pass, T, tot[0], tot[1], tot[2], tot[3], tot[4], all / 180.0, all / nplies, worst, worst_n, g_sclk_max, g_sclk_last);
    }
    printf("BENCHALL OK (all rep counts verified x3 passes)\n");
}

static VkPipeline g_micro[4];
static void micro_bench(const char *spvdir, int variant) {
    char path[512];
    for (int v = 0; v < 4; v++) {
        snprintf(path, sizeof path, "%s/micro_v%d.spv", spvdir, v);
        g_micro[v] = mkpipe(path, g_layout);
    }
    warmup();
    Ply *sorted = malloc(nplies * sizeof(Ply)); memcpy(sorted, plies, nplies * sizeof(Ply));
    qsort(sorted, nplies, sizeof(Ply), cmp_ply_n);
    Ply *p = &sorted[nplies / 2]; // median ply
    uint32_t T = 16384;
    for (uint32_t slot = 0; slot < BATCH; slot++) stage_ply(slot, p);
    enum { R = 15 };
    begin_cmd();
    int tq = 0;
    uint32_t pc[5] = { p->n, T - 1, 0, 0, 0 };
    for (int r = 0; r < R; r++) {
        pc[2] = (uint32_t)r * MAXN; pc[3] = (uint32_t)r * MAXN; pc[4] = (uint32_t)r;
        barrier_all(g_cmd);
        vkCmdWriteTimestamp(g_cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, g_qpool, tq++);
        record_fills(g_cmd, (uint32_t)r, T);
        vkCmdWriteTimestamp(g_cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, g_qpool, tq++);
        barrier_all(g_cmd);
        // real insert (phase 1) so the table holds the fingerprints
        vkCmdBindPipeline(g_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_pipe[0]);
        vkCmdBindDescriptorSets(g_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_layout, 0, 1, &g_dset, 0, NULL);
        vkCmdPushConstants(g_cmd, g_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 20, pc);
        vkCmdDispatch(g_cmd, (p->n + 255) / 256, 1, 1);
        vkCmdWriteTimestamp(g_cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_qpool, tq++);
        for (int k = 0; k < 3; k++) {
            barrier_all(g_cmd);
            vkCmdBindPipeline(g_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_micro[variant]);
            vkCmdBindDescriptorSets(g_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, g_layout, 0, 1, &g_dset, 0, NULL);
            vkCmdPushConstants(g_cmd, g_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 20, pc);
            vkCmdDispatch(g_cmd, (p->n + 255) / 256, 1, 1);
            vkCmdWriteTimestamp(g_cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_qpool, tq++);
        }
    }
    submit_cmd();
    uint64_t *ts = malloc((size_t)tq * 8); read_ts(tq, ts);
    double med[5];
    for (int sgm = 0; sgm < 5; sgm++) {
        double col[R];
        for (int r = 0; r < R; r++) col[r] = (double)(ts[r * 6 + sgm + 1] - ts[r * 6 + sgm]) * g_ts_period / 1000.0;
        qsort(col, R, sizeof(double), cmp_dbl); med[sgm] = col[R / 2];
    }
    printf("micro v%d (median ply n=%u T=%u): fill %.2f insert %.2f variant %.2f / %.2f / %.2f us | sclk max %d last %d\n",
           variant, p->n, T, med[0], med[1], med[2], med[3], med[4], g_sclk_max, g_sclk_last);
    free(ts);
}

// ---------------- fused dedupe (production form) ----------------
#define FCHUNK 64
#define FT 16384
static Buf f_tabfp, f_tabord, f_tabmeta, f_reps, f_cnt, f_prm, f_read;
static VkDescriptorSetLayout f_dsl; static VkPipelineLayout f_layout;
static VkDescriptorSet f_dset; static VkPipeline f_pipe;

static void fused_setup(const char *spvdir) {
    f_tabfp = mkbuf_local((VkDeviceSize)FCHUNK * FT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    f_tabord = mkbuf_local((VkDeviceSize)FCHUNK * FT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    f_tabmeta = mkbuf_local((VkDeviceSize)FCHUNK * FT * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    f_reps = mkbuf_local((VkDeviceSize)FCHUNK * MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    f_cnt = mkbuf_local(FCHUNK * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    f_prm = mkbuf(FCHUNK * 5 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    f_read = mkbuf(FCHUNK * 4 + (VkDeviceSize)FCHUNK * MAXN * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    VkDescriptorSetLayoutBinding binds[8];
    for (int i = 0; i < 8; i++) {
        binds[i].binding = i; binds[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        binds[i].descriptorCount = 1; binds[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT; binds[i].pImmutableSamplers = NULL;
    }
    VkDescriptorSetLayoutCreateInfo dli = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
    dli.bindingCount = 8; dli.pBindings = binds;
    CK(vkCreateDescriptorSetLayout(g_dev, &dli, NULL, &f_dsl));
    VkPushConstantRange pcr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, 4 };
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
    pli.setLayoutCount = 1; pli.pSetLayouts = &f_dsl; pli.pushConstantRangeCount = 1; pli.pPushConstantRanges = &pcr;
    CK(vkCreatePipelineLayout(g_dev, &pli, NULL, &f_layout));
    VkDescriptorPoolSize dps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 8 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO };
    dpi.maxSets = 1; dpi.poolSizeCount = 1; dpi.pPoolSizes = &dps;
    VkDescriptorPool dpool; CK(vkCreateDescriptorPool(g_dev, &dpi, NULL, &dpool));
    VkDescriptorSetAllocateInfo dai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO };
    dai.descriptorPool = dpool; dai.descriptorSetCount = 1; dai.pSetLayouts = &f_dsl;
    CK(vkAllocateDescriptorSets(g_dev, &dai, &f_dset));
    Buf *bufs[8] = { &b_fpin, &b_ordin, &f_tabfp, &f_tabord, &f_tabmeta, &f_reps, &f_cnt, &f_prm };
    VkWriteDescriptorSet wr[8]; VkDescriptorBufferInfo infos[8];
    for (int i = 0; i < 8; i++) {
        infos[i].buffer = bufs[i]->buf; infos[i].offset = 0; infos[i].range = VK_WHOLE_SIZE;
        wr[i] = (VkWriteDescriptorSet){ VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET };
        wr[i].dstSet = f_dset; wr[i].dstBinding = i; wr[i].descriptorCount = 1;
        wr[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; wr[i].pBufferInfo = &infos[i];
    }
    vkUpdateDescriptorSets(g_dev, 8, wr, 0, NULL);
    char path[512];
    snprintf(path, sizeof path, "%s/dedup_fused.spv", spvdir);
    f_pipe = mkpipe(path, f_layout);
}

// fills + one fused dispatch for `chunk` plies whose params/inputs are
// staged; ts pair appended at *tq (fill span, dispatch span).
static void record_fused(VkCommandBuffer cmd, uint32_t chunk, int *tq) {
    barrier_all(cmd);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, g_qpool, (*tq)++);
    vkCmdFillBuffer(cmd, f_tabfp.buf, 0, (VkDeviceSize)chunk * FT * 8, 0xFFFFFFFFu);
    vkCmdFillBuffer(cmd, f_tabord.buf, 0, (VkDeviceSize)chunk * FT * 8, 0);
    vkCmdFillBuffer(cmd, f_tabmeta.buf, 0, (VkDeviceSize)chunk * FT * 8, 0xFFFFFFFFu);
    vkCmdFillBuffer(cmd, f_cnt.buf, 0, chunk * 4, 0);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, g_qpool, (*tq)++);
    barrier_all(cmd);
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, f_pipe);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, f_layout, 0, 1, &f_dset, 0, NULL);
    uint32_t mask = FT - 1;
    vkCmdPushConstants(cmd, f_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &mask);
    vkCmdDispatch(cmd, chunk, 1, 1);
    vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, g_qpool, (*tq)++);
}

static void fused_readback(VkCommandBuffer cmd, uint32_t chunk) {
    barrier_all(cmd);
    VkBufferCopy c1 = { 0, 0, chunk * 4 };
    vkCmdCopyBuffer(cmd, f_cnt.buf, f_read.buf, 1, &c1);
    VkBufferCopy c2 = { 0, FCHUNK * 4, (VkDeviceSize)chunk * MAXN * 4 };
    vkCmdCopyBuffer(cmd, f_reps.buf, f_read.buf, 1, &c2);
}

static void set_prm(uint32_t slot, uint32_t n, uint32_t childBase) {
    uint32_t *w = (uint32_t *)f_prm.ptr + slot * 5;
    w[0] = n; w[1] = childBase; w[2] = slot * FT; w[3] = slot * MAXN; w[4] = slot;
}

static void fused1(void) {
    warmup();
    Ply *sorted = malloc(nplies * sizeof(Ply)); memcpy(sorted, plies, nplies * sizeof(Ply));
    qsort(sorted, nplies, sizeof(Ply), cmp_ply_n);
    Ply *pick[3] = { &sorted[nplies / 2], &sorted[(nplies * 9) / 10], &sorted[nplies - 1] };
    const char *names[3] = { "median", "p90", "max" };
    uint32_t *exp = malloc(MAXN * 4), *got = malloc(MAXN * 4);
    uint64_t ts[8192];
    for (int pi = 0; pi < 3; pi++) {
        Ply *p = pick[pi];
        uint32_t nexp = cpu_reps(p, exp);
        for (uint32_t s = 0; s < FCHUNK; s++) { stage_ply(s, p); set_prm(s, p->n, s * MAXN); }
        // throughput form: 64 copies in one dispatch, x5
        double spans[5];
        begin_cmd();
        int tq = 0;
        for (int r = 0; r < 5; r++) record_fused(g_cmd, FCHUNK, &tq);
        fused_readback(g_cmd, FCHUNK);
        submit_cmd();
        read_ts(tq, ts);
        for (int r = 0; r < 5; r++) spans[r] = (double)(ts[r * 3 + 2] - ts[r * 3 + 1]) * g_ts_period / 1000.0;
        qsort(spans, 5, sizeof(double), cmp_dbl);
        uint32_t ngot = ((uint32_t *)f_read.ptr)[0];
        if (ngot != nexp) { printf("FAIL fused1 %s: count gpu=%u cpu=%u\n", names[pi], ngot, nexp); exit(1); }
        memcpy(got, (uint32_t *)((uint8_t *)f_read.ptr + FCHUNK * 4), ngot * 4);
        qsort(got, ngot, 4, cmp_u32);
        if (memcmp(got, exp, ngot * 4)) { printf("FAIL fused1 %s: set differs\n", names[pi]); exit(1); }
        printf("fused %s (n=%u distinct=%u): dispatch median %.2f us for 64 plies -> %.3f us/ply (throughput)\n",
               names[pi], p->n, nexp, spans[2], spans[2] / FCHUNK);
        // latency form: single WG, x15 sequential in one cmdbuf
        begin_cmd();
        tq = 0;
        for (int r = 0; r < 15; r++) record_fused(g_cmd, 1, &tq);
        submit_cmd();
        read_ts(tq, ts);
        double lat[15];
        for (int r = 0; r < 15; r++) lat[r] = (double)(ts[r * 3 + 2] - ts[r * 3 + 1]) * g_ts_period / 1000.0;
        qsort(lat, 15, sizeof(double), cmp_dbl);
        printf("fused %s: single-WG dispatch median %.2f us (latency form)\n", names[pi], lat[7]);
    }
    printf("FUSED1 OK (sets verified; sclk max %d last %d)\n", g_sclk_max, g_sclk_last);
}

static void fusedall(void) {
    warmup();
    uint32_t *exp = malloc(MAXN * 4), *got = malloc(MAXN * 4);
    uint64_t *ts = malloc(8192 * 8);
    for (int pass = 0; pass < 3; pass++) {
        double tot_fill = 0, tot_disp = 0, worst = 0;
        for (uint32_t base = 0; base < nplies; base += FCHUNK) {
            uint32_t chunk = nplies - base < FCHUNK ? nplies - base : FCHUNK;
            for (uint32_t s = 0; s < chunk; s++) { stage_ply(s, &plies[base + s]); set_prm(s, plies[base + s].n, s * MAXN); }
            begin_cmd();
            int tq = 0;
            record_fused(g_cmd, chunk, &tq);
            fused_readback(g_cmd, chunk);
            submit_cmd();
            read_ts(tq, ts);
            tot_fill += (double)(ts[1] - ts[0]) * g_ts_period / 1000.0;
            double disp = (double)(ts[2] - ts[1]) * g_ts_period / 1000.0;
            tot_disp += disp;
            if (disp / chunk > worst) worst = disp / chunk;
            for (uint32_t s = 0; s < chunk; s++) {
                Ply *p = &plies[base + s];
                uint32_t nexp = cpu_reps(p, exp);
                uint32_t ngot = ((uint32_t *)f_read.ptr)[s];
                if (ngot != nexp) { printf("FAIL fusedall pass%d dec=%u depth=%u: count gpu=%u cpu=%u\n", pass, p->dec, p->depth, ngot, nexp); exit(1); }
                memcpy(got, (uint32_t *)((uint8_t *)f_read.ptr + FCHUNK * 4) + (size_t)s * MAXN, ngot * 4);
                qsort(got, ngot, 4, cmp_u32);
                if (memcmp(got, exp, ngot * 4)) { printf("FAIL fusedall pass%d dec=%u depth=%u: set differs\n", pass, p->dec, p->depth); exit(1); }
            }
        }
        printf("FUSEDALL pass%d: fill %.1f + dispatch %.1f us over %u plies | per-decision dispatch %.2f us | per-ply dispatch %.3f us | worst chunk-avg %.3f | sclk max %d last %d\n",
               pass, tot_fill, tot_disp, nplies, tot_disp / 180.0, tot_disp / nplies, worst, g_sclk_max, g_sclk_last);
    }
    printf("FUSEDALL OK (all rep sets verified x3 passes)\n");
}

static void mini(void) {
    // smallest corpus ply, one sequence, T=16384
    Ply *p = &plies[0];
    for (uint32_t i = 1; i < nplies; i++) if (plies[i].n < p->n) p = &plies[i];
    uint32_t *exp = malloc(MAXN * 4);
    uint32_t nexp = cpu_reps(p, exp);
    stage_ply(0, p);
    begin_cmd();
    int tq = 0;
    record_seq(g_cmd, 0, p, 16384, &tq);
    record_readback(g_cmd, 0);
    submit_cmd();
    uint64_t ts[8]; read_ts(tq, ts);
    uint32_t ngot = ((uint32_t *)b_read.ptr)[0];
    printf("mini ply dec=%u depth=%u n=%u distinct cpu=%u gpu=%u: fill %.2f insert %.2f argmaxU %.2f argmaxGen %.2f emit %.2f us\n",
           p->dec, p->depth, p->n, nexp, ngot,
           (ts[1]-ts[0])*g_ts_period/1000.0, (ts[2]-ts[1])*g_ts_period/1000.0,
           (ts[3]-ts[2])*g_ts_period/1000.0, (ts[4]-ts[3])*g_ts_period/1000.0,
           (ts[5]-ts[4])*g_ts_period/1000.0);
}

// ---------------- stage 3 full pipeline ----------------
// A1(GATE_OUT) -> A2 (bound) -> record dedupe -> order -> radix-select
// prefix -> Pass B chunks with host tau bookkeeping -> final sort ->
// materialization. Emits an SEL1 dump for `selcheck diff`.
typedef struct {
    uint32_t dec, parent_index, depth, len, nchild, childBase;
    int32_t hold_kind; uint32_t next_idx;
    const uint8_t *raw;
} FInst;
typedef struct { uint32_t i0, ni, childBase, nch, dec, depth; } FPly;
static FInst *finst; static uint32_t nfinst;
static FPly *fply; static uint32_t nfply;
static uint32_t g_total_ch, g_max_ply_ch;
static const uint8_t *g_bxm;

static void load_full_corpus(const char *path) {
    int fd = open(path, O_RDONLY); if (fd < 0) { perror(path); exit(1); }
    struct stat st; fstat(fd, &st);
    uint8_t *bx = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (bx == MAP_FAILED) { perror("mmap"); exit(1); }
    if (memcmp(bx, "BXD1", 4)) { fprintf(stderr, "bad BXD1\n"); exit(1); }
    g_bxm = bx;
    uint64_t n_inst = rd64(bx + 8);
    const uint8_t *bp = bx + 32;
    finst = malloc(n_inst * sizeof(FInst));
    uint32_t cbase = 0;
    uint32_t cur_dec = 0xFFFFFFFF, cur_depth = 0xFFFFFFFF;
    for (uint64_t ii = 0; ii < n_inst; ii++) {
        const uint8_t *inst = bp;
        FInst *F = &finst[nfinst++];
        F->dec = rd32(inst); F->parent_index = rd32(inst + 4);
        F->depth = rd32(inst + 12); F->len = rd32(inst + 16);
        F->nchild = rd32(inst + 20); F->childBase = cbase;
        F->next_idx = rd32(inst + 24); F->hold_kind = (int32_t)rd32(inst + 28);
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
    printf("full corpus: %u instances, %u plies, %u children, max ply %u\n",
           nfinst, nfply, g_total_ch, g_max_ply_ch);
}

// canonical SEL1 key (FNV-1a; recipe proven by the host audit, 0
// mismatches over all 8,995,877 non-dead children)
static uint64_t canon_key(const uint8_t *inst, const uint8_t *ch) {
    uint64_t h = 0xcbf29ce484222325ULL; const uint64_t P = 0x100000001b3ULL;
    uint32_t len = rd32(inst + 16);
#define KB(b) do { h ^= (uint8_t)(b); h *= P; } while (0)
#define K32(v) do { uint32_t _v = (uint32_t)(v); for (int _i = 0; _i < 4; _i++) KB(_v >> (8 * _i)); } while (0)
    KB(1);
    K32(rd32(inst + 24));            // next
    K32(rd32(inst + 28));            // hold (i32 bits)
    K32(rd32(ch + 196));             // b2b chain
    K32(rd32(ch + 192));             // combo
    K32(0);                          // lift (always 0)
    K32(rd32(ch + 188));             // pending
    KB(1); K32(len);
    for (uint32_t i = 0; i < len; i++) KB(ch[88 + i]);        // garbage flags
    K32(len);
    for (uint32_t i = 0; i < len; i++) { uint32_t r = rd32(ch + 8 + 2 * i) & 0xFFFF; KB(r); KB(r >> 8); }
#undef KB
#undef K32
    return h;
}

// generic descriptor helpers
static VkDescriptorSetLayout mk_dsl_n(int n) {
    VkDescriptorSetLayoutBinding b[8];
    for (int i = 0; i < n; i++) {
        b[i] = (VkDescriptorSetLayoutBinding){ 0 };
        b[i].binding = (uint32_t)i; b[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        b[i].descriptorCount = 1; b[i].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    }
    VkDescriptorSetLayoutCreateInfo ci = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO };
    ci.bindingCount = (uint32_t)n; ci.pBindings = b;
    VkDescriptorSetLayout l; CK(vkCreateDescriptorSetLayout(g_dev, &ci, NULL, &l));
    return l;
}
static VkDescriptorPool g_fpool;
static VkDescriptorSet mk_set_n(VkDescriptorSetLayout dsl, Buf *bufs, int n) {
    VkDescriptorSetAllocateInfo ai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO };
    ai.descriptorPool = g_fpool; ai.descriptorSetCount = 1; ai.pSetLayouts = &dsl;
    VkDescriptorSet s; CK(vkAllocateDescriptorSets(g_dev, &ai, &s));
    VkDescriptorBufferInfo bi[8]; VkWriteDescriptorSet wr[8];
    for (int i = 0; i < n; i++) {
        bi[i] = (VkDescriptorBufferInfo){ 0 };
        bi[i].buffer = bufs[i].buf; bi[i].offset = 0; bi[i].range = VK_WHOLE_SIZE;
        wr[i] = (VkWriteDescriptorSet){ 0 };
        wr[i].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
        wr[i].dstSet = s; wr[i].dstBinding = (uint32_t)i;
        wr[i].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
        wr[i].descriptorCount = 1; wr[i].pBufferInfo = &bi[i];
    }
    vkUpdateDescriptorSets(g_dev, (uint32_t)n, wr, 0, NULL);
    return s;
}
static VkPipelineLayout mk_layout_n(VkDescriptorSetLayout dsl, uint32_t pushsz) {
    VkPushConstantRange pr = { VK_SHADER_STAGE_COMPUTE_BIT, 0, pushsz };
    VkPipelineLayoutCreateInfo ci = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO };
    ci.setLayoutCount = 1; ci.pSetLayouts = &dsl;
    if (pushsz) { ci.pushConstantRangeCount = 1; ci.pPushConstantRanges = &pr; }
    VkPipelineLayout l; CK(vkCreatePipelineLayout(g_dev, &ci, NULL, &l));
    return l;
}

enum { ST_FILL, ST_A1, ST_A2, ST_DD, ST_ORD, ST_PFX, ST_B, ST_SRT, ST_MAT, ST_BP, ST_MB, ST_FTAB, ST_FCPY, ST_FEV, ST_DD1, ST_DD2, ST_DD3, ST_DD4, ST_NSTAGE };
static const char *ST_NAMES[ST_NSTAGE] = { "fill/copy", "A1", "A2", "dedupe", "order", "prefix", "passB", "sort", "mat", "bp", "matboards", "fill:tab", "fill:chunk", "fill:eval", "dd:ph1", "dd:ph2", "dd:ph3", "dd:ph4" };
static Buf F_binst, F_bplc, F_btab, F_brec, F_bsurv, F_bcnt, F_bgout,
           F_blist, F_btabfp, F_btabord, F_btabmeta, F_bisrep, F_breps,
           F_bprefix, F_bstats, F_beval, F_bchunk, F_bsel, F_barena,
           F_bread, F_bread2;
static VkPipelineLayout F_lay_bx, F_lay_dd, F_lay_ord, F_lay_pfx, F_lay_srt, F_lay_mat;
static VkDescriptorSet F_setA, F_setB, F_setDD, F_setOrd, F_setPfx, F_setSrt, F_setMat;
static VkPipeline F_pA1g, F_pA2, F_pB, F_pDD[4], F_pOrd, F_pPfx, F_pSrt, F_pMat;
// STAGE 3B v2 path (SELG_V2=1): key caches + adaptive-radix select/sort.
// The ordU cache build is timed inside the ST_ORD span and the ordVal
// cache build inside the ST_SRT span, so stage totals stay comparable
// to v1 (order = order+cache, sort = evcache+sort).
static Buf F_brepsord, F_bevord;
static VkPipelineLayout F_lay_cache, F_lay_evc, F_lay_pfx2, F_lay_srt2;
static VkDescriptorSet F_setCache, F_setPfx2, F_setEvC, F_setSrt2;
static VkPipeline F_pCache, F_pPfx2, F_pEvC, F_pSrt2, F_pOrd2;
static int F_v2;
// STAGE 3B v3 path (SELG_V3=1, implies v2): cache kernels also produce
// key min/max via u64 atomics; prefix/sort v3 read them, stage keys in
// LDS, and use subgroup scans.
static Buf F_bmmU, F_bmmV;
static VkPipelineLayout F_lay_cache2, F_lay_pfx3, F_lay_evc2, F_lay_srt3;
static VkDescriptorSet F_setCache2, F_setPfx3, F_setEvC2, F_setSrt3;
static VkPipeline F_pCache2, F_pPfx3, F_pEvC2, F_pSrt3;
static VkPipeline F_pSrt3F;
static VkPipelineLayout F_lay_fuse3;
static VkDescriptorSet F_setFuse3;
static int F_fuse3 = 0;
static int F_v3;
// STAGE 3B v4 (SELG_V4=1, implies v3): order3 (LDS-staged order).
static VkPipeline F_pOrd3;
static int F_v4;
// STAGE 3C (SELG_DDM=1): merged single-dispatch dedupe (rec_dedup_m).
// SELG_DDLSZ overrides the dedupe workgroup size (host grid divisor)
// for both the merged and the 4-dispatch forms.
static Buf F_bbar;
static VkPipelineLayout F_lay_ddm;
static VkDescriptorSet F_setDDM;
static VkPipeline F_pDDM;
static int F_ddm, F_ddlsz = 256;
// STAGE 3D (SELG_DDP=1, implies DDM): packed-slot dedupe table
// (rec_dedup_pk). One 32 B-per-slot array replaces tabfp/tabord/
// tabmeta; bindings 2/3/4 all alias it (u64 view / u32 view / unused).
static Buf F_btabpk;
static VkDescriptorSet F_setDDP;
static VkPipeline F_pDDP;
static int F_ddp;
// BASIC-TAX-REMOVAL (BX_MB=1): plain (non-GATE_OUT) A1 + matboards
// survivor-board reconstruction before sel_mat, dropping the GATE_OUT
// tax. BX_SPLIT=1: replay-only sub-spans for the tax-2 breakdown.
static VkPipelineLayout F_lay_mb;
static VkDescriptorSet F_setMB;
static VkPipeline F_pA1n, F_pMB;
static int F_mb, F_split;
// BASIC-CEILING (BX_MBW=1): like BX_MB (plain A1 + matboards) but the
// matboards pipeline is the wide kernel (matboards_w.spv content under
// the matboards.spv name in a dedicated spvdir) and the dispatch grid
// is nSel workgroups (one per survivor) instead of 1.
static int F_mbw;
static VkQueryPool F_qpool;
static VkCommandBuffer F_cmd;
static VkFence F_fence;
static int F_tq, F_nspans;
static struct { int stage, q0, q1; } F_spans[2048];
static double F_acc[ST_NSTAGE + 1];
#define ST_ALL ST_NSTAGE
static int F_timing;
#define FTAB 16384u

static int f_span_open(int stage) {
    vkCmdWriteTimestamp(F_cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, F_qpool, (uint32_t)F_tq);
    F_spans[F_nspans].stage = stage; F_spans[F_nspans].q0 = F_tq++;
    return F_nspans++;
}
static void f_span_close(int si) {
    vkCmdWriteTimestamp(F_cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, F_qpool, (uint32_t)F_tq);
    F_spans[si].q1 = F_tq++;
}
static void f_begin(void) {
    CK(vkResetCommandBuffer(F_cmd, 0));
    VkCommandBufferBeginInfo bi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    CK(vkBeginCommandBuffer(F_cmd, &bi));
    vkCmdResetQueryPool(F_cmd, F_qpool, 0, 8192);
    F_tq = 0; F_nspans = 0;
}
static void f_submit(void) {
    CK(vkEndCommandBuffer(F_cmd));
    VkSubmitInfo si = { VK_STRUCTURE_TYPE_SUBMIT_INFO };
    si.commandBufferCount = 1; si.pCommandBuffers = &F_cmd;
    CK(vkQueueSubmit(g_q, 1, &si, F_fence));
    CK(vkWaitForFences(g_dev, 1, &F_fence, VK_TRUE, UINT64_MAX));
    CK(vkResetFences(g_dev, 1, &F_fence));
    if (F_timing && F_tq) {
        static uint64_t ts[8192];
        CK(vkGetQueryPoolResults(g_dev, F_qpool, 0, (uint32_t)F_tq, sizeof ts, ts, 8, VK_QUERY_RESULT_64_BIT));
        for (int i = 0; i < F_nspans; i++)
            F_acc[F_spans[i].stage] += (double)(ts[F_spans[i].q1] - ts[F_spans[i].q0]) * g_ts_period / 1000.0;
    }
}
static void f_fill(Buf *b, uint32_t v) { vkCmdFillBuffer(F_cmd, b->buf, 0, b->size, v); }
static void f_copy(Buf *src, Buf *dst, VkDeviceSize off, VkDeviceSize size) {
    VkBufferCopy c = { off, 0, size };
    vkCmdCopyBuffer(F_cmd, src->buf, dst->buf, 1, &c);
}
static void f_disp(VkPipeline p, VkPipelineLayout lay, VkDescriptorSet set, const void *pc, uint32_t pcsz, uint32_t gx) {
    vkCmdBindPipeline(F_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, p);
    vkCmdBindDescriptorSets(F_cmd, VK_PIPELINE_BIND_POINT_COMPUTE, lay, 0, 1, &set, 0, NULL);
    if (pcsz) vkCmdPushConstants(F_cmd, lay, VK_SHADER_STAGE_COMPUTE_BIT, 0, pcsz, pc);
    vkCmdDispatch(F_cmd, gx, 1, 1);
}

// ---- bxrun: BP (movegen) integration + live-loop state ----
static Buf L_bbp, L_bbpout;
static VkPipeline L_pBP;
static VkPipelineLayout L_lay_bp;
static VkDescriptorSet L_setBP;
static const char *g_bpspv_path;
// per-instance BP start state (kind, sr, sx, sy), indexed by global instance ordinal
static int32_t *g_bp_kind, *g_bp_sr, *g_bp_sx, *g_bp_sy;
// expected plc words from the dump (gate comparison), 2 words per child
static uint32_t *g_plc_exp;
static uint64_t L_bp_count_bad, L_bp_plc_bad, L_bp_err;
// decisions (M4DC), loaded by the live driver
static uint32_t *g_decs; static uint32_t g_ndec_file;

static void full_setup(const char *spvdir, const char *bxdir, const char *tablespath) {
    { const char *e = getenv("BX_MB"); F_mb = e ? atoi(e) : 0; }
    { const char *e = getenv("BX_MBW"); F_mbw = e ? atoi(e) : 0; if (F_mbw) F_mb = 1; }
    { const char *e = getenv("BX_SPLIT"); F_split = e ? atoi(e) : 0; }
    printf("BX_MB = %d BX_MBW = %d BX_SPLIT = %d\n", F_mb, F_mbw, F_split);
    // bxrun: instances are staged live by the driver into F_binst; the
    // dump plc packing is kept host-side only as the BP gate reference.
    g_plc_exp = malloc((size_t)g_total_ch * 2 * 4);
    for (uint32_t k = 0; k < nfinst; k++) {
        FInst *F = &finst[k]; const uint8_t *inst = F->raw;
        const uint8_t *ch = inst + 196;
        for (uint32_t ci = 0; ci < F->nchild; ci++, ch += 228) {
            uint32_t *pw = g_plc_exp + (size_t)(F->childBase + ci) * 2;
            pw[0] = (uint32_t)ch[0] | ((uint32_t)ch[1] << 8) | ((uint32_t)(uint8_t)(int8_t)ch[2] << 16) | ((uint32_t)(uint8_t)(int8_t)ch[3] << 24);
            pw[1] = rd32(ch + 4);
        }
    }
    // tables: u32 magic + u32 count + doubles
    size_t tlen; uint8_t *traw = read_file(tablespath, &tlen);
    if (rd32(traw) != 0x4D345442u || rd32(traw + 4) != 180) { fprintf(stderr, "bad tables file\n"); exit(1); }

    VkDescriptorPoolCreateInfo dpci = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO };
    VkDescriptorPoolSize dps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 448 };
    dpci.maxSets = 28; dpci.poolSizeCount = 1; dpci.pPoolSizes = &dps;
    CK(vkCreateDescriptorPool(g_dev, &dpci, NULL, &g_fpool));

    F_binst = mkbuf((VkDeviceSize)nfinst * 192, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    memset(F_binst.ptr, 0, (size_t)nfinst * 192);
    F_bplc = mkbuf((VkDeviceSize)g_total_ch * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    memset(F_bplc.ptr, 0, (size_t)g_total_ch * 8);
    L_bbp = mkbuf((VkDeviceSize)nfinst * 24 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    L_bbpout = mkbuf((VkDeviceSize)nfinst * 65 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_btab = mkbuf(180 * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    memcpy(F_btab.ptr, traw + 8, 180 * 8);
    F_brec = mkbuf_local((VkDeviceSize)g_total_ch * 64, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    F_bsurv = mkbuf_local((VkDeviceSize)g_total_ch * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_bcnt = mkbuf_local(64, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_bgout = mkbuf_local((VkDeviceSize)g_max_ply_ch * 256, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_blist = mkbuf(MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_btabfp = mkbuf_local(FTAB * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_btabord = mkbuf_local(FTAB * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_btabmeta = mkbuf_local(FTAB * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_bisrep = mkbuf_local(MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_breps = mkbuf_local(MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    F_bprefix = mkbuf_local(MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    F_bstats = mkbuf(64, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_beval = mkbuf(8192 * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_bchunk = mkbuf(MAXN * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_bsel = mkbuf_local(96 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    F_barena = mkbuf_local(96 * 44 * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    F_bread = mkbuf((VkDeviceSize)g_max_ply_ch * 64, VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_bread2 = mkbuf(MAXN * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_brepsord = mkbuf_local((VkDeviceSize)MAXN * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_bevord = mkbuf_local(8192 * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT);
    F_bmmU = mkbuf_local(16, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    F_bmmV = mkbuf_local(16, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
    free(traw);

    VkDescriptorSetLayout dsl_bx = mk_dsl_n(7), dsl_dd = mk_dsl_n(7), dsl_4a = mk_dsl_n(4),
                          dsl_4b = mk_dsl_n(4), dsl_4c = mk_dsl_n(4), dsl_mat = mk_dsl_n(5);
    F_lay_bx = mk_layout_n(dsl_bx, 32);
    F_lay_dd = mk_layout_n(dsl_dd, 8);
    F_lay_ord = mk_layout_n(dsl_4a, 4);
    F_lay_pfx = mk_layout_n(dsl_4b, 8);
    F_lay_srt = mk_layout_n(dsl_4c, 4);
    F_lay_mat = mk_layout_n(dsl_mat, 8);
    { Buf s[7] = { F_binst, F_bplc, F_btab, F_brec, F_bsurv, F_bcnt, F_bgout }; F_setA = mk_set_n(dsl_bx, s, 7); }
    { Buf s[7] = { F_binst, F_bplc, F_btab, F_brec, F_bchunk, F_bcnt, F_bgout }; F_setB = mk_set_n(dsl_bx, s, 7); }
    { Buf s[7] = { F_brec, F_blist, F_btabfp, F_btabord, F_btabmeta, F_bisrep, F_bcnt }; F_setDD = mk_set_n(dsl_dd, s, 7); }
    { Buf s[4] = { F_blist, F_bisrep, F_breps, F_bstats }; F_setOrd = mk_set_n(dsl_4a, s, 4); }
    { Buf s[4] = { F_brec, F_breps, F_bprefix, F_bstats }; F_setPfx = mk_set_n(dsl_4b, s, 4); }
    { Buf s[4] = { F_brec, F_beval, F_bsel, F_bstats }; F_setSrt = mk_set_n(dsl_4c, s, 4); }
    { Buf s[5] = { F_brec, F_bgout, F_binst, F_bsel, F_barena }; F_setMat = mk_set_n(dsl_mat, s, 5); }
    { VkDescriptorSetLayout dsl_mb = mk_dsl_n(5); F_lay_mb = mk_layout_n(dsl_mb, 8);
      Buf s[5] = { F_binst, F_bplc, F_brec, F_bsel, F_bgout }; F_setMB = mk_set_n(dsl_mb, s, 5); }
    if (F_v2) {
        VkDescriptorSetLayout dsl_cache = mk_dsl_n(4), dsl_evc = mk_dsl_n(3),
                              dsl_pfx2 = mk_dsl_n(4), dsl_srt2 = mk_dsl_n(4);
        F_lay_cache = mk_layout_n(dsl_cache, 4);
        F_lay_evc = mk_layout_n(dsl_evc, 4);
        F_lay_pfx2 = mk_layout_n(dsl_pfx2, 8);
        F_lay_srt2 = mk_layout_n(dsl_srt2, 4);
        { Buf s[4] = { F_brec, F_breps, F_brepsord, F_bstats }; F_setCache = mk_set_n(dsl_cache, s, 4); }
        { Buf s[4] = { F_brepsord, F_breps, F_bprefix, F_bstats }; F_setPfx2 = mk_set_n(dsl_pfx2, s, 4); }
        { Buf s[3] = { F_brec, F_beval, F_bevord }; F_setEvC = mk_set_n(dsl_evc, s, 3); }
        { Buf s[4] = { F_bevord, F_beval, F_bsel, F_bstats }; F_setSrt2 = mk_set_n(dsl_srt2, s, 4); }
    }
    if (F_v3) {
        VkDescriptorSetLayout dsl_cache2 = mk_dsl_n(5), dsl_evc2 = mk_dsl_n(4),
                              dsl_pfx3 = mk_dsl_n(5), dsl_srt3 = mk_dsl_n(5);
        F_lay_cache2 = mk_layout_n(dsl_cache2, 4);
        F_lay_evc2 = mk_layout_n(dsl_evc2, 4);
        F_lay_pfx3 = mk_layout_n(dsl_pfx3, 8);
        F_lay_srt3 = mk_layout_n(dsl_srt3, 4);
        { Buf s[5] = { F_brec, F_breps, F_brepsord, F_bstats, F_bmmU }; F_setCache2 = mk_set_n(dsl_cache2, s, 5); }
        { Buf s[5] = { F_brepsord, F_breps, F_bprefix, F_bstats, F_bmmU }; F_setPfx3 = mk_set_n(dsl_pfx3, s, 5); }
        { Buf s[4] = { F_brec, F_beval, F_bevord, F_bmmV }; F_setEvC2 = mk_set_n(dsl_evc2, s, 4); }
        { Buf s[5] = { F_bevord, F_beval, F_bsel, F_bstats, F_bmmV }; F_setSrt3 = mk_set_n(dsl_srt3, s, 5); }
        if (F_fuse3) { VkDescriptorSetLayout dsl_fuse3 = mk_dsl_n(4); F_lay_fuse3 = mk_layout_n(dsl_fuse3, 4); { Buf s[4] = { F_brec, F_beval, F_bsel, F_bstats }; F_setFuse3 = mk_set_n(dsl_fuse3, s, 4); } }
    }

    if (F_ddm) {
        F_bbar = mkbuf_local(64, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
        VkDescriptorSetLayout dsl_ddm = mk_dsl_n(8);
        F_lay_ddm = mk_layout_n(dsl_ddm, 12);
        { Buf s[8] = { F_brec, F_blist, F_btabfp, F_btabord, F_btabmeta, F_bisrep, F_bcnt, F_bbar }; F_setDDM = mk_set_n(dsl_ddm, s, 8); }
    }
    if (F_ddp) {
        F_btabpk = mkbuf_local(FTAB * 32, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT);
        VkDescriptorSetLayout dsl_ddp = mk_dsl_n(8);
        { Buf s[8] = { F_brec, F_blist, F_btabpk, F_btabpk, F_btabpk, F_bisrep, F_bcnt, F_bbar }; F_setDDP = mk_set_n(dsl_ddp, s, 8); }
    }

    char path[1024];
    snprintf(path, sizeof path, "%s/bxp_a1_gate.spv", bxdir); F_pA1g = mkpipe(path, F_lay_bx);
    snprintf(path, sizeof path, "%s/bxp_a1.spv", bxdir); F_pA1n = mkpipe(path, F_lay_bx);
    snprintf(path, sizeof path, "%s/matboards.spv", spvdir); F_pMB = mkpipe(path, F_lay_mb);
    snprintf(path, sizeof path, "%s/bxp_a2.spv", bxdir); F_pA2 = mkpipe(path, F_lay_bx);
    snprintf(path, sizeof path, "%s/bxp_b.spv", bxdir); F_pB = mkpipe(path, F_lay_bx);
    for (int p = 0; p < 4; p++) {
        snprintf(path, sizeof path, "%s/rec_dedup_ph%d.spv", spvdir, p + 1);
        F_pDD[p] = mkpipe(path, F_lay_dd);
    }
    snprintf(path, sizeof path, "%s/order.spv", spvdir); F_pOrd = mkpipe(path, F_lay_ord);
    snprintf(path, sizeof path, "%s/sel_prefix.spv", spvdir); F_pPfx = mkpipe(path, F_lay_pfx);
    snprintf(path, sizeof path, "%s/sel_sort.spv", spvdir); F_pSrt = mkpipe(path, F_lay_srt);
    snprintf(path, sizeof path, "%s/sel_mat.spv", spvdir); F_pMat = mkpipe(path, F_lay_mat);
    if (F_v2) {
        snprintf(path, sizeof path, "%s/order2.spv", spvdir); F_pOrd2 = mkpipe(path, F_lay_ord);
        snprintf(path, sizeof path, "%s/sel_cache.spv", spvdir); F_pCache = mkpipe(path, F_lay_cache);
        snprintf(path, sizeof path, "%s/sel_prefix2.spv", spvdir); F_pPfx2 = mkpipe(path, F_lay_pfx2);
        snprintf(path, sizeof path, "%s/sel_evcache.spv", spvdir); F_pEvC = mkpipe(path, F_lay_evc);
        snprintf(path, sizeof path, "%s/sel_sort2.spv", spvdir); F_pSrt2 = mkpipe(path, F_lay_srt2);
    }
    if (F_v3) {
        snprintf(path, sizeof path, "%s/sel_cache2.spv", spvdir); F_pCache2 = mkpipe(path, F_lay_cache2);
        snprintf(path, sizeof path, "%s/sel_prefix3.spv", spvdir); F_pPfx3 = mkpipe(path, F_lay_pfx3);
        snprintf(path, sizeof path, "%s/sel_evcache2.spv", spvdir); F_pEvC2 = mkpipe(path, F_lay_evc2);
        snprintf(path, sizeof path, "%s/sel_sort3.spv", spvdir); F_pSrt3 = mkpipe(path, F_lay_srt3);
        if (F_fuse3) { snprintf(path, sizeof path, "%s/sel_sort3f.spv", spvdir); F_pSrt3F = mkpipe(path, F_lay_fuse3); }
    }
    if (F_v4) {
        snprintf(path, sizeof path, "%s/order3.spv", spvdir); F_pOrd3 = mkpipe(path, F_lay_ord);
    }
    if (F_ddm) {
        snprintf(path, sizeof path, "%s/rec_dedup_m.spv", spvdir); F_pDDM = mkpipe(path, F_lay_ddm);
    }
    if (F_ddp) {
        snprintf(path, sizeof path, "%s/rec_dedup_pk.spv", spvdir); F_pDDP = mkpipe(path, F_lay_ddm);
    }

    { VkDescriptorSetLayout dsl_bp = mk_dsl_n(2); L_lay_bp = mk_layout_n(dsl_bp, 16);
      Buf s[2] = { L_bbp, L_bbpout }; L_setBP = mk_set_n(dsl_bp, s, 2); }
    L_pBP = mkpipe(g_bpspv_path, L_lay_bp);

    VkQueryPoolCreateInfo qci = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO };
    qci.queryType = VK_QUERY_TYPE_TIMESTAMP; qci.queryCount = 8192;
    CK(vkCreateQueryPool(g_dev, &qci, NULL, &F_qpool));
    VkCommandBufferAllocateInfo cai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO };
    cai.commandPool = g_pool; cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cai.commandBufferCount = 1;
    CK(vkAllocateCommandBuffers(g_dev, &cai, &F_cmd));
    VkFenceCreateInfo fci = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    CK(vkCreateFence(g_dev, &fci, NULL, &F_fence));
}

typedef struct {
    int emitted;
    uint32_t depth, n, nreps, nsel;
    uint32_t *selpos;
    uint64_t *valbits; // per list position: value if evaluated, else bound U
    // bxrun live-loop extensions
    uint32_t *selG;        // kept children, global indices (size nsel)
    uint32_t *arena44;     // materialization readback copy (nsel * 44 words)
    uint64_t *keptAcc;     // accumulated bits per kept child (size nsel)
    int32_t *keptTslot;    // features[10] per kept child (size nsel)
    uint32_t *deadG;       // dead children, global indices (size ndead)
    uint64_t *deadVal;     // value bits per dead child (size ndead)
    uint64_t *deadAcc;     // accumulated bits per dead child (size ndead)
    uint32_t ndead;
} PlyOut;
static uint32_t F_arena_bad, F_prefix_bad;

// B&B round structure recorded during the gate run, replayed batched
// (one command buffer per decision) for the landing measurement.
typedef struct {
    uint32_t n, nreps, nsel, nRounds, nEval;
    uint32_t *roundSizes;
    uint32_t *chunks;    // concatenated round chunks, sum = nEval
    uint32_t *evalChild, *evalGen;
} PlyRec;
static PlyRec *F_rec;
static int F_record;

typedef struct { uint32_t child, gen; uint64_t ord; } REnt;
static int cmp_rent(const void *a, const void *b) {
    const REnt *x = a, *y = b;
    if (x->ord != y->ord) return x->ord > y->ord ? -1 : 1;
    return x->gen < y->gen ? -1 : (x->gen > y->gen);
}

static const uint8_t *child_raw(uint32_t g, const FInst **out_inst) {
    // binary search over instances by childBase
    uint32_t lo = 0, hi = nfinst;
    while (lo + 1 < hi) { uint32_t mid = (lo + hi) / 2; if (finst[mid].childBase <= g) lo = mid; else hi = mid; }
    *out_inst = &finst[lo];
    return finst[lo].raw + 196 + (size_t)(g - finst[lo].childBase) * 228;
}

static void run_ply_full(FPly *P, PlyOut *po) {
    memset(po, 0, sizeof *po);
    PlyRec *rec = (F_record && F_rec) ? &F_rec[(uint32_t)(P - fply)] : NULL;
    if (rec) memset(rec, 0, sizeof *rec);
    // ---- bxrun: BP (movegen) over this ply's staged instances ----
    {
        uint32_t *iw = (uint32_t *)F_binst.ptr;
        uint32_t *bp = (uint32_t *)L_bbp.ptr;
        for (uint32_t j = 0; j < P->ni; j++) {
            uint32_t gi = P->i0 + j;
            uint32_t *src = iw + (size_t)gi * 48;
            uint32_t *dst = bp + (size_t)gi * 24;
            for (int i = 0; i < 20; i++) dst[i] = src[7 + i];
            dst[20] = (src[2] & 0xFF) | ((uint32_t)g_bp_kind[gi] << 8) | ((uint32_t)g_bp_sr[gi] << 16) | ((uint32_t)(uint8_t)g_bp_sx[gi] << 24);
            dst[21] = (uint32_t)g_bp_sy[gi];
            dst[22] = 0; dst[23] = 0;
        }
        uint32_t pcbp[4] = { P->i0, P->ni, 0, 0 };
        f_begin();
        int s0 = f_span_open(ST_BP); f_disp(L_pBP, L_lay_bp, L_setBP, pcbp, 16, P->ni); f_span_close(s0);
        f_submit();
        uint32_t *bo = (uint32_t *)L_bbpout.ptr;
        uint32_t *pw = (uint32_t *)F_bplc.ptr;
        uint32_t run = 0;
        for (uint32_t j = 0; j < P->ni; j++) {
            uint32_t gi = P->i0 + j;
            uint32_t h = bo[(size_t)gi * 65];
            uint32_t cnt = h & 0xFFFF, err = (h >> 16) & 0xFF;
            if (err) { L_bp_err++; if (L_bp_err <= 5) fprintf(stderr, "BP err inst %u err %u\n", gi, err); }
            if (cnt != finst[gi].nchild) { L_bp_count_bad++; if (L_bp_count_bad <= 5) fprintf(stderr, "BP count inst %u got %u exp %u\n", gi, cnt, finst[gi].nchild); }
            iw[(size_t)gi * 48 + 3] = cnt;
            iw[(size_t)gi * 48 + 4] = P->childBase + run;
            for (uint32_t k = 0; k < cnt; k++) {
                uint32_t orec = bo[(size_t)gi * 65 + 1 + k];
                int32_t kind = g_bp_kind[gi]; // orec carries no kind; it is the instance's
                int32_t rot = (int32_t)(orec & 3);
                int32_t x = (int32_t)(int8_t)((orec >> 4) & 0xFF);
                int32_t y = (int32_t)(int8_t)((orec >> 12) & 0xFF);
                uint32_t srs = (orec >> 20) & 7;
                uint32_t w0 = (uint32_t)kind | ((uint32_t)rot << 8) | ((uint32_t)(uint8_t)x << 16) | ((uint32_t)(uint8_t)y << 24);
                uint32_t w1 = srs;
                uint64_t g = (uint64_t)P->childBase + run + k;
                pw[g * 2] = w0; pw[g * 2 + 1] = w1;
                if (g_plc_exp[g * 2] != w0 || (g_plc_exp[g * 2 + 1] & 0xFF) != (w1 & 0xFF)) {
                    L_bp_plc_bad++;
                    if (L_bp_plc_bad <= 5) fprintf(stderr, "BP plc child %llu got %08x %u exp %08x %u\n", (unsigned long long)g, w0, w1, g_plc_exp[g * 2], g_plc_exp[g * 2 + 1] & 0xFF);
                }
            }
            run += cnt;
        }
        P->nch = run;
    }
    uint32_t nch = P->nch, cbase = P->childBase;
    uint32_t pc8[8];
    // ---- A1 (GATE_OUT) + A2 ----
    f_begin();
    int si = f_span_open(ST_FILL); f_fill(&F_bcnt, 0); f_span_close(si);
    pc8[0] = P->i0; pc8[1] = P->ni; pc8[2] = cbase; pc8[3] = 0; pc8[4] = 0; pc8[5] = 0; pc8[6] = 0; pc8[7] = 0;
    si = f_span_open(ST_A1); f_disp(F_mb ? F_pA1n : F_pA1g, F_lay_bx, F_setA, pc8, 32, P->ni); f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_FILL); f_fill(&F_bcnt, 0); f_span_close(si);
    pc8[3] = 0; pc8[4] = 0xFFF00000u; pc8[5] = 0xFFFFFFFFu; pc8[6] = 0;
    si = f_span_open(ST_A2); f_disp(F_pA2, F_lay_bx, F_setA, pc8, 32, P->ni); f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_FILL); f_copy(&F_brec, &F_bread, (VkDeviceSize)cbase * 64, (VkDeviceSize)nch * 64); f_span_close(si);
    f_submit();
    const uint32_t *rw = (const uint32_t *)F_bread.ptr;
    uint64_t *Ubits = malloc(nch * 8), *valB = malloc(nch * 8);
    uint32_t *list = malloc(nch * 4);
    int32_t *posOf = malloc(nch * 4);
    uint32_t *deadL = malloc(nch * 4); uint32_t ndeadL = 0;
    uint32_t n = 0;
    for (uint32_t c = 0; c < nch; c++) {
        posOf[c] = -1;
        Ubits[c] = (uint64_t)rw[c * 16 + 2] | ((uint64_t)rw[c * 16 + 3] << 32);
        valB[c] = 0;
        if (!((rw[c * 16 + 13] >> 8) & 1u)) { posOf[c] = (int32_t)n; list[n++] = cbase + c; }
        else deadL[ndeadL++] = c;
    }
    // ---- bxrun: evaluate dead children (one Pass B chunk over them) ----
    po->ndead = ndeadL;
    po->deadG = malloc((ndeadL ? ndeadL : 1) * 4);
    po->deadVal = malloc((ndeadL ? ndeadL : 1) * 8);
    po->deadAcc = malloc((ndeadL ? ndeadL : 1) * 8);
    for (uint32_t i = 0; i < ndeadL; i++) po->deadG[i] = cbase + deadL[i];
    if (ndeadL) {
        memcpy(F_bchunk.ptr, po->deadG, ndeadL * 4);
        uint32_t pcb[8] = { ndeadL, 0, 0, 0, 0, 0, 0, 0 };
        f_begin();
        int si2 = f_span_open(ST_B); f_disp(F_pB, F_lay_bx, F_setB, pcb, 32, (ndeadL + 63) / 64); f_span_close(si2);
        barrier_all(F_cmd);
        si2 = f_span_open(ST_FILL); f_copy(&F_brec, &F_bread, (VkDeviceSize)cbase * 64, (VkDeviceSize)nch * 64); f_span_close(si2);
        f_submit();
        for (uint32_t i = 0; i < ndeadL; i++) {
            uint32_t c = deadL[i];
            po->deadVal[i] = (uint64_t)rw[c * 16 + 4] | ((uint64_t)rw[c * 16 + 5] << 32);
            po->deadAcc[i] = (uint64_t)rw[c * 16 + 6] | ((uint64_t)rw[c * 16 + 7] << 32);
        }
    }
    if (n == 0) { free(Ubits); free(valB); free(list); free(posOf); free(deadL); po->emitted = 0; return; }
    // ---- dedupe + order ----
    memcpy(F_blist.ptr, list, n * 4);
    memset(F_bstats.ptr, 0, 64);
    f_begin();
    si = f_span_open(ST_FILL);
    if (F_ddp) f_fill(&F_btabpk, 0xFFFFFFFFu);
    else { f_fill(&F_btabfp, 0xFFFFFFFFu); f_fill(&F_btabord, 0); f_fill(&F_btabmeta, 0xFFFFFFFFu); } // gen-min field needs MAX init
    f_fill(&F_bisrep, 0); f_fill(&F_bcnt, 0);
    if (F_ddm) f_fill(&F_bbar, 0);
    if (F_v3) { vkCmdFillBuffer(F_cmd, F_bmmU.buf, 0, 8, 0xFFFFFFFFu); vkCmdFillBuffer(F_cmd, F_bmmU.buf, 8, 8, 0); }
    f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_DD);
    uint32_t grid = (n + (uint32_t)F_ddlsz - 1) / (uint32_t)F_ddlsz;
    if (F_ddp) {
        uint32_t pcm[3] = { n, FTAB - 1, grid };
        f_disp(F_pDDP, F_lay_ddm, F_setDDP, pcm, 12, grid);
    } else if (F_ddm) {
        uint32_t pcm[3] = { n, FTAB - 1, grid };
        f_disp(F_pDDM, F_lay_ddm, F_setDDM, pcm, 12, grid);
    } else {
        uint32_t pcd[2] = { n, FTAB - 1 };
        for (int p = 0; p < 4; p++) { f_disp(F_pDD[p], F_lay_dd, F_setDD, pcd, 8, grid); if (p < 3) barrier_all(F_cmd); }
    }
    f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_ORD);
    f_disp(F_v4 ? F_pOrd3 : (F_v2 ? F_pOrd2 : F_pOrd), F_lay_ord, F_setOrd, &n, 4, 1);
    if (F_v3) { barrier_all(F_cmd); f_disp(F_pCache2, F_lay_cache2, F_setCache2, &n, 4, (n + 255) / 256); }
    else if (F_v2) { barrier_all(F_cmd); f_disp(F_pCache, F_lay_cache, F_setCache, &n, 4, (n + 255) / 256); }
    f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_FILL); f_copy(&F_breps, &F_bread2, 0, n * 4); f_span_close(si);
    f_submit();
    uint32_t nReps = ((const uint32_t *)F_bstats.ptr)[0];
    if (rec) { rec->n = n; rec->nreps = nReps; }
    const uint32_t *reps = (const uint32_t *)F_bread2.ptr;
    REnt *repOrder = malloc(nReps * sizeof(REnt));
    for (uint32_t j = 0; j < nReps; j++) {
        repOrder[j].child = reps[j];
        repOrder[j].gen = (uint32_t)posOf[reps[j] - cbase];
        repOrder[j].ord = ord_of(Ubits[reps[j] - cbase]);
    }
    qsort(repOrder, nReps, sizeof(REnt), cmp_rent);
    // ---- B&B prefix evaluation ----
    uint32_t *evalChild = malloc(nReps * 4), *evalGen = malloc(nReps * 4);
    uint8_t *isEval = calloc(n, 1);
    uint32_t nEval = 0;
    uint32_t *chunk = malloc(nReps * 4), *prefix = malloc(nReps * 4);
    uint64_t b = 256;
    for (int round = 0; round < 24; round++) {
        uint32_t bcur = b > nReps ? nReps : (uint32_t)b;
        uint32_t pcp[2] = { nReps, bcur };
        f_begin();
        si = f_span_open(ST_PFX);
        if (F_v3) f_disp(F_pPfx3, F_lay_pfx3, F_setPfx3, pcp, 8, 1);
        else if (F_v2) f_disp(F_pPfx2, F_lay_pfx2, F_setPfx2, pcp, 8, 1);
        else f_disp(F_pPfx, F_lay_pfx, F_setPfx, pcp, 8, 1);
        f_span_close(si);
        barrier_all(F_cmd);
        si = f_span_open(ST_FILL); f_copy(&F_bprefix, &F_bread2, 0, bcur * 4); f_span_close(si);
        f_submit();
        uint32_t pfxSize = ((const uint32_t *)F_bstats.ptr)[1];
        if (pfxSize != bcur) { F_prefix_bad++; fprintf(stderr, "ply dec%u d%u: prefix size %u != %u\n", P->dec, P->depth, pfxSize, bcur); }
        memcpy(prefix, F_bread2.ptr, pfxSize * 4);
        {   // verify the prefix SET against the host order
            uint32_t *a = malloc(pfxSize * 4), *c = malloc(bcur * 4);
            memcpy(a, prefix, pfxSize * 4);
            for (uint32_t j = 0; j < bcur; j++) c[j] = repOrder[j].child;
            qsort(a, pfxSize, 4, cmp_u32); qsort(c, bcur, 4, cmp_u32);
            if (pfxSize != bcur || memcmp(a, c, bcur * 4)) { F_prefix_bad++; fprintf(stderr, "ply dec%u d%u: prefix SET mismatch (b=%u)\n", P->dec, P->depth, bcur); }
            free(a); free(c);
        }
        uint32_t cn = 0;
        for (uint32_t j = 0; j < pfxSize; j++) {
            uint32_t g = prefix[j]; uint32_t pos = (uint32_t)posOf[g - cbase];
            if (!isEval[pos]) { isEval[pos] = 1; chunk[cn++] = g; evalChild[nEval] = g; evalGen[nEval] = pos; nEval++; }
        }
        if (rec) {
            rec->roundSizes = realloc(rec->roundSizes, (rec->nRounds + 1) * 4);
            rec->roundSizes[rec->nRounds++] = cn;
            rec->chunks = realloc(rec->chunks, (rec->nEval + cn) * 4);
            memcpy(rec->chunks + rec->nEval, chunk, cn * 4);
            rec->nEval += cn;
        }
        if (cn) {
            memcpy(F_bchunk.ptr, chunk, cn * 4);
            uint32_t pcb[8] = { cn, 0, 0, 0, 0, 0, 0, 0 };
            f_begin();
            si = f_span_open(ST_B); f_disp(F_pB, F_lay_bx, F_setB, pcb, 32, (cn + 63) / 64); f_span_close(si);
            barrier_all(F_cmd);
            si = f_span_open(ST_FILL); f_copy(&F_brec, &F_bread, (VkDeviceSize)cbase * 64, (VkDeviceSize)nch * 64); f_span_close(si);
            f_submit();
            for (uint32_t c = 0; c < nch; c++)
                valB[c] = (uint64_t)rw[c * 16 + 4] | ((uint64_t)rw[c * 16 + 5] << 32);
        }
        if (nEval >= nReps) break;
        if (nEval >= 96) {
            REnt *ev = malloc(nEval * sizeof(REnt));
            for (uint32_t j = 0; j < nEval; j++) { ev[j].child = evalChild[j]; ev[j].gen = evalGen[j]; ev[j].ord = ord_of(valB[evalChild[j] - cbase]); }
            qsort(ev, nEval, sizeof(REnt), cmp_rent);
            uint64_t tauOrd = ev[95].ord; uint32_t tauGen = ev[95].gen;
            uint64_t tauBits = valB[ev[95].child - cbase];
            free(ev);
            int stop = 1;
            for (uint32_t j = 0; j < nReps; j++) {
                if (isEval[repOrder[j].gen]) continue;
                uint64_t uo = repOrder[j].ord;
                if (uo < tauOrd) stop = 1;
                else if (uo == tauOrd) {
                    uint64_t ub = Ubits[repOrder[j].child - cbase];
                    stop = (ub == tauBits && repOrder[j].gen > tauGen) ? 1 : 0;
                } else stop = 0;
                break;
            }
            if (stop) break;
        }
        b *= 2;
    }
    if (rec) {
        rec->evalChild = malloc(nEval * 4); memcpy(rec->evalChild, evalChild, nEval * 4);
        rec->evalGen = malloc(nEval * 4); memcpy(rec->evalGen, evalGen, nEval * 4);
    }
    // ---- final sort ----
    {
        REnt *ev = malloc(nEval * sizeof(REnt));
        for (uint32_t j = 0; j < nEval; j++) { ev[j].child = evalChild[j]; ev[j].gen = evalGen[j]; ev[j].ord = 0; }
        qsort(ev, nEval, sizeof(REnt), cmp_rent); // gen asc (ord all 0 -> gen order via cmp? no: cmp sorts ord desc then gen asc; ord equal -> gen asc) 
        // NOTE: cmp_rent with ord==0 for all gives generation order.
        uint32_t *ep = (uint32_t *)F_beval.ptr;
        for (uint32_t j = 0; j < nEval; j++) { ep[j * 2] = ev[j].child; ep[j * 2 + 1] = ev[j].gen; }
        free(ev);
    }
    f_begin();
    si = f_span_open(ST_SRT);
    if (F_fuse3) {
        f_disp(F_pSrt3F, F_lay_fuse3, F_setFuse3, &nEval, 4, 1);
    } else if (F_v3) {
        vkCmdFillBuffer(F_cmd, F_bmmV.buf, 0, 8, 0xFFFFFFFFu); vkCmdFillBuffer(F_cmd, F_bmmV.buf, 8, 8, 0);
        barrier_all(F_cmd);
        f_disp(F_pEvC2, F_lay_evc2, F_setEvC2, &nEval, 4, (nEval + 255) / 256);
        barrier_all(F_cmd);
        f_disp(F_pSrt3, F_lay_srt3, F_setSrt3, &nEval, 4, 1);
    } else if (F_v2) {
        f_disp(F_pEvC, F_lay_evc, F_setEvC, &nEval, 4, (nEval + 255) / 256);
        barrier_all(F_cmd);
        f_disp(F_pSrt2, F_lay_srt2, F_setSrt2, &nEval, 4, 1);
    } else f_disp(F_pSrt, F_lay_srt, F_setSrt, &nEval, 4, 1);
    f_span_close(si);
    barrier_all(F_cmd);
    si = f_span_open(ST_FILL); f_copy(&F_bsel, &F_bread2, 0, 96 * 4); f_span_close(si);
    f_submit();
    uint32_t nSel = ((const uint32_t *)F_bstats.ptr)[0];
    if (rec) rec->nsel = nSel;
    uint32_t *selG = malloc(nSel * 4);
    memcpy(selG, F_bread2.ptr, nSel * 4);
    // ---- materialization ----
    {
        uint32_t pcm[2] = { nSel, cbase };
        f_begin();
        if (F_mb) {
            uint32_t pcmb[2] = { cbase, nSel };
            si = f_span_open(ST_MB);
            if (!F_mbw) f_disp(F_pMB, F_lay_mb, F_setMB, pcmb, 8, 1);
            else if (nSel) f_disp(F_pMB, F_lay_mb, F_setMB, pcmb, 8, nSel);
            f_span_close(si);
            barrier_all(F_cmd);
        }
        si = f_span_open(ST_MAT); f_disp(F_pMat, F_lay_mat, F_setMat, pcm, 8, 1); f_span_close(si);
        barrier_all(F_cmd);
        si = f_span_open(ST_FILL); f_copy(&F_barena, &F_bread2, 0, 96 * 44 * 4); f_span_close(si);
        f_submit();
        const uint32_t *aw = (const uint32_t *)F_bread2.ptr;
        for (uint32_t k = 0; k < nSel; k++) {
            uint32_t g = selG[k];
            const FInst *fi; const uint8_t *ch = child_raw(g, &fi);
            const uint32_t *a = aw + k * 44;
            int bad = 0;
            for (int i = 0; i < 20; i++) if (a[i] != rd32(ch + 8 + 4 * i)) bad = 1;
            for (int i = 0; i < 10; i++) if (a[20 + i] != rd32(ch + 88 + 4 * i)) bad = 1;
            if (a[30] != fi->next_idx) bad = 1;
            if (a[31] != (fi->hold_kind < 0 ? 0xFFFFFFFFu : (uint32_t)fi->hold_kind)) bad = 1;
            if (a[32] != rd32(ch + 196)) bad = 1;
            if ((int32_t)a[33] != (int32_t)rd32(ch + 192)) bad = 1;
            if (a[34] != rd32(ch + 188)) bad = 1;
            if (a[35] != (uint32_t)valB[g - cbase] || a[36] != (uint32_t)(valB[g - cbase] >> 32)) bad = 1;
            if (a[38] != g) bad = 1;
            if (bad) { F_arena_bad++; if (F_arena_bad <= 5) fprintf(stderr, "arena mismatch dec%u d%u kept %u child %u\n", P->dec, P->depth, k, g); }
        }
        po->arena44 = malloc(96 * 44 * 4);
        memcpy(po->arena44, aw, 96 * 44 * 4);
    }
    // ---- bxrun: kept accumulated/tslot from the final record state ----
    f_begin();
    si = f_span_open(ST_FILL); f_copy(&F_brec, &F_bread, (VkDeviceSize)cbase * 64, (VkDeviceSize)nch * 64); f_span_close(si);
    f_submit();
    po->keptAcc = malloc(nSel * 8); po->keptTslot = malloc(nSel * 4);
    for (uint32_t k = 0; k < nSel; k++) {
        uint32_t c = selG[k] - cbase;
        po->keptAcc[k] = (uint64_t)rw[c * 16 + 6] | ((uint64_t)rw[c * 16 + 7] << 32);
        po->keptTslot[k] = (int32_t)((rw[c * 16 + 12] >> 18) & 0x3);
    }
    po->selG = selG;
    po->emitted = 1; po->depth = P->depth + 1; po->n = n; po->nreps = nReps; po->nsel = nSel;
    po->selpos = malloc(nSel * 4);
    for (uint32_t k = 0; k < nSel; k++) po->selpos[k] = (uint32_t)posOf[selG[k] - cbase];
    po->valbits = malloc(n * 8);
    for (uint32_t j = 0; j < n; j++) {
        uint32_t c = list[j] - cbase;
        po->valbits[j] = isEval[j] ? valB[c] : Ubits[c];
    }
    free(Ubits); free(valB); free(list); free(posOf); free(repOrder);
    free(evalChild); free(evalGen); free(isEval); free(chunk); free(prefix); free(deadL);
}

// Landing measurement: replay the recorded B&B round structure with
// one command buffer per decision (bxpg methodology — GPU timestamp
// spans summed per decision, host gaps excluded by construction).
static void run_replay(uint32_t ndec) {
    uint32_t totalEval = 0;
    for (uint32_t i = 0; i < nfply; i++) totalEval += F_rec[i].nEval;
    { // tax-2 anatomy: B&B round/chunk structure + survivor volume
        uint32_t tRounds = 0, tChunks = 0, tPlies = 0; uint64_t tChunkCh = 0, tSel = 0;
        uint32_t maxCn = 0, hist[5] = { 0, 0, 0, 0, 0 };
        for (uint32_t i = 0; i < nfply; i++) {
            PlyRec *R = &F_rec[i];
            if (!R->n) continue;
            tPlies++; tRounds += R->nRounds; tSel += R->nsel;
            for (uint32_t r = 0; r < R->nRounds; r++) {
                uint32_t cn = R->roundSizes[r];
                if (!cn) continue;
                tChunks++; tChunkCh += cn; if (cn > maxCn) maxCn = cn;
                hist[cn <= 64 ? 0 : cn <= 128 ? 1 : cn <= 256 ? 2 : cn <= 512 ? 3 : 4]++;
            }
        }
        printf("PASSB structure: plies %u, rounds %u, nonempty chunks %u, chunk children %llu, avg chunk %.1f, max chunk %u, hist[<=64,<=128,<=256,<=512,>512] = %u %u %u %u %u, totalEval %u, survivors %llu (%.1f/dec)\n",
               tPlies, tRounds, tChunks, (unsigned long long)tChunkCh,
               tChunks ? (double)tChunkCh / tChunks : 0.0, maxCn,
               hist[0], hist[1], hist[2], hist[3], hist[4], totalEval,
               (unsigned long long)tSel, (double)tSel / ndec);
    }
    Buf listA = mkbuf((VkDeviceSize)g_total_ch * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    Buf chunkA = mkbuf((VkDeviceSize)(totalEval ? totalEval : 1) * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    Buf evalA = mkbuf((VkDeviceSize)(totalEval ? totalEval : 1) * 8, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT);
    uint32_t *chunkOff = malloc(nfply * 4), *evalOff = malloc(nfply * 4);
    uint32_t *lp = (uint32_t *)listA.ptr, *cp = (uint32_t *)chunkA.ptr, *ep = (uint32_t *)evalA.ptr;
    uint32_t co = 0, eo = 0;
    for (uint32_t i = 0; i < nfply; i++) {
        FPly *P = &fply[i];
        uint32_t w = 0;
        for (uint32_t k = P->i0; k < P->i0 + P->ni; k++) {
            FInst *F = &finst[k];
            const uint8_t *ch = F->raw + 196;
            for (uint32_t ci = 0; ci < F->nchild; ci++, ch += 228)
                if (!ch[201]) lp[P->childBase + w++] = F->childBase + ci;
        }
        chunkOff[i] = co;
        memcpy(cp + co, F_rec[i].chunks, F_rec[i].nEval * 4); co += F_rec[i].nEval;
        evalOff[i] = eo;
        for (uint32_t j = 0; j < F_rec[i].nEval; j++) { ep[(eo + j) * 2] = F_rec[i].evalChild[j]; ep[(eo + j) * 2 + 1] = F_rec[i].evalGen[j]; }
        eo += F_rec[i].nEval;
    }
    static double decSel[512], decAll[512];
    for (int pass = 0; pass < 2; pass++) {
        F_timing = 1;
        memset(F_acc, 0, sizeof F_acc);
        g_sclk_max = 0;
        uint32_t pi = 0;
        for (uint32_t d = 0; d < ndec; d++) {
            double acc0[ST_NSTAGE + 1]; memcpy(acc0, F_acc, sizeof acc0);
            f_begin();
            int sw = f_span_open(ST_ALL);
            while (pi < nfply && fply[pi].dec == d) {
                FPly *P = &fply[pi];
                PlyRec *R = &F_rec[pi];
                pi++;
                if (!R->n) continue;
                uint32_t cbase = P->childBase;
                uint32_t pc8[8] = { P->i0, P->ni, cbase, 0, 0, 0, 0, 0 };
                int si = f_span_open(ST_FILL); f_fill(&F_bcnt, 0); f_span_close(si);
                si = f_span_open(ST_A1); f_disp(F_mb ? F_pA1n : F_pA1g, F_lay_bx, F_setA, pc8, 32, P->ni); f_span_close(si);
                barrier_all(F_cmd);
                pc8[4] = 0xFFF00000u; pc8[5] = 0xFFFFFFFFu;
                si = f_span_open(ST_FILL); f_fill(&F_bcnt, 0); f_span_close(si);
                si = f_span_open(ST_A2); f_disp(F_pA2, F_lay_bx, F_setA, pc8, 32, P->ni); f_span_close(si);
                barrier_all(F_cmd);
                si = f_span_open(F_split ? ST_FTAB : ST_FILL);
                if (F_ddp) f_fill(&F_btabpk, 0xFFFFFFFFu);
                else { f_fill(&F_btabfp, 0xFFFFFFFFu); f_fill(&F_btabord, 0); f_fill(&F_btabmeta, 0xFFFFFFFFu); }
                f_fill(&F_bisrep, 0); f_fill(&F_bcnt, 0);
                if (F_ddm) f_fill(&F_bbar, 0);
                if (F_v3) { vkCmdFillBuffer(F_cmd, F_bmmU.buf, 0, 8, 0xFFFFFFFFu); vkCmdFillBuffer(F_cmd, F_bmmU.buf, 8, 8, 0); }
                { VkBufferCopy c = { (VkDeviceSize)cbase * 4, 0, (VkDeviceSize)R->n * 4 };
                  vkCmdCopyBuffer(F_cmd, listA.buf, F_blist.buf, 1, &c); }
                f_span_close(si);
                barrier_all(F_cmd);
                uint32_t grid = (R->n + (uint32_t)F_ddlsz - 1) / (uint32_t)F_ddlsz;
                si = f_span_open(ST_DD);
                if (F_ddp) {
                    uint32_t pcm[3] = { R->n, FTAB - 1, grid };
                    f_disp(F_pDDP, F_lay_ddm, F_setDDP, pcm, 12, grid);
                } else if (F_ddm) {
                    uint32_t pcm[3] = { R->n, FTAB - 1, grid };
                    f_disp(F_pDDM, F_lay_ddm, F_setDDM, pcm, 12, grid);
                } else {
                    uint32_t pcd[2] = { R->n, FTAB - 1 };
                    for (int p = 0; p < 4; p++) { int sp2 = F_split ? f_span_open(ST_DD1 + p) : -1; f_disp(F_pDD[p], F_lay_dd, F_setDD, pcd, 8, grid); if (F_split) f_span_close(sp2); if (p < 3) barrier_all(F_cmd); }
                }
                f_span_close(si);
                barrier_all(F_cmd);
                si = f_span_open(ST_ORD);
                f_disp(F_v4 ? F_pOrd3 : (F_v2 ? F_pOrd2 : F_pOrd), F_lay_ord, F_setOrd, &R->n, 4, 1);
                if (F_v3) { barrier_all(F_cmd); f_disp(F_pCache2, F_lay_cache2, F_setCache2, &R->n, 4, (R->n + 255) / 256); }
                else if (F_v2) { barrier_all(F_cmd); f_disp(F_pCache, F_lay_cache, F_setCache, &R->n, 4, (R->n + 255) / 256); }
                f_span_close(si);
                barrier_all(F_cmd);
                uint32_t roff = chunkOff[pi - 1];
                for (uint32_t r = 0; r < R->nRounds; r++) {
                    uint64_t bb = 256ull << r;
                    uint32_t bcur = bb > R->nreps ? R->nreps : (uint32_t)bb;
                    uint32_t pcp[2] = { R->nreps, bcur };
                    si = f_span_open(ST_PFX);
        if (F_v3) f_disp(F_pPfx3, F_lay_pfx3, F_setPfx3, pcp, 8, 1);
        else if (F_v2) f_disp(F_pPfx2, F_lay_pfx2, F_setPfx2, pcp, 8, 1);
        else f_disp(F_pPfx, F_lay_pfx, F_setPfx, pcp, 8, 1);
        f_span_close(si);
                    uint32_t cn = R->roundSizes[r];
                    if (!cn) barrier_all(F_cmd);
                    if (cn) {
                        si = f_span_open(F_split ? ST_FCPY : ST_FILL);
                        { VkBufferCopy c = { (VkDeviceSize)roff * 4, 0, (VkDeviceSize)cn * 4 };
                          vkCmdCopyBuffer(F_cmd, chunkA.buf, F_bchunk.buf, 1, &c); }
                        f_span_close(si);
                        barrier_all(F_cmd);
                        uint32_t pcb[8] = { cn, 0, 0, 0, 0, 0, 0, 0 };
                        si = f_span_open(ST_B); f_disp(F_pB, F_lay_bx, F_setB, pcb, 32, (cn + 63) / 64); f_span_close(si);
                        if (r + 1 < R->nRounds) barrier_all(F_cmd);
                    }
                    roff += cn;
                }
                si = f_span_open(F_split ? ST_FEV : ST_FILL);
                { VkBufferCopy c = { (VkDeviceSize)evalOff[pi - 1] * 8, 0, (VkDeviceSize)R->nEval * 8 };
                  vkCmdCopyBuffer(F_cmd, evalA.buf, F_beval.buf, 1, &c); }
                f_span_close(si);
                barrier_all(F_cmd);
                si = f_span_open(ST_SRT);
                if (F_fuse3) {
                    f_disp(F_pSrt3F, F_lay_fuse3, F_setFuse3, &R->nEval, 4, 1);
                } else if (F_v3) {
                    vkCmdFillBuffer(F_cmd, F_bmmV.buf, 0, 8, 0xFFFFFFFFu); vkCmdFillBuffer(F_cmd, F_bmmV.buf, 8, 8, 0);
                    barrier_all(F_cmd);
                    f_disp(F_pEvC2, F_lay_evc2, F_setEvC2, &R->nEval, 4, (R->nEval + 255) / 256);
                    barrier_all(F_cmd);
                    f_disp(F_pSrt3, F_lay_srt3, F_setSrt3, &R->nEval, 4, 1);
                } else if (F_v2) {
                    f_disp(F_pEvC, F_lay_evc, F_setEvC, &R->nEval, 4, (R->nEval + 255) / 256);
                    barrier_all(F_cmd);
                    f_disp(F_pSrt2, F_lay_srt2, F_setSrt2, &R->nEval, 4, 1);
                } else f_disp(F_pSrt, F_lay_srt, F_setSrt, &R->nEval, 4, 1);
                f_span_close(si);
                barrier_all(F_cmd);
                if (F_mb) {
                    uint32_t pcmb[2] = { cbase, R->nsel };
                    si = f_span_open(ST_MB);
                    if (!F_mbw) f_disp(F_pMB, F_lay_mb, F_setMB, pcmb, 8, 1);
                    else if (R->nsel) f_disp(F_pMB, F_lay_mb, F_setMB, pcmb, 8, R->nsel);
                    f_span_close(si);
                    barrier_all(F_cmd);
                }
                uint32_t pcm[2] = { R->nsel, cbase };
                si = f_span_open(ST_MAT); f_disp(F_pMat, F_lay_mat, F_setMat, pcm, 8, 1); f_span_close(si);
            }
            f_span_close(sw);
            f_submit();
            double s = 0;
            for (int st = ST_DD; st <= ST_MAT; st++) s += F_acc[st] - acc0[st];
            if (F_mb) s += F_acc[ST_MB] - acc0[ST_MB];
            decSel[d] = s;
            decAll[d] = F_acc[ST_ALL] - acc0[ST_ALL];
        }
        printf("REPLAY pass %d (sclk max %d MHz)\n", pass, g_sclk_max);
        for (int st = 0; st < ST_NSTAGE; st++) {
            if (F_acc[st] == 0 && st > ST_BP) continue;
            printf("  %-9s total %10.1f us | per-decision %8.2f us\n", ST_NAMES[st], F_acc[st], F_acc[st] / ndec);
        }
        double *sv = malloc(ndec * 8), *sa = malloc(ndec * 8);
        memcpy(sv, decSel, ndec * 8); memcpy(sa, decAll, ndec * 8);
        qsort(sv, ndec, 8, cmp_dbl); qsort(sa, ndec, 8, cmp_dbl);
        double mean = 0, ma = 0;
        for (uint32_t d = 0; d < ndec; d++) { mean += decSel[d]; ma += decAll[d]; }
        printf("  SELECTION replay: mean %.2f us/dec, median %.2f, p90 %.2f, max %.2f\n",
               mean / ndec, sv[ndec / 2], sv[(ndec * 9) / 10], sv[ndec - 1]);
        printf("  WHOLE-CB replay: mean %.2f us/dec, median %.2f, p90 %.2f, max %.2f\n",
               ma / ndec, sa[ndec / 2], sa[(ndec * 9) / 10], sa[ndec - 1]);
        free(sv); free(sa);
    }
    F_timing = 0;
    free(chunkOff); free(evalOff);
}

typedef struct { uint8_t *p; size_t len, cap; } DBuf;
static void dput(DBuf *b, const void *src, size_t n) {
    if (b->len + n > b->cap) { b->cap = (b->len + n) * 2 + 4096; b->p = realloc(b->p, b->cap); }
    memcpy(b->p + b->len, src, n); b->len += n;
}
static void dput32(DBuf *b, uint32_t v) { dput(b, &v, 4); }
static void dput64(DBuf *b, uint64_t v) { dput(b, &v, 8); }

static uint64_t fnv_file(const char *path, uint64_t *out_size) {
    size_t len; uint8_t *d = read_file(path, &len);
    uint64_t h = 0xcbf29ce484222325ULL;
    for (size_t i = 0; i < len; i++) { h ^= d[i]; h *= 0x100000001b3ULL; }
    free(d); *out_size = len; return h;
}

static int run_full(const char *bxdump, const char *tables, const char *spvdir, const char *bxdir, const char *outpath) {
    // BASIC-TAX-REMOVAL fix: upstream bxrun sets g_bpspv_path only in
    // run_live, so full mode died in full_setup at mkpipe(NULL) with a
    // bare "Bad address" (fopen(NULL) -> EFAULT -> perror(NULL)). The
    // BP pipeline is created (and dispatched per ply) in full mode too.
    { const char *e = getenv("BX_BPSPV"); g_bpspv_path = e ? e : "/tmp/s9work/opus-p2/bpmg.spv"; }
    { const char *e = getenv("SELG_V2"); F_v2 = e ? atoi(e) : 0; }
    { const char *e = getenv("SELG_V3"); F_v3 = e ? atoi(e) : 0; if (F_v3) F_v2 = 1; }
    { const char *e = getenv("SELG_V4"); F_v4 = e ? atoi(e) : 0; if (F_v4) { F_v3 = 1; F_v2 = 1; } }
    { const char *e = getenv("SELG_FUSE3"); F_fuse3 = e ? atoi(e) : 0; if (F_fuse3) printf("SELG_FUSE3 = 1 (evcache2 fused into sort)\n"); }
    printf("SELG_V2 = %d SELG_V3 = %d SELG_V4 = %d\n", F_v2, F_v3, F_v4);
    { const char *e = getenv("SELG_DDM"); F_ddm = e ? atoi(e) : 0; }
    { const char *e = getenv("SELG_DDLSZ"); if (e && atoi(e) > 0) F_ddlsz = atoi(e); }
    { const char *e = getenv("SELG_DDP"); F_ddp = e ? atoi(e) : 0; if (F_ddp) F_ddm = 1; }
    printf("SELG_DDM = %d SELG_DDLSZ = %d SELG_DDP = %d\n", F_ddm, F_ddlsz, F_ddp);
    load_full_corpus(bxdump);
    vk_init();
    full_setup(spvdir, bxdir, tables);
    // BASIC-TAX-REMOVAL: restore full-mode corpus staging. Upstream
    // bxrun stages instances + BP start states only in run_live; in
    // full mode F_binst stayed zeroed and g_bp_* were NULL, so the
    // first ply segfaulted. Stage the BXD1 instances into the GPU
    // 48-word layout (field offsets per bxclose.c) and the BP start
    // states from the bpdump (1:1 with BXD1 instance order).
    {
        uint32_t *iw = (uint32_t *)F_binst.ptr;
        for (uint32_t gi = 0; gi < nfinst; gi++) {
            const uint8_t *h = finst[gi].raw;
            uint32_t *w = iw + (size_t)gi * 48;
            w[0] = rd32(h); w[1] = rd32(h + 12); w[2] = rd32(h + 16);
            w[3] = 0; w[4] = 0; w[5] = rd32(h + 24); w[6] = rd32(h + 28);
            for (int i = 0; i < 20; i++) w[7 + i] = rd32(h + 32 + 4 * i);
            for (int i = 0; i < 10; i++) w[27 + i] = rd32(h + 112 + 4 * i);
            w[37] = rd32(h + 152); w[38] = rd32(h + 156); w[39] = rd32(h + 160);
            w[40] = rd32(h + 164); w[41] = rd32(h + 168);
            uint64_t rb = rd64(h + 172); w[42] = (uint32_t)rb; w[43] = (uint32_t)(rb >> 32);
            rb = rd64(h + 180); w[44] = (uint32_t)rb; w[45] = (uint32_t)(rb >> 32);
            rb = rd64(h + 188); w[46] = (uint32_t)rb; w[47] = (uint32_t)(rb >> 32);
        }
        const char *bpp = getenv("BX_BPDUMP");
        if (!bpp) bpp = "/tmp/s9work/stage1/bpdump180.bin";
        size_t blen; uint8_t *bd = read_file(bpp, &blen);
        g_bp_kind = malloc(nfinst * 4); g_bp_sr = malloc(nfinst * 4);
        g_bp_sx = malloc(nfinst * 4); g_bp_sy = malloc(nfinst * 4);
        size_t p = 0; uint32_t n = 0;
        while (p < blen && n < nfinst) {
            p += 88;
            g_bp_kind[n] = bd[p + 1]; g_bp_sr[n] = bd[p + 2];
            g_bp_sx[n] = (int8_t)bd[p + 3]; g_bp_sy[n] = (int8_t)bd[p + 4];
            p += 6;
            uint32_t no = (uint32_t)bd[p] | ((uint32_t)bd[p + 1] << 8);
            p += 2 + 8 * (size_t)no;
            n++;
        }
        if (n != nfinst) { fprintf(stderr, "bpdump entries %u != instances %u\n", n, nfinst); exit(1); }
        free(bd);
        printf("full-mode staging: %u instances + BP states staged\n", nfinst);
    }
    pthread_t th; pthread_create(&th, NULL, sclk_thread, NULL);
    uint32_t ndec = 0;
    for (uint32_t i = 0; i < nfply; i++) if (fply[i].dec + 1 > ndec) ndec = fply[i].dec + 1;
    { const char *md = getenv("SELG_MAXDEC"); if (md && atoi(md) > 0 && (uint32_t)atoi(md) < ndec) ndec = (uint32_t)atoi(md); }
    char outpath2[1200];
    double decSel[512];
    F_rec = calloc(nfply, sizeof(PlyRec));
    for (int run = 0; run < 2; run++) {
        F_timing = 0;
        F_record = (run == 0);
        memset(F_acc, 0, sizeof F_acc);
        const char *op = outpath;
        if (run == 1) { snprintf(outpath2, sizeof outpath2, "%s.timing", outpath); op = outpath2; }
        FILE *out = fopen(op, "wb");
        if (!out) { perror(op); return 1; }
        fwrite("SEL1", 1, 4, out);
        fwrite(&ndec, 4, 1, out);
        uint32_t pi = 0;
        for (uint32_t d = 0; d < ndec; d++) {
            double acc0[ST_NSTAGE]; memcpy(acc0, F_acc, sizeof acc0);
            DBuf db = { 0 };
            uint32_t nplies_d = 0;
            while (pi < nfply && fply[pi].dec == d) {
                FPly *P = &fply[pi++];
                PlyOut po; run_ply_full(P, &po);
                if (!po.emitted) continue;
                nplies_d++;
                dput32(&db, po.depth); dput32(&db, po.nreps); dput32(&db, po.n); dput32(&db, po.nsel);
                uint32_t j = 0;
                for (uint32_t k = P->i0; k < P->i0 + P->ni; k++) {
                    FInst *F = &finst[k];
                    const uint8_t *ch = F->raw + 196;
                    for (uint32_t ci = 0; ci < F->nchild; ci++, ch += 228) {
                        if (ch[201]) continue;
                        dput64(&db, po.valbits[j]);
                        dput64(&db, 0); // reward: not compared by selcheck diff (documented)
                        dput64(&db, canon_key(F->raw, ch));
                        dput32(&db, F->parent_index);
                        dput32(&db, F->next_idx);
                        j++;
                    }
                }
                if (j != po.n) { fprintf(stderr, "FATAL dec%u: emitted %u children, ply n=%u\n", d, j, po.n); exit(1); }
                for (uint32_t k = 0; k < po.nsel; k++) dput32(&db, po.selpos[k]);
                free(po.selpos); free(po.valbits);
            }
            fwrite(&nplies_d, 4, 1, out);
            if (db.len) fwrite(db.p, 1, db.len, out);
            free(db.p);
            double s = 0;
            for (int st = ST_DD; st <= ST_MAT; st++) if (st != ST_FILL) s += F_acc[st] - acc0[st];
            decSel[d] = s;
        }
        fclose(out);
        printf("RUN %d -> %s\n", run, op);
    }
    printf("arena mismatches: %u | prefix mismatches: %u\n", F_arena_bad, F_prefix_bad);
    run_replay(ndec);
    g_sample_run = 0; pthread_join(th, NULL);
    uint64_t s1, s2;
    uint64_t h1 = fnv_file(outpath, &s1), h2 = fnv_file(outpath2, &s2);
    printf("dumps: gate %llu bytes fnv %016llx | timing %llu bytes fnv %016llx | %s\n",
           (unsigned long long)s1, (unsigned long long)h1,
           (unsigned long long)s2, (unsigned long long)h2,
           (s1 == s2 && h1 == h2) ? "IDENTICAL" : "DIFFER");
    /* The .timing dump is the timing run's copy of the gate dump, kept only
       so the fnv comparison above can verify run-to-run determinism. When
       IDENTICAL it is a byte-for-byte duplicate (288 MB) — remove it so
       repeated gate runs stop accumulating copies. On DIFFER it stays as
       diagnostic evidence. (2026-11-19, item517 §7) */
    if (s1 == s2 && h1 == h2 && remove(outpath2) == 0)
        printf("timing dump removed (byte-identical to gate dump; kept only when DIFFER)\n");
    return 0;
}

// ---------------- bxrun live driver ----------------
// Trajectory host semantics ported from bxclose (proven 0-mismatch over
// all 413,838 instances against BXD1). Children come from the GPU:
// BP (plc) -> Pass A (records + GATE_OUT) -> selection (selg machinery).
typedef struct {
    uint16_t rows[40]; uint8_t flags[40];
    int32_t hold; uint32_t next; int can_hold;
    int32_t chain, combo, pending, due, tslot;
    double reward, value;
    uint32_t depth; int32_t root; uint32_t arena;
} LNode;
typedef struct { LNode *node; int32_t kind; int used_hold; uint32_t next2; int32_t hold2; } LCand;
static const int8_t L_spawn_miny[7] = { 1, 0, 0, 0, 0, 0, 0 };
static double L_powi(double x, int n) {
    double r = 1.0, b = x; unsigned int k = (unsigned int)n;
    while (1) { if (k & 1) r *= b; k >>= 1; if (!k) break; b *= b; }
    return r;
}
static uint64_t L_dead_bad, L_deadacc_bad, L_desync;

static int run_live(const char *bxdump, const char *tables, const char *spvdir, const char *bxdir,
                    const char *outpath, const char *decpath, const char *bpspv) {
    F_fuse3 = 1; F_v3 = 1; F_v2 = 1;
    g_bpspv_path = bpspv;
    load_full_corpus(bxdump);
    // decisions (M4DC)
    {
        size_t len; uint8_t *raw = read_file(decpath, &len);
        if (rd32(raw) != 0x4D344443u) { fprintf(stderr, "bad decisions magic\n"); return 1; }
        g_ndec_file = rd32(raw + 4);
        g_decs = malloc((size_t)g_ndec_file * 108 * 4);
        memcpy(g_decs, raw + 8, (size_t)g_ndec_file * 108 * 4);
        free(raw);
    }
    double discount;
    {
        size_t len; uint8_t *raw = read_file(tables, &len);
        memcpy(&discount, raw + 8 + 168 * 8, 8);
        free(raw);
    }
    vk_init();
    full_setup(spvdir, bxdir, tables);
    g_bp_kind = malloc(nfinst * 4); g_bp_sr = malloc(nfinst * 4);
    g_bp_sx = malloc(nfinst * 4); g_bp_sy = malloc(nfinst * 4);
    FILE *out = fopen(outpath, "wb");
    if (!out) { perror(outpath); return 1; }
    fwrite("SEL1", 1, 4, out);
    fwrite(&g_ndec_file, 4, 1, out);
    uint32_t pi = 0; // fply cursor (dump reference)
    LNode *beam = malloc(96 * sizeof(LNode)), *nbeam = malloc(96 * sizeof(LNode));
    LCand *cand = malloc(192 * sizeof(LCand));
    double tot_wall = 0;
    for (uint32_t d = 0; d < g_ndec_file; d++) {
        const uint32_t *dw = g_decs + (size_t)d * 108;
        uint32_t len = dw[80], seq_len = dw[81];
        int32_t seq[16]; for (int i = 0; i < 16; i++) seq[i] = (int32_t)dw[82 + i];
        int64_t frame0 = (int64_t)((uint64_t)dw[106] | ((uint64_t)dw[107] << 32));
        LNode root; memset(&root, 0, sizeof root);
        for (int i = 0; i < 40; i++) { root.rows[i] = (uint16_t)dw[i]; root.flags[i] = (uint8_t)dw[40 + i]; }
        root.hold = (int32_t)dw[99]; root.next = 0; root.can_hold = (int)dw[100];
        root.combo = (int32_t)dw[101]; root.pending = (int32_t)dw[102];
        root.chain = (int32_t)dw[103]; root.due = (int32_t)dw[104]; root.tslot = (int32_t)dw[105];
        root.reward = 0.0; root.value = 0.0; root.depth = 0; root.root = -1; root.arena = 0;
        beam[0] = root; int nb = 1;
        uint64_t arena_next = 1;
        int64_t m_frame = 0; double m_value = 1.0;
        uint64_t inst_cursor = (pi < nfply) ? fply[pi].i0 : 0;
        uint64_t child_cursor = (pi < nfply) ? fply[pi].childBase : 0;
        DBuf db = { 0 };
        uint32_t nplies_d = 0;
        struct timespec tw0, tw1; clock_gettime(CLOCK_MONOTONIC, &tw0);
        for (uint32_t ply = 0; nb > 0; ply++) {
            int64_t target = frame0 + 60 * (int64_t)ply;
            if (target < m_frame) { m_frame = 0; m_value = 1.0; }
            for (int64_t s = m_frame + 1; s <= target; s++) if (s > 10800) m_value += 0.008 / 60.0;
            m_frame = target;
            double scale = L_powi(discount, (int)ply);
            uint64_t scale_bits, mult_bits; memcpy(&scale_bits, &scale, 8); memcpy(&mult_bits, &m_value, 8);
            int ncand = 0;
            for (int bi = 0; bi < nb; bi++) {
                LNode *nd = &beam[bi];
                if (nd->next >= seq_len) continue;
                int32_t cur = seq[nd->next];
                cand[ncand++] = (LCand){ nd, cur, 0, nd->next + 1, nd->hold };
                if (nd->can_hold) {
                    if (nd->hold < 0) {
                        if (nd->next + 1 < seq_len && seq[nd->next + 1] != cur)
                            cand[ncand++] = (LCand){ nd, seq[nd->next + 1], 1, nd->next + 2, cur };
                    } else if (nd->hold != cur) {
                        cand[ncand++] = (LCand){ nd, nd->hold, 1, nd->next + 1, cur };
                    }
                }
            }
            FPly *expP = (pi < nfply && fply[pi].dec == d && fply[pi].depth == ply) ? &fply[pi] : NULL;
            if (ncand == 0) {
                if (expP) { L_desync++; fprintf(stderr, "DESYNC dec %u ply %u: dump has a ply, live has no candidates\n", d, ply); }
                break;
            }
            if (!expP) { L_desync++; fprintf(stderr, "DESYNC dec %u ply %u: live has %d candidates, dump has no ply\n", d, ply, ncand); break; }
            if (expP->i0 != inst_cursor || expP->childBase != child_cursor) {
                L_desync++; fprintf(stderr, "DESYNC dec %u ply %u: cursors live (%llu,%llu) dump (%u,%u)\n",
                    d, ply, (unsigned long long)inst_cursor, (unsigned long long)child_cursor, expP->i0, expP->childBase);
                break;
            }
            // stage instances (48 words) + BP start states
            uint32_t *iw = (uint32_t *)F_binst.ptr;
            for (int m = 0; m < ncand; m++) {
                uint32_t gi = (uint32_t)inst_cursor + m;
                LCand *c = &cand[m]; LNode *nd = c->node;
                uint32_t *w = iw + (size_t)gi * 48;
                w[0] = d; w[1] = ply; w[2] = len; w[3] = 0; w[4] = 0;
                w[5] = c->next2; w[6] = c->hold2 < 0 ? 0xFFFFFFFFu : (uint32_t)c->hold2;
                for (int i = 0; i < 20; i++) w[7 + i] = (uint32_t)nd->rows[2 * i] | ((uint32_t)nd->rows[2 * i + 1] << 16);
                for (int i = 0; i < 10; i++) w[27 + i] = (uint32_t)nd->flags[4 * i] | ((uint32_t)nd->flags[4 * i + 1] << 8) | ((uint32_t)nd->flags[4 * i + 2] << 16) | ((uint32_t)nd->flags[4 * i + 3] << 24);
                w[37] = (uint32_t)nd->combo; w[38] = (uint32_t)nd->chain; w[39] = (uint32_t)nd->pending;
                w[40] = (uint32_t)nd->due; w[41] = (uint32_t)nd->tslot;
                uint64_t rb; memcpy(&rb, &nd->reward, 8);
                w[42] = (uint32_t)rb; w[43] = (uint32_t)(rb >> 32);
                w[44] = (uint32_t)mult_bits; w[45] = (uint32_t)(mult_bits >> 32);
                w[46] = (uint32_t)scale_bits; w[47] = (uint32_t)(scale_bits >> 32);
                int sr, sx, sy;
                if (ply == 0 && !c->used_hold) { sr = (int32_t)dw[96]; sx = (int32_t)dw[97]; sy = (int32_t)dw[98]; }
                else if (c->used_hold && nd->hold >= 0) { sr = 0; sx = 3; sy = len > 20 ? (int)len - 21 : 0; }
                else { sr = 0; sx = 3; sy = len > 20 ? (int)len - 21 : -L_spawn_miny[c->kind]; }
                g_bp_kind[gi] = c->kind; g_bp_sr[gi] = sr; g_bp_sx[gi] = sx; g_bp_sy[gi] = sy;
            }
            FPly P; memset(&P, 0, sizeof P);
            P.i0 = (uint32_t)inst_cursor; P.ni = (uint32_t)ncand; P.childBase = (uint32_t)child_cursor;
            P.nch = 0; P.dec = d; P.depth = ply;
            PlyOut po; run_ply_full(&P, &po);
            // per-instance counts (host readback) for child mapping
            uint32_t *bo = (uint32_t *)L_bbpout.ptr;
            uint32_t cnts[192], bases[192]; uint32_t run = 0;
            for (int m = 0; m < ncand; m++) { bases[m] = run; cnts[m] = bo[(size_t)(inst_cursor + m) * 65] & 0xFFFF; run += cnts[m]; }
            // dead children: verify values against the dump
            for (uint32_t i = 0; i < po.ndead; i++) {
                const FInst *fi; const uint8_t *ch = child_raw(po.deadG[i], &fi);
                if (rd64(ch + 220) != po.deadVal[i]) { L_dead_bad++; if (L_dead_bad <= 5) fprintf(stderr, "dead value dec %u ply %u child %u\n", d, ply, po.deadG[i]); }
                if (rd64(ch + 212) != po.deadAcc[i]) { L_deadacc_bad++; if (L_deadacc_bad <= 5) fprintf(stderr, "dead accum dec %u ply %u child %u\n", d, ply, po.deadG[i]); }
            }
            if (po.emitted) {
                nplies_d++;
                dput32(&db, po.depth); dput32(&db, po.nreps); dput32(&db, po.n); dput32(&db, po.nsel);
                uint32_t j = 0;
                for (uint32_t k = expP->i0; k < expP->i0 + expP->ni; k++) {
                    FInst *F = &finst[k];
                    const uint8_t *ch = F->raw + 196;
                    for (uint32_t ci = 0; ci < F->nchild; ci++, ch += 228) {
                        if (ch[201]) continue;
                        dput64(&db, po.valbits[j]);
                        dput64(&db, 0);
                        dput64(&db, canon_key(F->raw, ch));
                        dput32(&db, F->parent_index);
                        dput32(&db, F->next_idx);
                        j++;
                    }
                }
                if (j != po.n) { fprintf(stderr, "FATAL dec %u ply %u: emitted %u children, ply n=%u\n", d, ply, j, po.n); exit(1); }
                for (uint32_t k = 0; k < po.nsel; k++) dput32(&db, po.selpos[k]);
                // build next beam from GPU outputs
                int nnb = 0;
                for (uint32_t k = 0; k < po.nsel; k++) {
                    uint32_t g = po.selG[k];
                    uint32_t loc = g - (uint32_t)child_cursor;
                    int m = 0; while (m + 1 < ncand && bases[m + 1] <= loc) m++;
                    uint32_t cord = loc - bases[m];
                    const uint32_t *a = po.arena44 + (size_t)k * 44;
                    LNode *cn = &nbeam[nnb];
                    memset(cn, 0, sizeof *cn);
                    for (int i = 0; i < 20; i++) { cn->rows[2 * i] = a[i] & 0xFFFF; cn->rows[2 * i + 1] = a[i] >> 16; }
                    for (int i = 0; i < 10; i++) for (int q = 0; q < 4; q++) cn->flags[4 * i + q] = (a[20 + i] >> (8 * q)) & 0xFF;
                    cn->next = a[30]; cn->hold = a[31] == 0xFFFFFFFFu ? -1 : (int32_t)a[31];
                    cn->chain = (int32_t)a[32]; cn->combo = (int32_t)a[33]; cn->pending = (int32_t)a[34];
                    uint64_t vb = (uint64_t)a[35] | ((uint64_t)a[36] << 32); memcpy(&cn->value, &vb, 8);
                    cn->tslot = po.keptTslot[k];
                    memcpy(&cn->reward, &po.keptAcc[k], 8);
                    cn->can_hold = 1; cn->due = 0; cn->depth = ply + 1;
                    cn->root = (ply == 0) ? (int32_t)loc : cand[m].node->root;
                    cn->arena = (uint32_t)(arena_next + po.ndead + k);
                    nnb++;
                }
                arena_next += po.ndead + po.nsel;
                memcpy(beam, nbeam, (size_t)nnb * sizeof(LNode));
                nb = nnb;
            } else {
                arena_next += po.ndead;
                nb = 0;
            }
            inst_cursor += ncand; child_cursor += P.nch; pi++;
            free(po.selpos); free(po.valbits); free(po.selG); free(po.arena44);
            free(po.keptAcc); free(po.keptTslot); free(po.deadG); free(po.deadVal); free(po.deadAcc);
            if (L_desync) break;
        }
        clock_gettime(CLOCK_MONOTONIC, &tw1);
        tot_wall += (tw1.tv_sec - tw0.tv_sec) + (tw1.tv_nsec - tw0.tv_nsec) / 1e9;
        fwrite(&nplies_d, 4, 1, out);
        if (db.len) fwrite(db.p, 1, db.len, out);
        free(db.p);
        if (pi < nfply && fply[pi].dec == d) { L_desync++; fprintf(stderr, "DESYNC dec %u: dump has more plies\n", d); }
        if (d % 60 == 59) printf("live dec %u done (bp bad %llu/%llu, arena %u, dead %llu/%llu, desync %llu)\n", d,
            (unsigned long long)L_bp_count_bad, (unsigned long long)L_bp_plc_bad, F_arena_bad,
            (unsigned long long)L_dead_bad, (unsigned long long)L_deadacc_bad, (unsigned long long)L_desync);
        if (L_desync) break;
    }
    fclose(out);
    printf("== live gate: bp count bad %llu, bp plc bad %llu, bp err %llu, arena bad %u, prefix bad %u, dead val bad %llu, dead acc bad %llu, desync %llu\n",
           (unsigned long long)L_bp_count_bad, (unsigned long long)L_bp_plc_bad, (unsigned long long)L_bp_err,
           F_arena_bad, F_prefix_bad, (unsigned long long)L_dead_bad, (unsigned long long)L_deadacc_bad, (unsigned long long)L_desync);
    printf("== live wall total %.1f s (incl. all submits)\n", tot_wall);
    uint64_t sz; uint64_t h = fnv_file(outpath, &sz);
    printf("SEL1 out: %llu bytes fnv %016llx\n", (unsigned long long)sz, (unsigned long long)h);
    return (L_bp_count_bad || L_bp_plc_bad || L_bp_err || F_arena_bad || F_prefix_bad || L_dead_bad || L_deadacc_bad || L_desync) ? 3 : 0;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "live")) {
        if (argc < 9) { fprintf(stderr, "usage: bxrun live <bxdump> <tables> <spvdir> <bxspvdir> <outdump> <decisions> <bpspv>\n"); return 2; }
        return run_live(argv[2], argv[3], argv[4], argv[5], argv[6], argv[7], argv[8]);
    }
    if (argc >= 2 && !strcmp(argv[1], "full")) {
        if (argc < 7) { fprintf(stderr, "usage: selg full <bxdump> <tables> <spvdir> <bxspvdir> <outdump>\n"); return 2; }
        return run_full(argv[2], argv[3], argv[4], argv[5], argv[6]);
    }
    if (argc < 4) { fprintf(stderr, "usage: selg <bench1|benchall|mini> <bxdump> <spvdir>\n"); return 2; }
    load_corpus(argv[2]);
    vk_init();
    dedupe_setup(argv[3]);
    fused_setup(argv[3]);
    pthread_t th; pthread_create(&th, NULL, sclk_thread, NULL);
    if (!strcmp(argv[1], "bench1")) bench1();
    else if (!strcmp(argv[1], "benchall")) benchall();
    else if (!strcmp(argv[1], "fused1")) fused1();
    else if (!strcmp(argv[1], "fusedall")) fusedall();
    else if (!strcmp(argv[1], "mini")) mini();
    else if (!strcmp(argv[1], "micro")) { if (argc < 5) { fprintf(stderr, "micro needs a variant\n"); return 2; } micro_bench(argv[3], atoi(argv[4])); }
    else { fprintf(stderr, "unknown mode\n"); return 2; }
    g_sample_run = 0; pthread_join(th, NULL);
    return 0;
}
