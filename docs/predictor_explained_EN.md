# Workflow Success Rate Predictor — A Plain-Language Guide

> This document is written for everyday users. It explains how the plugin estimates "whether your workflow will run successfully" in plain language.
> No math background required — just a basic understanding of VRAM and RAM.

---

## 1. What Is the Plugin Predicting?

When you've set up a workflow in ComfyUI and are about to click Run, the plugin quietly estimates one thing:

> **"Given my machine's current state, how likely is it that this workflow completes — without crashing halfway through?"**

That probability is what the `PRED` capsule in the status bar shows: the **predicted workflow execution success rate**.

---

## 2. Why Do We Need a Prediction?

The most common cause of AI image generation crashes is simple: **not enough memory**.

More specifically, **VRAM (GPU memory)** is the bottleneck. AI models (like Flux, SD series) must be loaded into the GPU's VRAM to run. If the model is too large and VRAM is too small, the program crashes with an OOM (Out of Memory) error.

But "not enough VRAM" is not a binary pass/fail situation:

- If a model slightly exceeds VRAM capacity, the system may borrow from RAM as overflow — and still complete
- If RAM overflow isn't enough either, the OS may use virtual memory (page file on disk) — extremely slow but sometimes viable
- Only when all resources are exhausted is failure truly guaranteed

That's why the success rate is a **continuous probability**, not a simple yes/no.

---

## 3. A Key Insight: Models Don't All Need to Be in VRAM at the Same Time

This is the most important premise of the algorithm — and one many people miss.

Imagine you have three thick reference books (CLIP text encoder, diffusion model, VAE decoder), but your desk (VRAM) can only hold one at a time.

A common reaction: "I can't fit all three books — I can't do my homework."

But in practice, your workflow looks like this:

```
Open book 1 → put back on shelf → take out book 2 → put back → take out book 3
```

That's exactly how ComfyUI works. It runs workflows **sequentially** — one model is used, then unloaded, then the next is loaded.

So the real question is:

1. **Is the desk big enough for the thickest single book?** (Hard constraint)
2. **Is the shelf big enough to store all the books?** (Soft constraint)

---

## 4. What Can the Plugin "See"?

This is crucial to understanding prediction accuracy: **the plugin can only predict what it can observe.**

VRAM is divided into three categories:

| Type | Controllable by ComfyUI? | How the Algorithm Handles It |
|------|--------------------------|------------------------------|
| Currently free VRAM | ✓ Directly available | Counted as available |
| PyTorch-cached VRAM (model cache) | ✓ Actively released before workflow starts | Counted as available |
| System/environment overhead (driver, desktop rendering, 3rd-party apps) | ✗ Not visible or controllable | **Excluded — treated as permanently occupied** |

RAM is handled similarly:

| Type | How the Algorithm Handles It |
|------|------------------------------|
| Currently free RAM | Counted as available |
| RAM used by other programs (browsers, games) | **Excluded — the algorithm can't predict whether they'll free up** |

This principle ensures predictions are **conservative but reliable**: it's better to slightly underestimate available resources than to make optimistic assumptions about uncontrollable factors.

---

## 5. How Is "Available VRAM" Calculated?

Many users assume: "My GPU has 12 GB, so 12 GB is available." Not quite.

```
Available VRAM = (Free VRAM + PyTorch Cache) × 0.9
```

**Why multiply by 0.9?**

VRAM develops **fragmentation** during use. Like a parking lot that appears to have free spots — but they're all scattered small gaps that a large car (large model) can't fit into. The 0.9 factor accounts for this fragmentation loss.

**Why not subtract a "system reservation"?**

Because the memory used by the system and drivers is **already not reported as free** — the OS doesn't include its own allocation in the free VRAM figure. We don't need to manually deduct it.

On a 12 GB GPU, system and environment overhead typically consumes 2–3 GB, leaving roughly 8–9 GB actually available for models.

---

## 6. How Do the Two Constraints Affect Success Rate?

### Constraint 1: Hard Constraint — Can the Largest Model Fit in VRAM?

