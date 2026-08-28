# Changelog

> 🌐 [English](#english) | [中文](#中文)

---

## English

### v1.0.8 — 2026-08-28

#### ✨ New Features

- **Spark Monitor panel** — a new `☰` capsule (independent, right after the GPU group) opens a draggable monitor window (ADLX-style header with teal-purple gradient):
  - **5 live sparkline charts**: GPU Load, VRAM Usage, Power, CPU Usage, Memory Usage — smooth Catmull-Rom curves, 2px colored lines, gradient area fill and glow, no axes / no data points, charts fill the box with the title overlaid (chip background) showing a live value (`GPU Load: 45%`).
  - **Per-chart critical alert**: when a metric crosses its threshold (load/VRAM/power > 95%, CPU > 80%, RAM > 90%), that box gains a unified translucent red background.
  - **Sampling follows the Refresh Interval setting** (~60s rolling window, points auto-scale).
  - **Settings → Spark Monitor → Order & Visibility**: toggle each chart on/off and drag `≡` to reorder — applies instantly, persisted across restarts.
  - **Smart positioning**: first open anchors to the capsule (left-aligned, opens above/below by screen half); after dragging, position is saved to `localStorage` and restored on reload.
  - Window subtitle shows the full GPU name (ID stripped) + refresh interval.
  - Fully bilingual (EN/CN).
- **PWR admin notice is Intel-only + English**: the `🔒` "requires administrator" notice now only appears on Intel GPUs (AMD/NVIDIA power needs no elevation — unavailability there is a driver capability issue) and the alert is translated.

#### 🐛 Bug Fixes

- *(no backend changes in this release)*

---

### v1.0.7.1 — 2026-08-28

#### 🐛 Bug Fixes

- **AMD misdetected as NVIDIA on new ROCm PyTorch (2.14+)**: On PyTorch builds such as `2.14.0+rocm10.1`, `torch.version.roc` is `None` (the marker moved to `torch.version.hip`), so AMD ROCm machines with a usable `torch.cuda` fell into `NvidiaProvider` — PWR stayed empty (no NVML) and SPEC had no AMD device identity.
  - Fix: `_is_amd_rocme()` now accepts either marker — `torch.version.roc` (classic builds) or `torch.version.hip` (2.14+ builds). AMD machines now correctly reach `AMDProvider` and, on Windows, the ADLX telemetry path (power included).

---

### v1.0.7 — 2026-08-28

#### ✨ New Features

- **AMD dual-platform telemetry**: AMD GPUs are now fully supported on both Windows and Linux.
  - **Windows (ADLX)**: New primary path via `ADLXPybind` (AMD official SDK) — GPU load, clock, temperature, VRAM, and power draw, no admin required. Declared as a conditional dependency: `ADLXPybind; platform_system == "Windows"`. The call pattern (GetSupportedGPUMetrics capability pre-checks + GetCurrentGPUMetrics) follows the proven implementation from ComfyUI-ADLX-Monitor; only the telemetry extraction is shared, the UI stays native.
  - **Linux / ROCm (amdsmi)**: New primary path via `amdsmi` (official successor to the deprecated `rocm_smi_lib`) — device name, VRAM, load, temperature, power, and clock through `amdsmi_get_gpu_*`. Legacy `rocm_smi` remains as a compatibility fallback for old environments.
  - **Detection chain**: `torch.cuda+ROCm → NVIDIA → ADLX (Windows) → amdsmi/hip/sysfs (Linux) → Intel → fallback`. The new Linux AMD probe (`_detect_amd_linux`, three independent signals: amdsmi enumeration, `torch.version.hip`, `/sys/class/drm` vendor 0x1002) sits before the Intel tier, so an AMD dGPU is no longer shadowed by an Intel iGPU (fixes issue #5: RX 9070 XT + Ultra 7 265K misdetected as iGPU).
  - **Multi-GPU**: ADLX `GetGPUs()` and amdsmi processor-handle lists both back `select_device()`; thread-safe via `_hw_lock`.
  - **PCI ID via ADLX**: `_read_pci_id()` now tries `IADLXGPU::DeviceId()` (manufacturer-programmed 4-digit hex device ID) with several binding-name candidates; when unavailable, the frontend `matchSpecByName` fallback still resolves the SPEC capsule.

#### 🔧 Improvements

- **Tooltip polish** (all capsules): floating panels narrowed (min-width 220→190px, capped at 320px) with `pre-wrap` so long source lines wrap; font sizes reduced (body 16→14px, title 17→15px, source 13→12px); sub-item indentation switched from leading spaces (broken by `white-space: nowrap`) to a dedicated `sub` parameter + CSS `padding-left`.
- **Source visibility**: only the PRED and SPEC panels keep their "Source/来源" footnote; all other capsules hide it.
- **Predictor capsule text**: reordered to `成功率:xx% | 状态 | 模型:xxG/xxG` (success rate first, matching the panel order); risk label font size aligned with the rest of the capsule.
- **Predictor panel order**: conclusion first (success rate), then hard constraint (peak model), soft constraint (total models), available resources, and calculation parameters at the bottom — grouped with divider lines.
- **CPU model name**: ` CPU @ 2.90GHz` suffix stripped from the model row (frequency already has its own row).
- **VRAM panel labels**: shortened to 显示与驱动占用 / 模型加载运算占用 / Pytorch预占用 (Display & Driver Usage / Model Load & Compute Usage / PyTorch Pre-allocated); long model names truncate at 24 chars with `…`.

---

#### ✨ New Features

- **Light theme support**: The plugin now follows ComfyUI's active colour palette automatically.
  - Detects the current theme via the `Comfy.ColorPalette` setting (with `body` class fallback) and re-applies colours whenever it changes (MutationObserver + polling fallback).
  - Light palettes (Light, Milk White / `milk_white`, `mikey`) get a dedicated light colour scheme; all others remain dark.
  - All hard-coded colours refactored into CSS variables — `:root` holds dark defaults, `html[data-xpusys-theme="light"]` overrides them. Status colours are darkened on light backgrounds to keep contrast.
  - Settings panel gains a read-only **Plugin Colour Theme** item showing the current dark/light state and the active ComfyUI palette id.

- **Multi-GPU monitoring selection**: On multi-GPU systems you can now pick which GPU to monitor.
  - Settings → GPU Monitor → **Monitored GPU** dropdown lists all visible GPUs; switching updates the status bar instantly and the choice persists across restarts.
  - By default the plugin follows ComfyUI's primary device (the `Device: xpu:N` shown in the startup log) via `torch.xpu.current_device()`; a manual choice overrides it and is remembered.
  - Backend: `BaseGPUProvider` gained `device_count()` / `get_device_names()` / `get_selected_device()` / `select_device()`. Intel rebinds Level Zero handles on switch; NVIDIA/AMD have ready implementations (untested).
  - New API routes: `GET /xpusys/devices` and `POST /xpusys/select`.
  - Thread-safety: a hardware lock (`_hw_lock`) serialises device switching against the polling thread so snapshots never read a mid-switch state.

#### 🐛 Bug Fixes

- **SPEC capsule showing `--` on Intel Arc A770**: The PCI device ID was never read on Alchemist (A-series) GPUs, so the specs lookup fell through to empty.
  - Root cause: `device_name` on A770 has no `[0x...]` suffix (B580 does), so the regex extraction failed; the fallback then read the Sysman struct `zes_device_properties_t` at offset 24 (which is `coreName`, a string) as if it were the Core struct `ze_device_properties_t` (where offset 24 is `deviceId`) — always producing an invalid ID.
  - Fix: the fallback now calls the Core API `zeDeviceGetProperties` (extracted as `_read_pci_id_core()`) so `deviceId` at offset 24 is correct.
  - Frontend resilience: `resolveSpec()` now falls back to matching by `device_name` across the whole specs table (`matchSpecByName`), so the SPEC capsule works even when the PCI ID cannot be read.

#### 🔧 Improvements

- **TGP read is table-independent**: Confirmed power/TGP data comes directly from the Level Zero Sysman power domains (`zesPowerGetProperties`), not the specs table — so PWR works even when SPEC has no match.

---

### v1.0.5 — 2026-07-18

#### 🐛 Bug Fixes

- **GPU frequency reading fixed**: The GPU clock display was showing incorrect values (~1000 MHz) on Intel Arc B580 due to wrong `zes_freq_state_t` field offsets in the Level Zero Sysman ctypes code.
  - Root cause: Code was reading 4 fields at offsets +16/+24/+32/+40 but labeled them incorrectly.
  - Actual struct layout (verified via pyzes.py v0.1.2): `currentVoltage@+16 | request@+24 | tdp@+32 | efficient@+40 | actual@+48`
  - What changed: Now reads 5 fields at their correct offsets. The `actual` field (offset 48) is the **real resolved frequency** — confirmed to match Intel's own monitoring tool exactly:
    - Idle: 400 MHz  ·  Under load: 2850 MHz (Arc B580)
  - The old strategy was picking the driver target P-state (`request` field, e.g., 4250 MHz), which is not the actual running clock.
  - Removed the now-unnecessary `_norm()` unit-conversion helper.
  - Affects Intel Arc discrete GPUs (B580, A770, etc.) and likely iGPUs (B390/Lunar Lake). Tested on B580.

#### 🔧 Improvements

- **Voltage read unlocked**: `read_gpu_freq_mhz()` now also reads the `currentVoltage` field from Level Zero (not shown in UI, but available for future use).

---

### v1.0.4 — 2026-07-04

#### ✨ New Features

- **GPU Specs capsule (SPEC)**: New 5th GPU capsule displaying theoretical compute and bandwidth specs for NVIDIA, AMD, and Intel Arc GPUs.
  - Capsule shows: `SPEC FP16 xxxT xxxGB/s` (highlighted in blue)
  - Hover tooltip reveals full spec sheet: VRAM, bandwidth, TGP, FP32, FP16, BF16, FP8, FP4, INT8, INT4 with format support matrix per architecture
  - Source data from [Blackwood's Blog - GPU AI Perf Assembly](https://blog.blackwood.cv/posts/gpu-ai-perf-assembly/)
  - Direct blog values marked `(Official)`; estimated values from known ratios marked `(Est.)`
  - Unsupported formats displayed as "不支持", unknown as "未知"
  - Toggle on/off via Settings → GPU Monitor → GPU Specs

- **PCI ID database**: Added `web/gpu_specs.json` with 96 card entries (74 PCI IDs) covering NVIDIA Pascal through Blackwell, AMD RDNA 1.0–4.0, Intel Arc A/B-series.
  - PCI ID verified from PCI ID Repository / DeviceHunt / linux-hardware.org
  - Multi-entry support for shared PCI IDs (AMD Navi chips with multiple SKUs)
  - Name-based fallback matching for cards without known PCI IDs

#### 🔧 Improvements

- **Backend PCI ID**: Added `pci_id` field to `GPUSnapshot` — each provider reads the PCI device ID via its native API:
  - Intel: Level Zero properties struct or `[0x...]` regex from device name
  - NVIDIA: `nvmlDeviceGetPciInfo().pciDeviceId & 0xFFFF`
  - AMD: `rocm_smi.getPciId(0)`
- **PRED label shortened**: "预测工作流执行成功率" → "预测成功率"
- **GPU specs database**: Served via `/xpusys/specs` HTTP endpoint with in-memory cache

---

### v1.0.3 — 2026-05-14

#### 🐛 Bug Fixes

- **RSV capsule color fix for PyTorch 2.12+**: In PyTorch 2.12, the XPU caching allocator was changed to aggressively release reserved memory back to the driver when tensors are freed — `torch.xpu.memory_reserved()` now returns 0 after a workflow completes (previously it kept a cached pool visible as RSV). The RSV capsule no longer uses the dim gray "N/A" color for this state, but instead shows with the default theme text color, making it clear the display is active and the value is simply 0.

  | Behavior | PyTorch &lt; 2.12 | PyTorch 2.12+ |
  |----------|-------------------|---------------|
  | Workflow finishes → `memory_reserved()` | Keeps a cached free pool (e.g. 4+ GB visible as RSV) | Returns memory to driver immediately; RSV = 0 |
  | `memory_allocated` vs `memory_reserved` | Allocated ≪ Reserved (large unused buffer) | Allocated ≈ Reserved (tight, no waste) |
  | `empty_cache()` after `del tensor` | Releases cached pool, reserved drops | No-op on active tensors (already minimal) |
  | Effective VRAM usage | More reserved than needed (waste) | More efficient — reserved = allocated |

#### 🔧 Improvements

- **Badge version synced**: JS version constant updated from 1.0.1 to 1.0.3 to match pyproject.toml

---

### v1.0.2 — 2026-04-01

#### ✨ New Features

- **AMD GPU support**: Added `AMDProvider` for AMD GPUs running ROCm PyTorch.
  - Full support for VRAM, GPU load, temperature, power, and clock frequency via `rocm_smi`
  - Graceful fallback to basic `torch.cuda` stats when `rocm_smi_lib` is not installed
  - Optional dependency: `pip install rocm_smi_lib`

#### 🔧 Improvements

- **Provider auto-detection**: Upgraded detection logic to use `torch.version.roc` for reliable AMD vs NVIDIA disambiguation — no longer depends on `pynvml` failure as a side-effect signal
- **Package script**: Switched to whitelist mode (`pack_plugin.py`) — only explicitly listed files/directories are included, preventing dev/test scripts from leaking into releases

#### 🖥️ Platform Support Update

- AMD (ROCm) support status changed from *planned* to **fully supported**

---

### v1.0.1 — 2026-03-28

#### 🔧 Improvements

- **Model detection**: Removed node-type-based inference; now uses path-based lookup across all model directories for better compatibility with custom loaders (GGUF, etc.)
- **Subfolder support**: Models in subdirectories (e.g., `unet/subfolder/model.gguf`) are now correctly detected
- **Performance**: Optimized model lookup with prioritized directory search and fallback recursion

#### 🐛 Bug Fixes

- Fixed model size detection for nodes like `GGUFLoaderKJ` that don't follow standard naming conventions

---

### v1.0.0 — 2026-03-17

First stable release.

#### ✨ Features

- **Seven-capsule status bar** embedded in the ComfyUI top menu bar — PRED, CPU, RAM, GPU, VRAM, RSV, PWR — each expandable via hover
- **PRED — Workflow VRAM Predictor**: scans active model nodes, estimates peak VRAM demand and total load, outputs a composite success rate (hard constraint × soft constraint) before you run
- **GPU Engine** (load %, core clock, temperature)
- **VRAM** with three-layer breakdown: System & Environment / Models & Compute / Reserved Buffer
- **RSV** — PyTorch cache pool (active vs idle split)
- **PWR** — instantaneous power draw via dual-sample energy delta, with TGP load ratio; lock icon + tooltip when admin is not available
- **CPU** (utilization, real-time clock, model name, thread count)
- **RAM** (physical + virtual memory, used / free)
- Settings panel: refresh interval, font size, language (中文 / English / system), per-capsule show/hide toggles
- Version badge and GitHub link in the About section of settings

#### 🖥️ Platform Support

- **Intel Arc (XPU)** — Level Zero Sysman; full support for power, frequency, and temperature (admin required on Windows)
- **NVIDIA (CUDA)** — pynvml; full support without elevated privileges
- **AMD (ROCm)** — added in v1.0.2

#### 🗂️ PCI ID Table (Intel Arc)

Covers all consumer and workstation cards with practical AI inference capability (≥ 8 GB VRAM or Pro series):

| Series | Models |
|--------|--------|
| Battlemage consumer | B770, B580, B580M, B570, B570M |
| Battlemage Pro | Arc Pro B60 (24 GB), Arc Pro B50 (16 GB) |
| Alchemist consumer desktop | A770, A750, A580, A380 |
| Alchemist consumer mobile | A770M, A730M, A570M, A550M, A530M |
| Alchemist Pro | Arc Pro A60, Arc Pro A60M, Arc Pro A40/A50, Arc Pro A30M |

Low-end consumer cards (A310, A370M, A350M) and the embedded E-series are excluded — they have insufficient VRAM for practical AI workloads.

---

## 中文

### v1.0.8 — 2026-08-28

#### ✨ 新功能

- **火花监控面板**——新增独立 `☰` 胶囊（位于 GPU 组之后），点击弹出可拖动监控窗口（ADLX 风格头部：青紫渐变）：
  - **5 张实时时序图**：GPU 负载、显存占用、功耗、CPU 占用、内存占用——平滑曲线（Catmull-Rom）、2px 彩色折线、渐变面积填充 + 微光、无坐标轴/无数据点；图撑满 box，标题悬浮左上角（chip 背景）并实时显示数值（`GPU 负载：45%`）。
  - **逐图临界告警**：指标达阈值（负载/显存/功耗 >95%、CPU >80%、内存 >90%）时该 box 出现统一半透明红背景。
  - **采样跟随"刷新间隔"设置**（约 60 秒滚动窗口，点数自动适配）。
  - **设置 → 火花监控 → 排序与显示**：每项可开关，按住 `≡` 上下拖拽排序——即时生效、重启保持。
  - **智能定位**：首次打开对齐 ☰ 胶囊（左缘对齐，按屏幕上下半区智能弹出）；拖动后位置存入 `localStorage`，刷新恢复。
  - 窗口副标题显示显卡全名（去 ID）+ 刷新间隔。
  - 完整中英双语。
- **PWR 管理员提示仅 Intel 且补英文**：`🔒`「需要管理员权限」提示现在只在 Intel 显卡上出现（AMD/NVIDIA 功耗读取无需提权——不可用属于驱动能力问题），提示内容补齐英文版。

#### 🐛 Bug 修复

- *（本版本无后端改动）*

---

### v1.0.7.1 — 2026-08-28

#### 🐛 Bug 修复

- **新版 ROCm PyTorch（2.14+）上 AMD 被误判为 NVIDIA**：在 `2.14.0+rocm10.1` 等新构建中 `torch.version.roc` 为 `None`（标记迁移到了 `torch.version.hip`），导致 torch.cuda 可用的 AMD ROCm 机器落入 `NvidiaProvider`——PWR 为空（无 NVML）且 SPEC 读不到 AMD 设备标识。
  - 修复：`_is_amd_rocme()` 同时接受任一标记——`torch.version.roc`（经典构建）或 `torch.version.hip`（2.14+ 构建）。AMD 机器现在能正确进入 `AMDProvider`，并在 Windows 上走 ADLX 遥测路径（含功耗）。

---

### v1.0.7 — 2026-08-28

#### ✨ 新功能

- **AMD 双平台遥测**：AMD 显卡在 Windows 和 Linux 上均获得完整支持。
  - **Windows（ADLX）**：新增首选路径，通过 `ADLXPybind`（AMD 官方 SDK）获取负载、频率、温度、显存与功耗，无需管理员权限。声明为条件依赖：`ADLXPybind; platform_system == "Windows"`。调用模式（GetSupportedGPUMetrics 能力预检 + GetCurrentGPUMetrics 读值）参考自 ComfyUI-ADLX-Monitor 的成熟实现——仅共享遥测提取，界面保持本项目原生。
  - **Linux / ROCm（amdsmi）**：新增首选路径，通过 `amdsmi`（官方继任者，替代已废弃的 `rocm_smi_lib`）获取设备名、显存、负载、温度、功耗与频率（`amdsmi_get_gpu_*`）。旧 `rocm_smi` 保留为老环境兼容兜底。
  - **检测链**：`torch.cuda+ROCm → NVIDIA → ADLX(Windows) → amdsmi/hip/sysfs(Linux) → Intel → fallback`。新增 Linux AMD 探测（`_detect_amd_linux`，三层独立信号：amdsmi 枚举、`torch.version.hip`、`/sys/class/drm` vendor 0x1002），位于 Intel 层之前——AMD 独显不再被 Intel 核显遮蔽（修复 issue #5：RX 9070 XT + Ultra 7 265K 被误判为核显）。
  - **多 GPU**：ADLX `GetGPUs()` 与 amdsmi 处理器句柄列表均支持 `select_device()` 运行时切换；`_hw_lock` 保证线程安全。
  - **ADLX 读取 PCI ID**：`_read_pci_id()` 现在尝试 `IADLXGPU::DeviceId()`（出厂预置的 4 位十六进制设备 ID），兼容多种绑定方法名；读不到时前端 `matchSpecByName` 名称兜底仍能解析 SPEC 胶囊。

#### 🔧 改进

- **浮层样式打磨**（所有胶囊）：下拉面板收窄（min-width 220→190px，上限 320px），`pre-wrap` 允许来源长行折行；字号整体缩小（主体 16→14px、标题 17→15px、来源 13→12px）；子条目缩进从"前导空格"（被 `white-space: nowrap` 折叠失效）改为专用 `sub` 参数 + CSS `padding-left`。
- **来源显示策略**：仅 PRED 与 SPEC 浮层保留「来源/数据来源」注脚，其余胶囊全部隐藏。
- **预测胶囊文字**：重排为 `成功率:xx% | 状态 | 模型:xxG/xxG`（成功率置前，与浮层顺序呼应）；风险标签字号与胶囊其他文字对齐。
- **预测浮层顺序**：结论置前（成功率）→ 硬约束（峰值模型）→ 软约束（模型总量）→ 可用资源 → 计算参数沉底，分隔线分组。
- **CPU 型号**：型号行去掉 ` CPU @ 2.90GHz` 后缀（频率已有独立一行）。
- **VRAM 浮层文案**：精简为 显示与驱动占用 / 模型加载运算占用 / Pytorch预占用（英文对应 Display & Driver Usage / Model Load & Compute Usage / PyTorch Pre-allocated）；长模型名超 24 字符截断加 `…`。

---

#### ✨ 新功能

- **浅色主题支持**：插件配色自动跟随 ComfyUI 当前色彩主题。
  - 通过 `Comfy.ColorPalette` 设置检测当前主题（body class 兜底），主题变化时自动重新应用配色（MutationObserver + 轮询兜底）。
  - 浅色主题（Light、Milk White / `milk_white`、`mikey`）使用专属浅色配色，其余主题保持深色。
  - 全部硬编码颜色重构为 CSS 变量——`:root` 为深色默认，`html[data-xpusys-theme="light"]` 覆盖为浅色。浅色下状态色自动加深以保证对比度。
  - 设置面板新增只读项「插件色彩主题」，显示当前深/浅色状态与 ComfyUI 主题 id。

- **多 GPU 监视选择**：多卡环境下可选择监视哪张显卡。
  - 设置 → 显卡监控 → **监视显卡** 下拉列出所有可见显卡；切换后状态栏立即更新，选择跨重启保持。
  - 默认跟随 ComfyUI 主设备（启动日志中的 `Device: xpu:N`），通过 `torch.xpu.current_device()` 获取；手工选择后优先记住用户选择。
  - 后端：`BaseGPUProvider` 新增 `device_count()` / `get_device_names()` / `get_selected_device()` / `select_device()`。Intel 切换时重绑定 Level Zero 句柄；NVIDIA/AMD 已有实现（未测试）。
  - 新增 API：`GET /xpusys/devices` 和 `POST /xpusys/select`。
  - 线程安全：硬件锁 `_hw_lock` 使设备切换与轮询线程互斥，快照不会读到切换中间状态。

#### 🐛 Bug 修复

- **Intel Arc A770 上 SPEC 胶囊显示 `--`**：Alchemist（A 系列）显卡的 PCI 设备 ID 从未被正确读取，导致规格查询落空。
  - 根本原因：A770 的 `device_name` 不带 `[0x...]` 后缀（B580 带），regex 提取失败；兜底逻辑又按 Core 结构 `ze_device_properties_t`（offset 24 是 `deviceId`）去解析 Sysman 结构 `zes_device_properties_t`（offset 24 是 `coreName` 字符串）——必然读到无效值。
  - 修复：兜底改用 Core API `zeDeviceGetProperties`（抽出为 `_read_pci_id_core()`），offset 24 读取的 `deviceId` 正确。
  - 前端加固：`resolveSpec()` 新增按 `device_name` 在整个规格表内匹配的兜底（`matchSpecByName`），即使 PCI ID 读不到也能显示 SPEC 胶囊。

#### 🔧 改进

- **TGP 读取不依赖规格表**：确认功率/TGP 数据直接来自 Level Zero Sysman 的 power domain（`zesPowerGetProperties`），而非规格表——因此即使 SPEC 无匹配，PWR 也能正常显示。

---

### v1.0.5 — 2026-07-18

#### 🐛 Bug 修复

- **GPU 频率显示修复**：Intel Arc B580 上 GPU 频率显示不正确（~1000 MHz），原因是 Level Zero Sysman ctypes 代码中 `zes_freq_state_t` 字段偏移量错误。
  - 根本原因：代码在 +16/+24/+32/+40 偏移处读了 4 个 `c_double` 字段，但标注错误。
  - 真实结构（经 pyzes.py v0.1.2 验证）：`currentVoltage@+16 | request@+24 | tdp@+32 | efficient@+40 | actual@+48`
  - 修正内容：现在按正确偏移读取 5 个字段。`actual`（偏移 +48）是 **实际决议频率**，与 Intel 官方监视器数值完全吻合：
    - 待机：400 MHz  ·  满载：2850 MHz（Arc B580）
  - 旧策略选择了驱动目标 P-state（`request` 字段，如 4250 MHz），并不是实际运行时钟。
  - 移除了不再需要的 `_norm()` 单位转换辅助函数。
  - 影响范围：Intel Arc 独显（B580、A770 等）及可能受影响核显（B390/Lunar Lake）。已在 B580 上测试验证。

#### 🔧 改进

- **电压数据支持**：`read_gpu_freq_mhz()` 现在同时读取 `currentVoltage` 字段（尚未在前端展示，预留给未来使用）。

### v1.0.4 — 2026-07-04

#### ✨ 新功能

- **GPU 规格胶囊（SPEC）**：新增第 5 个 GPU 胶囊，展示 NVIDIA、AMD、Intel Arc 显卡的理论算力与带宽规格。
  - 胶囊显示：`SPEC FP16 xxxT xxxGB/s`（蓝色高亮）
  - Hover 浮层展开完整规格表：显存、带宽、TGP、FP32、FP16、BF16、FP8、FP4、INT8、INT4，按架构标注格式支持矩阵
  - 数据来源：[Blackwood's Blog - GPU AI Perf Assembly](https://blog.blackwood.cv/posts/gpu-ai-perf-assembly/)
  - 博客直接数据标注 `(官方)`；通过已知比率推算的标注 `(推测)`
  - 不支持的格式显示"不支持"，未知的显示"未知"
  - 可在设置 → 显卡监控 → GPU规格 中开关

- **PCI ID 数据库**：新增 `web/gpu_specs.json`，收录 96 个卡条目（74 个 PCI ID），覆盖 NVIDIA Pascal~Blackwell、AMD RDNA 1.0~4.0、Intel Arc A/B 全系。
  - PCI ID 来源：PCI ID Repository / DeviceHunt / linux-hardware.org 验证
  - 共享 PCI ID 支持多条匹配（AMD Navi 芯片多 SKU）
  - 未知 PCI ID 的卡通过名称模糊匹配兜底

#### 🔧 改进

- **后端 PCI ID**：`GPUSnapshot` 新增 `pci_id` 字段，各家 provider 通过原生 API 读取：
  - Intel：从 Level Zero properties 结构体或 device_name 中的 `[0x...]` 提取
  - NVIDIA：`nvmlDeviceGetPciInfo().pciDeviceId & 0xFFFF`
  - AMD：`rocm_smi.getPciId(0)`
- **PRED 标签缩短**："预测工作流执行成功率" → "预测成功率"
- **GPU 规格数据库**：通过 `/xpusys/specs` HTTP 端点提供，内存缓存

#### 🐛 Bug 修复

- **修复 PyTorch 2.12+ RSV 胶囊显示问题**：PyTorch 2.12 的 XPU 缓存分配器行为发生变化——张量释放后缓存池立即归还驱动，不再保留空闲预留内存（此前工作流结束后 RSV 会显示数 GB 的缓存池容量）。RSV 胶囊不再为此状态使用暗灰色"未生效"样式，而是使用主题默认文字颜色，表示"正在正常监控，当前值为 0"。

  | 行为 | PyTorch &lt; 2.12 | PyTorch 2.12+ |
  |------|------------------|---------------|
  | 工作流结束 → `memory_reserved()` | 保留空闲缓存池（RSV 显示 4+ GB）| 立即归还驱动，RSV = 0 |
  | `memory_allocated` vs `memory_reserved` | Allocated ≪ Reserved（大量未使用缓存）| Allocated ≈ Reserved（紧凑、无浪费）|
  | `empty_cache()` 在 `del tensor` 后 | 释放缓存池，reserved 下降 | 对活动张量无影响（已最小化）|
  | 有效显存利用率 | 预留多于实际需要（浪费）| 更高效——预留 ≈ 已分配 |

#### 🔧 改进

- **版本号同步**：JS 徽章版本号从 1.0.1 更新至 1.0.3，与 pyproject.toml 保持一致

---

### v1.0.2 — 2026-04-01

#### ✨ 新功能

- **AMD 显卡支持**：新增 `AMDProvider`，支持运行 ROCm 版 PyTorch 的 AMD 显卡。
  - 通过 `rocm_smi` 完整支持显存、GPU 负载、温度、功耗及核心频率
  - 未安装 `rocm_smi_lib` 时，自动降级为 `torch.cuda` 基础统计
  - 可选依赖：`pip install rocm_smi_lib`

#### 🔧 改进

- **Provider 自动检测**：升级检测逻辑，使用 `torch.version.roc` 可靠区分 AMD 与 NVIDIA，不再依赖 `pynvml` 报错作为旁路信号
- **打包脚本**：改为白名单模式（`pack_plugin.py`），只打包明确列出的文件/目录，避免开发/测试脚本混入发布包

#### 🖥️ 平台支持更新

- AMD（ROCm）支持状态由"计划中"变更为**正式支持**

---

### v1.0.1 — 2026-03-28

#### 🔧 改进

- **模型检测**：移除基于节点类型的推断逻辑，改为基于路径在所有模型目录中查找，兼容更多自定义加载器（GGUF等）
- **子文件夹支持**：正确检测子文件夹中的模型（如 `unet/子文件夹/model.gguf`）
- **性能优化**：优化模型查找逻辑，采用优先级目录搜索 + 递归兜底策略

#### 🐛 Bug 修复

- 修复 `GGUFLoaderKJ` 等不遵循标准命名规范的节点的模型大小检测问题

---

### v1.0.0 — 2026-03-17

首个正式稳定版本。

#### ✨ 功能特性

- **七胶囊状态栏**，嵌入 ComfyUI 顶部菜单栏，包含 PRED、CPU、RAM、GPU、VRAM、RSV、PWR，鼠标悬停可展开详情面板
- **PRED — 工作流显存预测**：扫描当前工作流所有活跃模型节点，预测峰值显存需求与总负载，在运行前输出综合成功率（硬约束 × 软约束）
- **GPU 引擎**（负载率、核心频率、温度）
- **VRAM** 三层分解：系统与环境 / 模型与计算 / 预留缓冲区
- **RSV** — PyTorch 缓存池（活跃占用与空闲缓存拆分显示）
- **PWR** — 双采样能量差值法实时功耗，带 TGP 负载比例；无管理员权限时显示锁图标并提供说明
- **CPU**（占用率、实时主频、型号、线程数）
- **RAM**（物理内存 + 虚拟内存，已用 / 空闲）
- 设置面板：刷新间隔、字体大小、界面语言（中文 / English / 跟随系统）、各胶囊显示/隐藏开关
- 设置页"关于"区域展示版本号徽章和 GitHub 跳转按钮

#### 🖥️ 平台支持

- **Intel Arc (XPU)** — 基于 Level Zero Sysman，完整支持功耗、频率、温度（Windows 下需管理员权限）
- **NVIDIA (CUDA)** — 基于 pynvml，完整支持，无需提权
- **AMD (ROCm)** — v1.0.2 中正式加入

#### 🗂️ PCI ID 表（Intel Arc）

覆盖所有具备实际 AI 推理能力的消费级与专业卡（显存 ≥ 8 GB 或 Pro 系列）：

| 系列 | 型号 |
|------|------|
| Battlemage 消费级 | B770、B580、B580M、B570、B570M |
| Battlemage Pro 专业卡 | Arc Pro B60（24 GB）、Arc Pro B50（16 GB）|
| Alchemist 消费级桌面 | A770、A750、A580、A380 |
| Alchemist 消费级移动 | A770M、A730M、A570M、A550M、A530M |
| Alchemist Pro 专业卡 | Arc Pro A60、Arc Pro A60M、Arc Pro A40/A50、Arc Pro A30M |

低端消费卡（A310、A370M、A350M）及嵌入式 E 系列已移除，因其显存不足以支撑实际 AI 工作负载。
