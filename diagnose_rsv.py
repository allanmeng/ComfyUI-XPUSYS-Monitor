"""RSV 诊断脚本 — 在模型加载前后分别输出 XPU 内存状态"""
import torch

idx = 0

def print_mem(label: str):
    a = torch.xpu.memory_allocated(idx)
    r = torch.xpu.memory_reserved(idx)
    print(f"[{label}]  allocated={a/1024**3:.3f}GB  reserved={r/1024**3:.3f}GB  (raw bytes: alloc={a}, reserv={r})")

print(f"torch.xpu.is_available() = {torch.xpu.is_available()}")
print(f"torch.__version__        = {torch.__version__}")
print()

print_mem("初始状态")

# 分配一小块张量模拟模型加载
x = torch.zeros(256, 256, 256, dtype=torch.float32, device="xpu")
print_mem("分配张量后")

# 清空缓存
torch.xpu.empty_cache()
print_mem("empty_cache 后")

del x
torch.xpu.empty_cache()
print_mem("释放张量 + empty_cache 后")

# 检查 torch.xpu.memory_stats 中有无额外信息
stats = torch.xpu.memory_stats(idx)
if stats:
    print(f"\nmemory_stats keys: {list(stats.keys())[:15]}...")
    for k in ["active_bytes.all.current", "reserved_bytes.all.current", "allocated_bytes.all.current"]:
        print(f"  {k} = {stats.get(k, 'N/A')}")
else:
    print("\nmemory_stats() 返回空，可能未启用统计")
