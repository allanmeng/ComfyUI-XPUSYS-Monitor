"""
测试 Intel Graphics Control Library (IGCL / ControlLib.dll) 读取功率。
参考: https://github.com/intel/drivers.gpu.control-library
"""
import ctypes
import ctypes.wintypes
import time

lib = ctypes.WinDLL("C:/Windows/System32/ControlLib.dll")

# ---------------------------------------------------------------------------
# 基础类型
# ---------------------------------------------------------------------------

# GUID / ctl_application_id_t
class CTL_APP_ID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_uint32),
        ("Data2", ctypes.c_uint16),
        ("Data3", ctypes.c_uint16),
        ("Data4", ctypes.c_uint8 * 8),
    ]

class CTL_VERSION(ctypes.Structure):
    _fields_ = [
        ("major", ctypes.c_uint32),
        ("minor", ctypes.c_uint32),
        ("patch", ctypes.c_uint32),
    ]

class CTL_INIT_ARGS(ctypes.Structure):
    _fields_ = [
        ("Size",             ctypes.c_uint32),
        ("Version",          ctypes.c_uint8),
        ("_pad",             ctypes.c_uint8 * 3),
        ("AppVersion",       CTL_APP_ID),
        ("flags",            ctypes.c_uint32),
        ("SupportedVersion", CTL_VERSION),
    ]

# ctl_oc_telemetry_item_t
class CTL_TELEMETRY_ITEM(ctypes.Structure):
    _fields_ = [
        ("value",    ctypes.c_double),
        ("units",    ctypes.c_uint32),
        ("type",     ctypes.c_uint32),
        ("flags",    ctypes.c_uint64),   # bSupported:1, bAvailable:1, ...
    ]

CTL_FAN_COUNT = 1
CTL_PSU_COUNT = 1

class CTL_POWER_TELEMETRY(ctypes.Structure):
    _fields_ = [
        ("Size",                        ctypes.c_uint32),
        ("Version",                     ctypes.c_uint8),
        ("_pad",                        ctypes.c_uint8 * 3),
        ("timeStamp",                   CTL_TELEMETRY_ITEM),
        ("gpuEnergyCounter",            CTL_TELEMETRY_ITEM),
        ("gpuVoltage",                  CTL_TELEMETRY_ITEM),
        ("gpuCurrentClockFrequency",    CTL_TELEMETRY_ITEM),
        ("gpuCurrentTemperature",       CTL_TELEMETRY_ITEM),
        ("globalActivityCounter",       CTL_TELEMETRY_ITEM),
        ("renderComputeActivityCounter",CTL_TELEMETRY_ITEM),
        ("mediaActivityCounter",        CTL_TELEMETRY_ITEM),
        ("gpuPowerLimited",             ctypes.c_int32),
        ("gpuTemperatureLimited",       ctypes.c_int32),
        ("gpuCurrentLimited",           ctypes.c_int32),
        ("gpuVoltageLimited",           ctypes.c_int32),
        ("gpuUtilizationLimited",       ctypes.c_int32),
        ("vramEnergyCounter",           CTL_TELEMETRY_ITEM),
        ("vramVoltage",                 CTL_TELEMETRY_ITEM),
        ("vramCurrentClockFrequency",   CTL_TELEMETRY_ITEM),
        ("vramCurrentTemperature",      CTL_TELEMETRY_ITEM),
        ("vramReadBandwidthCounter",    CTL_TELEMETRY_ITEM),
        ("vramWriteBandwidthCounter",   CTL_TELEMETRY_ITEM),
        ("fanSpeed",                    CTL_TELEMETRY_ITEM * CTL_FAN_COUNT),
        ("psu",                         CTL_TELEMETRY_ITEM * CTL_PSU_COUNT),
        ("gpuPowerValue",               CTL_TELEMETRY_ITEM),
    ]

# ---------------------------------------------------------------------------
# 函数签名
# ---------------------------------------------------------------------------

CTL_RESULT_SUCCESS = 0

ctlInit = lib.ctlInit
ctlInit.restype = ctypes.c_int
ctlInit.argtypes = [ctypes.POINTER(CTL_INIT_ARGS), ctypes.POINTER(ctypes.c_void_p)]

ctlEnumerateDevices = lib.ctlEnumerateDevices
ctlEnumerateDevices.restype = ctypes.c_int
ctlEnumerateDevices.argtypes = [ctypes.c_void_p,
                                 ctypes.POINTER(ctypes.c_uint32),
                                 ctypes.c_void_p]

ctlPowerTelemetryGet = lib.ctlPowerTelemetryGet
ctlPowerTelemetryGet.restype = ctypes.c_int
ctlPowerTelemetryGet.argtypes = [ctypes.c_void_p,
                                   ctypes.POINTER(CTL_POWER_TELEMETRY)]

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    # 1. Init
    init_args = CTL_INIT_ARGS()
    init_args.Size = ctypes.sizeof(CTL_INIT_ARGS)
    init_args.Version = 0
    # AppVersion: 随意填一个 GUID
    init_args.AppVersion.Data1 = 0x12345678

    api_handle = ctypes.c_void_p(None)
    ret = ctlInit(ctypes.byref(init_args), ctypes.byref(api_handle))
    print(f"ctlInit ret={ret} (0=OK), handle={api_handle.value}")
    if ret != CTL_RESULT_SUCCESS:
        print("ctlInit failed — 无法继续")
        return

    # 2. Enumerate devices
    count = ctypes.c_uint32(0)
    ctlEnumerateDevices(api_handle, ctypes.byref(count), None)
    print(f"Device count: {count.value}")
    if count.value == 0:
        print("没有找到设备")
        return

    devices = (ctypes.c_void_p * count.value)()
    ret = ctlEnumerateDevices(api_handle, ctypes.byref(count), devices)
    print(f"ctlEnumerateDevices ret={ret}")

    device = devices[0]
    print(f"Using device handle: {device}")

    # 3. Read power telemetry (two samples for energy delta)
    for i in range(3):
        telem = CTL_POWER_TELEMETRY()
        telem.Size = ctypes.sizeof(CTL_POWER_TELEMETRY)
        telem.Version = 0

        ret = ctlPowerTelemetryGet(device, ctypes.byref(telem))
        print(f"\n--- Sample {i} ret={ret} ---")
        if ret == CTL_RESULT_SUCCESS:
            pw = telem.gpuPowerValue
            ec = telem.gpuEnergyCounter
            ga = telem.globalActivityCounter
            temp = telem.gpuCurrentTemperature
            print(f"  gpuPowerValue   : value={pw.value:.3f}  supported={pw.flags & 1}  available={(pw.flags>>1)&1}")
            print(f"  gpuEnergyCounter: value={ec.value:.3f}  supported={ec.flags & 1}  available={(ec.flags>>1)&1}")
            print(f"  globalActivity  : value={ga.value:.3f}  supported={ga.flags & 1}  available={(ga.flags>>1)&1}")
            print(f"  gpuTemperature  : value={temp.value:.3f}  supported={temp.flags & 1}  available={(temp.flags>>1)&1}")
        else:
            print(f"  ctlPowerTelemetryGet failed ret={ret:#010x}")
        time.sleep(0.5)

if __name__ == "__main__":
    main()
