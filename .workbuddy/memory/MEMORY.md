# 项目长期记忆

## 项目信息
- 项目名：ComfyUI-XPUSYS-Monitor
- 仓库：https://github.com/allanmeng/ComfyUI-XPUSYS-Monitor
- 用户 GitHub：allanmeng

## Git 操作规则（重要）
- **本地操作**（commit、amend、文件修改等）→ 直接执行，无需确认
- **远端同步**（push、pull、fetch 等）→ 必须用户确认后才执行
- 多词 commit message 需用 Python subprocess 调用 git（直接在 shell 执行会报错）

## 打包规则
- 打包工具：用 Python zipfile 模块（PowerShell Compress-Archive 在此环境下静默失败）
- 打包脚本位置：`f:/ComfyUI-aki-v3/ComfyUI/custom_nodes/ComfyUI-XPUSYS-Monitor/pack_plugin.py`
- 模式：**白名单模式**（只打包明确列出的内容，避免测试文件误入）
- 白名单：__init__.py、xpu_server.py、pyproject.toml、requirements.txt、providers/、web/
- 压缩包结构：含 ComfyUI-XPUSYS-Monitor/ 主文件夹（解压后直接放入 custom_nodes/）
- 输出目录：F:\ 根目录
- 如生产环境新增需发布内容，在脚本 WHITELIST 列表中追加

## ComfyUI Manager 审核
- PR #2701 已合并至 Comfy-Org/ComfyUI-Manager（commit cbf8068）
- 等待 ltdrdata fork 同步（近期批量合并 90+ 插件）
- 同步后需更新 entry description（补充 AMD 支持说明）

## 已完成的主要功能
- bypass 节点检测修复（Object.defineProperty 监听 mode 属性）
- afterConfigureGraph 修复（加载工作流时对所有节点应用 hook）
- 添加 .pkl 后缀支持（RIFE 插帧模型）
- 添加搜索目录：mmaudio、audio、rife、vfi
- 添加 AMD GPU 支持（providers/amd.py，使用 rocm_smi）
- 打包脚本改为白名单模式（pack_plugin.py）

## AMD 支持实现细节（2026-03-31）
- 新增 providers/amd.py：使用 rocm_smi，回退到 torch.cuda 基础统计
- AMD/NVIDIA 区分方式：`torch.version.roc is not None` → AMD，否则 NVIDIA
  （比依赖 pynvml 失败更可靠，无需额外依赖）
- ROCm Windows 状态（2026-03 实测）：部分支持，通过 PyTorch 2.9+ 集成，
  完整 ROCm 软件栈仍需用户手动安装，rocm_smi 不随 PyTorch 包附带
- AMD 用户安装：`pip install rocm_smi_lib`（可选，未安装则降级为 torch 基础统计）

## AMD fallback 修复（2026-05-11）
- commit `a169f5b`（cherry-pick from `77c8afb`），已 push
- `_read_vram()`：rocm_smi 不可用时降级用 `torch.cuda.get_device_properties().total_memory` 获取显存总量
- `_read_device_name()`：rocm_smi 不可用时降级用 `torch.cuda.get_device_name()` 获取真实 GPU 型号
- 只影响 AMDProvider，Intel/NVIDIA 完全不受影响
- `torch.cuda` API 在 AMD ROCm PyTorch 下可用，无需额外依赖

## GPU 规格表 + SPEC 胶囊（2026-07-04）
- 新增 web/gpu_specs.json：77 张卡（NVIDIA 44 + AMD 10 + Intel 23），以 PCI ID 为索引
- 来源：blackwood.cv GPU AI Perf Assembly · PCI ID Repository · DeviceHunt
- Backend：三家 provider 各新增 _read_pci_id() 读取 PCI ID，通过 snapshot.pci_id 传给前端
  - Intel：从 device_name 提取 [0x...] 或 Level Zero 结构体
  - NVIDIA：pynvml.nvmlDeviceGetPciInfo().pciDeviceId & 0xFFFF
  - AMD：rocm_smi.getPciId(0)
- 前端新增 SPEC 胶囊：GPU 组第 5 个，显示 FP16/BF16 TFLOPS + 带宽，hover 展开全规格表
- 静态数据只在初始化时 fetch 一次，不轮询
- 缺口：NVIDIA Blackwell RTX 50 系列桌面版、Intel Arc A310 / Pro B65 / B70 的 PCI ID 未收录

## macOS 支持讨论
- Apple Silicon：统一内存架构，无独立 VRAM，GPU 监控 API 几乎空白
  - 可获取：CPU、RAM（psutil），MPS 显存分配（torch.mps）
  - 无法获取：GPU 利用率、温度、VRAM、功耗
- Intel Mac + NVIDIA：完整支持（同 Windows NV）
- 尚未实现，讨论阶段

