# XPUSYS Monitor — 工作流成功率预测算法

> 文档版本：2026-03-16 Rev.2
> 对应实现：`web/xpu_monitor.js` → `calcPrediction()`

---

## 1. 设计前提

### 1.1 串行回收模型

ComfyUI 工作流以**采样节点**为核心关键节点，宏观上呈串行结构：

```
文本编码 (CLIP) → 卸载 → 扩散采样 (UNet) → 卸载 → 图像解码 (VAE)
```

由于模型在各阶段依次加载、用完即卸载，工作流不需要所有模型**同时驻留**显存。
这意味着：

- **显存瓶颈** = 单个最大模型（峰值占用），而非模型总量
- **内存（RAM）** 作为模型中转区，总量超出显存时可通过回收循环运行

### 1.2 核心设计原则：只计算 ComfyUI 可控的资源

ComfyUI 只能对**自己管理的资源**做预测，第三方占用（OS、驱动、浏览器、其他 GPU 程序）一律视为不可回收的固定成本：

| 资源 | 归属 | 处理方式 |
|------|------|----------|
| `vram_allocated_gb` | PyTorch 模型权重 | ✓ 计入可回收 |
| `vram_reserved_gb` | PyTorch 缓存池 | ✓ 计入可回收 |
| `vram_free_gb` | 当前空闲 | ✓ 直接可用 |
| `sysEnv`（驱动/桌面/第三方） | 系统与环境 | ✗ 永久占用，排除 |
| `ram_free_gb` | 当前空闲 RAM | ✓ 直接可用 |
| 其他进程占用的 RAM | 第三方 | ✗ 不可预期，排除 |

### 1.3 两个独立约束

| 约束 | 变量 | 性质 | 含义 |
|------|------|------|------|
| 硬约束 | $P_{peak}$ | 决定**能否运行** | 最大单模型必须能装入显存 |
| 软约束 | $P_{load}$ | 决定**稳定性** | 总量超出显存时能否通过内存中转 |

最终成功率：

$$P_{success} = P_{peak} \times P_{load}$$

---

## 2. 输入变量

### 2.1 来自工作流扫描

| 变量 | 说明 | 来源 |
|------|------|------|
| $M_{total}$ | 所有活跃模型的磁盘文件大小之和 (GB) | `_predModels` 累加 |
| $M_{peak}$ | 单个最大模型的磁盘文件大小 (GB) | `_predModels` 取最大值 |

### 2.2 来自系统快照（`snap`）

| 变量 | 字段 | 说明 |
|------|------|------|
| $V_{free}$ | `vram_free_gb` | 当前空闲显存 |
| $V_{alloc}$ | `vram_allocated_gb` | PyTorch 已分配（模型权重/激活值） |
| $V_{rsv}$ | `vram_reserved_gb` | PyTorch 预留缓存池 |
| $R_{free}$ | `ram_free_gb` | 当前空闲物理内存 |
| $C_{used}$ | `commit_used_gb` | 已提交虚拟内存 |
| $C_{limit}$ | `commit_limit_gb` | 虚拟内存上限 |

---

## 3. 常量参数

| 常量 | 值 | 含义 |
|------|----|------|
| $\alpha$ | 0.9 | 显存碎片化折扣 |

> **说明：** 原设计中的 $\beta_v$（显存安全缓冲）和 $\beta_r$（内存系统预留）已移除。
> `sysEnv` 占用已通过 $V_{reclaim}$ 公式精确排除，`ram_free_gb` 本身已是 OS 报告的真实空闲量，无需二次扣除。

---

## 4. 中间量计算

### 4.1 可回收显存

$$V_{reclaim} = V_{free} + V_{alloc} + V_{rsv}$$

- $V_{free}$：当前已空闲
- $V_{alloc} + V_{rsv}$：PyTorch 当前占用，工作流启动前会主动释放
- $sysEnv$（驱动/桌面）= $V_{total} - V_{reclaim}$，永久占用，**不参与计算**

### 4.2 有效显存上限