This is the **decisive factor**.

If the largest single model in your workflow (typically the main checkpoint — e.g., Flux Dev at ~9.8 GB) exceeds the available VRAM, the program will crash the moment it tries to load that model. No amount of RAM can save it.

This risk is modeled with an **exponential decay curve** — the more overflow, the steeper the drop:

```
0% overflow   → 100% success  (no problem at all)
10% overflow  → ~74% success  (risk begins)
30% overflow  → ~41% success  (significant risk)
50% overflow  → ~22% success  (likely to crash)
100% overflow → ~5% success   (almost certain failure)
```

Why exponential and not linear? Because VRAM overflow danger **accelerates** — a small overage may be absorbed by driver-level buffers, but a large overage has nothing left to save it.

#### Platform Differences: NVIDIA's "Overflow Tolerance"

The curve above applies to **Intel Arc**'s strict standard. For **NVIDIA** GPUs, the situation is quite different:

| Platform | Overflow Tolerance Factor | Actual Capability |
|----------|--------------------------|-------------------|
| Intel Arc | 1.0x | Strict hard constraint; exceeding VRAM often crashes |
| NVIDIA | 4.0x | CUDA UVM supports running with ~4x VRAM overflow |

**Why can NVIDIA run beyond VRAM?**

NVIDIA's CUDA driver has a **Unified Virtual Memory (UVM)** mechanism:
- Models don't need to stay fully resident in VRAM
- Driver automatically pages between VRAM and system RAM
- Slower, but the program won't crash

This means for the same 8 GB VRAM running a 20 GB model:
- **Intel Arc**: Success rate ≈ 5% (almost certain to crash)
- **NVIDIA**: Success rate ≈ 47% (runs, just slower)

The plugin automatically detects GPU type and applies the appropriate overflow tolerance factor.

---

### Constraint 2: Soft Constraint — Can All Models Cycle Through Memory?

This is the **stability factor**.

Even if the largest single model fits in VRAM, if your workflow has many models (lots of LoRAs, multiple checkpoint nodes), the total size may far exceed VRAM. The excess must cycle through system RAM — load one, use it, return it to RAM, load the next.

**Three scenarios:**

1. **Total size ≤ available VRAM**: Ideal. All models stay resident in VRAM. Success rate: 100%.

2. **Total exceeds VRAM, but overflow ≤ free RAM**: RAM can handle the cycling. Slower, but viable. Success rate: 70–100%.

3. **Even RAM is insufficient; virtual memory (disk) is needed**: Very slow, unstable. Success rate: 5–70%.

4. **Even virtual memory is insufficient**: Guaranteed failure. Success rate → 0%.

---

## 7. How Is the Final Success Rate Calculated?

```
Final Success Rate = Hard Constraint Rate × Soft Constraint Rate
```

Some examples:

| Scenario | Hard Constraint | Soft Constraint | Final |
|----------|----------------|----------------|-------|
| Lightweight workflow, all fits in VRAM | 100% | 100% | **100%** |
| Main model just fits; total slightly exceeds VRAM | 100% | 84% | **84%** |
| Main model slightly exceeds VRAM; RAM is ample | 74% | 100% | **74%** |
| Both constraints under pressure | 74% | 70% | **52%** |
| Main model severely exceeds VRAM | 22% | any | **≤22%** |

Key takeaway: **If the largest model can't fit in VRAM, the overall success rate collapses — no matter how much RAM you have.**

---

## 8. Further Reading

### 8.1 What Is VRAM Fragmentation?

VRAM fragmentation is a common memory management issue.

Imagine VRAM as a row of parking spots. As models come and go, gaps appear between occupied spaces. When a large model needs to be loaded, even if the total free space is sufficient, it may not have a **contiguous block** large enough — so the load fails.

PyTorch tries to reuse memory blocks, but fragmentation is inevitable after repeated model loads and unloads. Intel Arc's driver currently provides weaker defragmentation support than NVIDIA, so the 0.9 discount is a reasonable conservative estimate for Arc users.

