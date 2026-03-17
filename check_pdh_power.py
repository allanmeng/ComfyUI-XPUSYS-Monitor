"""
检测 Windows PDH 是否有 Intel Arc 的 GPU Power 计数器。
直接运行：python check_pdh_power.py
"""
import ctypes
import ctypes.wintypes
import time

PDH = ctypes.WinDLL("pdh.dll")

PDH_FMT_DOUBLE = 0x00000200
ERROR_SUCCESS   = 0

class PDH_FMT_COUNTERVALUE(ctypes.Structure):
    _fields_ = [("CStatus", ctypes.c_ulong),
                ("doubleValue", ctypes.c_double)]

def pdh_str(s):
    return ctypes.c_wchar_p(s)

def check_counters():
    query = ctypes.c_void_p()
    if PDH.PdhOpenQueryW(None, 0, ctypes.byref(query)) != ERROR_SUCCESS:
        print("PdhOpenQueryW failed")
        return

    # 候选计数器路径 — 逐个尝试
    candidates = [
        r"\GPU(*)\Power Usage",
        r"\GPU(*)\GPU Power",
        r"\GPU Adapter(*)\Power Usage",
        r"\GPU(*)\Power",
    ]

    found = []
    for path in candidates:
        h = ctypes.c_void_p()
        ret = PDH.PdhAddEnglishCounterW(query, pdh_str(path), 0, ctypes.byref(h))
        if ret == ERROR_SUCCESS:
            print(f"[OK]  {path}")
            found.append((path, h))
        else:
            print(f"[--]  {path}  (err={ret:#010x})")

    if not found:
        print("\n没有找到 GPU Power 计数器。")
        PDH.PdhCloseQuery(query)
        return

    # 采样两次
    PDH.PdhCollectQueryData(query)
    time.sleep(1.0)
    PDH.PdhCollectQueryData(query)

    print("\n--- 读数 ---")
    val = PDH_FMT_COUNTERVALUE()
    for path, h in found:
        ret = PDH.PdhGetFormattedCounterValue(h, PDH_FMT_DOUBLE, None, ctypes.byref(val))
        if ret == ERROR_SUCCESS:
            print(f"{path} => {val.doubleValue:.2f}")
        else:
            print(f"{path} => 读取失败 (err={ret:#010x})")

    PDH.PdhCloseQuery(query)

if __name__ == "__main__":
    check_counters()
