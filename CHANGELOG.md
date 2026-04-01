# Changelog

> 🌐 [English](#english) | [中文](#中文)

---

## English

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