### 8.2 What Is OOM (Out of Memory)?

OOM is the most common AI inference error:

```
torch.cuda.OutOfMemoryError: CUDA out of memory.
```

Or on Intel Arc:

```
RuntimeError: XPU out of memory.
```

When OOM occurs, the current inference task terminates immediately, and all intermediate results are lost.

**Common causes:**
- Model too large
- Resolution too high (high-res latent tensors consume significant VRAM)
- Batch size > 1
- Accumulated VRAM fragmentation (restarting ComfyUI often helps)

### 8.3 What Is Virtual Memory?

Virtual memory (Page File) is a Windows mechanism that temporarily writes memory contents to disk when physical RAM is exhausted.

For AI inference, virtual memory is a last resort — but extremely costly:
- **HDD**: ~100 MB/s read/write — loading a 10 GB model takes ~100 seconds
- **SSD**: ~500–3000 MB/s — usable but still painfully slow
- **NVMe SSD**: ~3000–7000 MB/s — sometimes viable with a lean workflow

This is why the algorithm assigns a low success rate (5–70%) to the virtual memory zone — avoid it whenever possible.

### 8.4 Intel Arc's Unified Memory Architecture

Unlike NVIDIA discrete GPUs, Intel Arc (especially mobile variants) uses a **Unified Memory Architecture (UMA)**, where CPU and GPU share the same physical memory pool.

This has an upside: when Arc's VRAM allocation is insufficient, the system can more naturally let models "overflow" into system memory, since they're part of the same pool. In practice, the soft constraint penalty may be slightly overstated for Arc users — making the algorithm a bit more conservative for them.

### 8.5 Model File Size vs. Actual VRAM Usage

The algorithm uses **disk file size** to estimate VRAM consumption. This is an approximation:

| Format | Precision | File Size vs. VRAM Usage |
|--------|-----------|--------------------------|
| `.safetensors` FP16 | Half precision | Roughly equal (most common) |
| `.safetensors` FP32 | Single precision | Roughly equal |
| `.gguf` Q4_K_M | 4-bit quantized | File much smaller than FP16 equivalent — **algorithm overestimates usage** |
| `.gguf` Q8 | 8-bit quantized | File ~half FP16 size — **algorithm overestimates usage** |

**Bottom line:** If you use quantized models (GGUF), actual VRAM usage is lower than estimated — the true success rate will be higher than displayed. This is a known conservative bias, and it errs on the safe side.

### 8.6 Why Isn't the Success Rate Either 100% or 0%?

Intuitively, a model either fits or it doesn't — shouldn't it be binary?

In practice, there are many fuzzy factors:

1. **Driver-level buffers**: GPU drivers have implicit memory management that can sometimes squeeze out a last-minute allocation before OOM triggers
2. **PyTorch memory pool**: PyTorch pre-reserves some VRAM as cache; it can be released in critical moments
3. **System state randomness**: Background processes vary over time — the same workflow on the same machine may succeed or fail depending on what else is running
4. **Model load order**: ComfyUI's node execution order can affect peak VRAM timing

Together, these factors make "borderline" scenarios genuinely probabilistic, not deterministic.

---

## 9. How to Use This Prediction

| Success Rate | Recommended Action |
|-------------|-------------------|
| ≥ 95% (Comfortable) | Run freely, no concerns |
| 80–95% (Safe) | Go ahead — occasional failure possible if background processes spike |
| 40–80% (Warning) | Close other memory-heavy apps, or consider reducing model precision |
| < 40% (Danger) | Strongly reduce the number of models in your workflow, or switch to lighter models |

**Practical tips for reducing memory pressure:**
- Use quantized models (GGUF Q4/Q8) instead of FP16
- Set unused nodes to `bypass` (the algorithm automatically excludes bypassed nodes)
- Close browsers, games, and other memory-heavy applications
- Restart ComfyUI to clear VRAM fragmentation
- If using multiple LoRAs, consider merging them into a single LoRA

---

*Related technical document: `predictor_algorithm.md`*