$$V_{eff} = \max(0.1,\ V_{reclaim} \times \alpha)$$

对 12 GB 显卡、当前空闲 9.49 GB、无模型加载时：
$$V_{eff} = 9.49 \times 0.9 = 8.54\ \text{GB}$$

### 4.3 可用物理内存

$$C_{ram} = R_{free}$$

`ram_free_gb` 是 OS 报告的真实空闲量，已排除所有当前进程占用，直接使用。

### 4.4 可用虚拟内存

$$S_{virt} = \max(0,\ C_{limit} - C_{used})$$

与状态栏内存胶囊的"虚拟内存"显示定义一致。

---

## 5. 硬约束：$P_{peak}$（显存峰值）

### 5.1 显存缺口

$$D_{peak} = \max(0,\ M_{peak} - V_{eff})$$

### 5.2 成功率

$$P_{peak} = \begin{cases}
1.0 & D_{peak} = 0 \\[6pt]
\max\!\left(0.02,\ e^{-3 \cdot D_{peak} / V_{eff}}\right) & D_{peak} > 0
\end{cases}$$

**曲线特性：**

| $D_{peak}$ | $P_{peak}$ |
|-----------|-----------|
| 0 GB（恰好装入） | 100% |
| $V_{eff} \times 0.1$（溢出 10%） | ≈ 74% |
| $V_{eff} \times 0.3$（溢出 30%） | ≈ 41% |
| $V_{eff} \times 0.5$（溢出 50%） | ≈ 22% |
| $V_{eff}$（溢出 100%） | ≈ 5% |

---

## 6. 软约束：$P_{load}$（总量负载）

### 6.1 负载缺口

$$D_{load} = \max(0,\ M_{total} - V_{eff})$$

### 6.2 分段成功率

$$P_{load} = \begin{cases}
1.0 & D_{load} = 0 \\[8pt]
1 - 0.3 \cdot \left(\dfrac{D_{load}}{C_{ram}}\right)^{0.6} & 0 < D_{load} \leq C_{ram} \\[12pt]
0.05 + 0.65 \cdot \left(1 - \dfrac{D_{load} - C_{ram}}{S_{virt}}\right)^{2} & C_{ram} < D_{load} \leq C_{ram} + S_{virt} \\[8pt]
\max\!\left(0,\ 0.05 - 0.1 \cdot (D_{load} - C_{ram} - S_{virt})\right) & D_{load} > C_{ram} + S_{virt}
\end{cases}$$

**连续性验证：**

- $D_{load} = C_{ram}$：第一段 $= 1 - 0.3 = 0.70$，第二段 $= 0.05 + 0.65 = 0.70$ ✓
- $D_{load} = C_{ram} + S_{virt}$：第二段 $= 0.05$，第三段起点 $= 0.05$ ✓

---

## 7. 综合成功率

$$P_{success} = \text{round}\!\left(P_{peak} \times P_{load} \times 100\right)$$

### 压力等级

| 等级 | 条件 | 颜色 | 中文 | English |
|------|------|------|------|---------|
| 轻松 | $P \geq 95\%$ | `#52c41a` | 轻松 | Smooth |
| 安全 | $80\% \leq P < 95\%$ | `#afff00` | 安全 | Safe |
| 预警 | $40\% \leq P < 80\%$ | `#faad14` | 预警 | Warning |
| 危险 | $P < 40\%$ | `#ff4d4f` | 危险 | Critical |

---

## 8. 已知局限

1. **模型大小用磁盘文件估算**，量化模型（GGUF Q4/Q8）实际显存占用远小于文件大小，算法会高估压力
2. **不感知工作流拓扑**，假设全串行；并行分支会使峰值估算偏低
3. **α = 0.9 为经验常量**，刚启动时碎片极少，长时间运行后碎片可能更高
4. **$M_{peak}$ 未考虑推理时的临时张量开销**（激活值、KV cache 等）
5. **第三方 GPU 程序**（浏览器 WebGL、游戏）占用的显存会被计入 sysEnv，导致可用量低估，但这是保守方向的偏差
