"""
providers/intel.py — Intel Arc GPU hardware provider.

VRAM free/total : Level Zero Sysman — zesMemoryGetState        (GIL-free)
PyTorch stats   : torch.xpu.memory_allocated / memory_reserved (no LZ equivalent)
GPU load        : Level Zero Sysman — zesEngineGetActivity
GPU frequency   : Level Zero Sysman — zesFrequencyGetState
GPU temperature : Level Zero Sysman — zesTemperatureGetState
Power           : Level Zero Sysman — zesPowerGetEnergyCounter  (admin only)
"""

import ctypes
import logging
import os
import threading
import time
from typing import Optional, Tuple

from .base import BaseGPUProvider, GPUSnapshot

logger = logging.getLogger("XPUSYSMonitor")

# ---------------------------------------------------------------------------
# Level Zero constants
# ---------------------------------------------------------------------------

ZE_RESULT_SUCCESS = 0
ZE_RESULT_ERROR_INSUFFICIENT_PERMISSIONS = 0x78000003

# zes_structure_type_t values
_ZES_STYPE_MEM_STATE  = 0x18
_ZES_STYPE_FREQ_STATE = 0x11
_ZES_STYPE_FREQ_PROPS = 0x10
_ZES_STYPE_TEMP_PROPS = 0x35

_ZES_FREQ_DOMAIN_GPU  = 0   # ZES_FREQ_DOMAIN_GPU
_ZES_TEMP_SENSORS_GPU = 1   # ZES_TEMP_SENSORS_GPU

# ---------------------------------------------------------------------------
# Level Zero structs
# ---------------------------------------------------------------------------

class _ZesEnergyCounter(ctypes.Structure):
    _fields_ = [("energy",    ctypes.c_uint64),   # microjoules
                ("timestamp", ctypes.c_uint64)]    # microseconds


class _ZesEngineStats(ctypes.Structure):
    _fields_ = [("activeTime", ctypes.c_uint64),
                ("timestamp",  ctypes.c_uint64)]


# ---------------------------------------------------------------------------
# Admin detection
# ---------------------------------------------------------------------------

def _is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _get_cpu_info() -> Tuple[str, int]:
    """Return (model_name, logical_thread_count). Called once at startup."""
    model = ""
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        )
        model, _ = winreg.QueryValueEx(key, "ProcessorNameString")
        winreg.CloseKey(key)
        model = " ".join(model.strip().split())   # collapse extra spaces
    except Exception:
        try:
            import platform
            model = platform.processor()
        except Exception:
            model = "Unknown CPU"
    threads = 0
    try:
        import psutil
        threads = psutil.cpu_count(logical=True) or 0
    except Exception:
        threads = os.cpu_count() or 0
    return model, threads


# ---------------------------------------------------------------------------
# Level Zero Sysman wrapper
# ---------------------------------------------------------------------------

class _LevelZeroSysman:
    """Thin ctypes wrapper — GPU metrics via Intel Level Zero Sysman."""

    def __init__(self, is_admin: bool, device_index: int = 0):
        self._lib             = None
        self._device          = None
        self._device_index    = device_index
        self._is_admin        = is_admin
        self._power_handles:  list = []
        self._prev_energies:  list = []
        self._engine_handles: list = []
        self._mem_handles:    list = []
        # List of (handle, can_control, domain_idx) for every ZES_FREQ_DOMAIN_GPU
        # found on this device.  can_control=True means the driver allows setting
        # the target freq — that domain is usually the "real" GPU core clock.
        self._freq_handles: list    = []
        self._temp_handle           = None
        self._temp_unavailable      = False   # True = sensor confirmed absent, skip re-enum
        self._power_denied          = False
        self._available             = False
        self.device_name: str   = ""
        self.pci_id:       str   = ""
        self.tgp_w:       float = 0.0
        self._load(is_admin)

    def _load(self, is_admin: bool):
        os.environ["ZES_ENABLE_SYSMAN"] = "1"
        try:
            lib = ctypes.WinDLL("ze_loader.dll")
        except OSError:
            logger.warning("XPUSYSMonitor: ze_loader.dll not found.")
            return

        try:
            device = self._zes_init(lib) or self._ze_init(lib)
            if device is None:
                logger.warning("XPUSYSMonitor: no Level Zero device found.")
                return

            self._device = device
            self._read_device_name(lib, device)

            if is_admin:
                self._setup_power(lib, device)
            else:
                logger.info("XPUSYSMonitor: non-admin — power disabled.")

            self._setup_engines(lib, device)
            self._setup_memory(lib, device)
            self._setup_frequency(lib, device)
            self._setup_temperature(lib, device)

            self._lib       = lib
            self._available = True
            logger.info("XPUSYSMonitor: Level Zero Sysman ready.")

        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: Level Zero init error — {exc}")

    # --- init paths ---

    def _zes_init(self, lib) -> Optional[ctypes.c_void_p]:
        try:
            f = lib.zesInit; f.restype = ctypes.c_int; f.argtypes = [ctypes.c_uint32]
            if f(0) != ZE_RESULT_SUCCESS: return None
            return self._enum_device(lib, lib.zesDriverGet, lib.zesDeviceGet, "zesInit")
        except Exception as e:
            logger.debug(f"XPUSYSMonitor: zesInit failed — {e}")
            return None

    def _ze_init(self, lib) -> Optional[ctypes.c_void_p]:
        try:
            f = lib.zeInit; f.restype = ctypes.c_int; f.argtypes = [ctypes.c_uint32]
            if f(0) != ZE_RESULT_SUCCESS: return None
            return self._enum_device(lib, lib.zeDriverGet, lib.zeDeviceGet, "zeInit")
        except Exception as e:
            logger.debug(f"XPUSYSMonitor: zeInit failed — {e}")
            return None

    def _enum_device(self, lib, drv_fn, dev_fn, label) -> Optional[ctypes.c_void_p]:
        drv_fn.restype = ctypes.c_int
        drv_fn.argtypes = [ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0); drv_fn(ctypes.byref(cnt), None)
        if cnt.value == 0: return None
        drivers = (ctypes.c_void_p * cnt.value)(); drv_fn(ctypes.byref(cnt), drivers)

        dev_fn.restype = ctypes.c_int
        dev_fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        dcnt = ctypes.c_uint32(0); dev_fn(drivers[0], ctypes.byref(dcnt), None)
        if dcnt.value == 0: return None
        devices = (ctypes.c_void_p * dcnt.value)(); dev_fn(drivers[0], ctypes.byref(dcnt), devices)
        logger.debug(f"XPUSYSMonitor: {label} succeeded ({dcnt.value} device(s)).")
        idx = min(self._device_index, dcnt.value - 1)
        return devices[idx]

    def device_count(self) -> int:
        """Return the number of Intel GPUs visible via Level Zero."""
        if self._lib is None:
            return 0
        try:
            drv_fn = self._lib.zesDriverGet if hasattr(self._lib, "zesDriverGet") else None
            if drv_fn is None:
                return 0
            drv_fn.restype = ctypes.c_int
            drv_fn.argtypes = [ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
            cnt = ctypes.c_uint32(0); drv_fn(ctypes.byref(cnt), None)
            if cnt.value == 0: return 0
            drivers = (ctypes.c_void_p * cnt.value)(); drv_fn(ctypes.byref(cnt), drivers)
            dev_fn = self._lib.zesDeviceGet
            dev_fn.restype = ctypes.c_int
            dev_fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
            dcnt = ctypes.c_uint32(0); dev_fn(drivers[0], ctypes.byref(dcnt), None)
            return int(dcnt.value)
        except Exception:
            return 1

    def select_device(self, index: int) -> bool:
        """Rebind to another Intel GPU (re-run full setup on that device)."""
        try:
            total = self.device_count()
            if total == 0:
                return False
            if not (0 <= index < total):
                logger.warning(f"XPUSYSMonitor: invalid Intel device index {index} (count={total})")
                return False
            self._device_index = index
            # Reset per-device state so _load() re-enumerates everything
            self._power_handles  = []
            self._prev_energies  = []
            self._engine_handles = []
            self._mem_handles    = []
            self._freq_handles   = []
            self._temp_handle    = None
            self._temp_unavailable = False
            self._power_denied   = False
            self._available      = False
            self.device_name     = ""
            self.pci_id          = ""
            self.tgp_w           = 0.0
            self._load(self._is_admin)
            return self._available
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: select_device failed — {exc}")
            return False

    def _read_device_name(self, lib, device) -> None:
        try:
            fn = lib.zesDeviceGetProperties
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            buf = (ctypes.c_uint8 * 2048)()
            ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = 0x1
            ret = fn(device, buf)
            if ret != ZE_RESULT_SUCCESS:
                logger.debug(f"XPUSYSMonitor: zesDeviceGetProperties ret={ret:#010x}")
                return
            raw = bytes(buf[:800])
            idx = raw.find(b'Intel')
            if idx >= 0:
                name_bytes = raw[idx:idx + 64].split(b'\x00')[0]
                self.device_name = name_bytes.decode('utf-8', errors='replace').strip()
                logger.info(f"XPUSYSMonitor: device name = {self.device_name!r}")
                # ── Attempt to extract PCI device ID ──
                # Method 1: regex from device_name "[0x...]" suffix (B580 has it)
                import re
                m = re.search(r'\[0x([0-9a-fA-F]+)\]', self.device_name)
                if m:
                    self.pci_id = "0x" + m.group(1).lower()
                    logger.info(f"XPUSYSMonitor: PCI ID (regex) = {self.pci_id}")
                else:
                    # Method 2: read ze_device_properties_t.deviceId via the CORE API.
                    # NOTE: must call zeDeviceGetProperties (not zesDeviceGetProperties —
                    # the Sysman struct zes_device_properties_t has coreName at +24,
                    # NOT deviceId. Core struct ze_device_properties_t:
                    #   stype(4)+pad(4)+pNext(8)+type(4)+vendorId(4)+deviceId(4) = +24
                    self._read_pci_id_core(lib, device)
            else:
                logger.debug("XPUSYSMonitor: 'Intel' not found in device properties buffer")
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: _read_device_name — {exc}")

    def _read_pci_id_core(self, lib, device) -> None:
        """Read PCI device ID from ze_device_properties_t (Core API)."""
        try:
            fn = lib.zeDeviceGetProperties
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            cbuf = (ctypes.c_uint8 * 2048)()
            # ZE_STRUCTURE_TYPE_DEVICE_PROPERTIES = 0x1
            ctypes.cast(cbuf, ctypes.POINTER(ctypes.c_uint32))[0] = 0x1
            ret = fn(device, cbuf)
            if ret != ZE_RESULT_SUCCESS:
                logger.debug(f"XPUSYSMonitor: zeDeviceGetProperties ret={ret:#010x}")
                return
            dev_id = ctypes.cast(ctypes.addressof(cbuf) + 24,
                                 ctypes.POINTER(ctypes.c_uint32))[0]
            if 0 < dev_id < 0xFFFF:
                self.pci_id = f"0x{dev_id:04x}"
                logger.info(f"XPUSYSMonitor: PCI ID (struct) = {self.pci_id}")
            else:
                logger.debug(f"XPUSYSMonitor: PCI ID (struct) invalid — {dev_id:#x}")
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: _read_pci_id_core — {exc}")

    # --- setup methods ---

    def _setup_power(self, lib, device):
        f = lib.zesDeviceEnumPowerDomains
        f.restype = ctypes.c_int
        f.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0); f(device, ctypes.byref(cnt), None)
        logger.debug(f"XPUSYSMonitor: power domains found: {cnt.value}")
        if cnt.value == 0:
            return
        handles = (ctypes.c_void_p * cnt.value)()
        f(device, ctypes.byref(cnt), handles)

        tgp_total = 0.0
        for i, h in enumerate(list(handles)):
            tgp = self._read_tgp(lib, h, domain_idx=i)
            if tgp > 0:
                self._power_handles.append(h)
                self._prev_energies.append(None)
                tgp_total += tgp
                logger.debug(f"XPUSYSMonitor: domain[{i}] TGP={tgp:.0f}W — added")
            else:
                logger.debug(f"XPUSYSMonitor: domain[{i}] skipped (TGP=0)")

        if tgp_total > 0:
            self.tgp_w = tgp_total
            logger.info(f"XPUSYSMonitor: total TGP = {tgp_total:.0f} W")
        elif handles:
            self._power_handles.append(handles[0])
            self._prev_energies.append(None)
            logger.debug("XPUSYSMonitor: TGP unknown — using domain[0] for energy counter only")

    def _read_tgp(self, lib, power_handle, domain_idx: int = 0) -> float:
        try:
            fn = lib.zesPowerGetProperties
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
            buf = (ctypes.c_uint8 * 64)()
            ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = 0xd
            ret = fn(power_handle, buf)
            def_mw = ctypes.cast(ctypes.addressof(buf) + 32, ctypes.POINTER(ctypes.c_int32))[0]
            max_mw = ctypes.cast(ctypes.addressof(buf) + 40, ctypes.POINTER(ctypes.c_int32))[0]
            logger.debug(
                f"XPUSYSMonitor: domain[{domain_idx}] GetProperties "
                f"ret={ret:#010x} defaultLimit={def_mw}mW maxLimit={max_mw}mW"
            )
            if ret == ZE_RESULT_SUCCESS:
                for mw in (def_mw, max_mw):
                    if 0 < mw < 1_000_000:
                        tgp = mw / 1000.0
                        logger.debug(f"XPUSYSMonitor: TGP = {tgp:.0f} W (domain[{domain_idx}] GetProperties)")
                        return tgp
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: zesPowerGetProperties domain[{domain_idx}] — {exc}")

        try:
            fn2 = lib.zesPowerGetLimits
            fn2.restype  = ctypes.c_int
            fn2.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
            lbuf = (ctypes.c_uint8 * 32)()
            ret2 = fn2(power_handle, lbuf, None, None)
            mw = ctypes.cast(ctypes.addressof(lbuf) + 4, ctypes.POINTER(ctypes.c_int32))[0]
            logger.debug(f"XPUSYSMonitor: domain[{domain_idx}] GetLimits ret={ret2:#010x} power_mw={mw}")
            if ret2 == ZE_RESULT_SUCCESS and 0 < mw < 1_000_000:
                tgp = mw / 1000.0
                logger.debug(f"XPUSYSMonitor: TGP = {tgp:.0f} W (domain[{domain_idx}] GetLimits)")
                return tgp
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: zesPowerGetLimits domain[{domain_idx}] — {exc}")

        return 0.0

    def _setup_engines(self, lib, device):
        f = lib.zesDeviceEnumEngineGroups
        f.restype = ctypes.c_int
        f.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0); f(device, ctypes.byref(cnt), None)
        if cnt.value > 0:
            handles = (ctypes.c_void_p * cnt.value)()
            f(device, ctypes.byref(cnt), handles)
            self._engine_handles = list(handles)
            logger.debug(f"XPUSYSMonitor: {cnt.value} engine group(s) found.")

    def _setup_memory(self, lib, device):
        """Enumerate memory modules — enables GIL-free VRAM reads via zesMemoryGetState."""
        f = lib.zesDeviceEnumMemoryModules
        f.restype  = ctypes.c_int
        f.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0)
        f(device, ctypes.byref(cnt), None)
        if cnt.value == 0:
            logger.warning("XPUSYSMonitor: no memory modules found via Sysman.")
            return
        handles = (ctypes.c_void_p * cnt.value)()
        f(device, ctypes.byref(cnt), handles)
        self._mem_handles = list(handles)
        logger.debug(f"XPUSYSMonitor: {cnt.value} memory module(s) found.")

    def _setup_frequency(self, lib, device):
        """Enumerate ALL frequency domains, collect every ZES_FREQ_DOMAIN_GPU handle.

        zes_freq_properties_t layout (64-bit, header = stype(4)+pad(4)+pNext(8)):
          offset  0 : stype        (uint32)
          offset  4 : padding
          offset  8 : pNext        (uint64)
          offset 16 : type         (uint32)  ← zes_freq_domain_t
          offset 20 : onSubdevice  (uint32)  ← ze_bool_t
          offset 24 : subdeviceId  (uint32)
          offset 28 : canControl   (uint32)  ← ze_bool_t, 1 = driver lets us set freq
          offset 32 : isThrottleEventSupported (uint32)
          offset 36 : padding
          offset 40 : min          (double)
          offset 48 : max          (double)

        Stores self._freq_handles as a list of (handle, can_control, idx).
        Sorted so canControl=True entries come first — read_gpu_freq_mhz() will
        prefer those as the "real" GPU core domain.
        If no GPU domain is found at all, falls back to domain[0] with a warning.
        """
        self._freq_handles = []   # clear on every (re-)setup

        f = lib.zesDeviceEnumFrequencyDomains
        f.restype  = ctypes.c_int
        f.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0)
        f(device, ctypes.byref(cnt), None)
        if cnt.value == 0:
            logger.debug("XPUSYSMonitor: no frequency domains found.")
            return
        handles = (ctypes.c_void_p * cnt.value)()
        f(device, ctypes.byref(cnt), handles)
        logger.debug(f"XPUSYSMonitor: {cnt.value} frequency domain(s) found — scanning all.")

        fp = lib.zesFrequencyGetProperties
        fp.restype  = ctypes.c_int
        fp.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

        gpu_entries = []   # (handle, can_control, idx)
        fallback    = handles[0]

        for i, h in enumerate(handles):
            # 64-byte buffer is enough for zes_freq_properties_t (56 bytes)
            buf = (ctypes.c_uint8 * 64)()
            ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = _ZES_STYPE_FREQ_PROPS
            ret = fp(h, buf)
            if ret != ZE_RESULT_SUCCESS:
                logger.debug(
                    f"XPUSYSMonitor: freq domain[{i}] GetProperties ret={ret:#010x} — skipped"
                )
                continue

            addr        = ctypes.addressof(buf)
            domain      = ctypes.cast(addr + 16, ctypes.POINTER(ctypes.c_uint32))[0]
            can_ctrl    = ctypes.cast(addr + 28, ctypes.POINTER(ctypes.c_uint32))[0]
            freq_min    = ctypes.cast(addr + 40, ctypes.POINTER(ctypes.c_double))[0]
            freq_max    = ctypes.cast(addr + 48, ctypes.POINTER(ctypes.c_double))[0]
            domain_name = "GPU" if domain == _ZES_FREQ_DOMAIN_GPU else f"type={domain}"

            logger.debug(
                f"XPUSYSMonitor: freq domain[{i}] {domain_name}  "
                f"canControl={bool(can_ctrl)}  range=[{freq_min:.0f}–{freq_max:.0f}] MHz"
            )

            if domain == _ZES_FREQ_DOMAIN_GPU:
                gpu_entries.append((h, bool(can_ctrl), i))

        if gpu_entries:
            # Sort: canControl=True first, then by index
            gpu_entries.sort(key=lambda e: (not e[1], e[2]))
            self._freq_handles = gpu_entries
            best = gpu_entries[0]
            logger.info(
                f"XPUSYSMonitor: {len(gpu_entries)} GPU freq domain(s) collected. "
                f"Primary → domain[{best[2]}] canControl={best[1]}"
            )
        else:
            # No GPU domain at all — keep fallback handle with no canControl
            self._freq_handles = [(fallback, False, 0)]
            logger.warning(
                "XPUSYSMonitor: no ZES_FREQ_DOMAIN_GPU found — "
                "using domain[0] as fallback (may be media/compute clock)."
            )

    def _setup_temperature(self, lib, device):
        """Find the GPU core temperature sensor handle for zesTemperatureGetState."""
        f = lib.zesDeviceEnumTemperatureSensors
        f.restype  = ctypes.c_int
        f.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_void_p]
        cnt = ctypes.c_uint32(0)
        f(device, ctypes.byref(cnt), None)
        if cnt.value == 0:
            if not self._temp_unavailable:
                logger.info(
                    "XPUSYSMonitor: no temperature sensors found "
                    "(non-admin or driver limitation) — temperature disabled."
                )
                self._temp_unavailable = True
            return
        handles = (ctypes.c_void_p * cnt.value)()
        f(device, ctypes.byref(cnt), handles)

        tp = lib.zesTemperatureGetProperties
        tp.restype  = ctypes.c_int
        tp.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

        for h in handles:
            # zes_temp_properties_t: stype(4)+pad(4)+pNext(8) = 16B header, then type(4) @ offset 16
            buf = (ctypes.c_uint8 * 64)()
            ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = _ZES_STYPE_TEMP_PROPS
            ret = tp(h, buf)
            if ret != ZE_RESULT_SUCCESS:
                continue
            sensor_type = ctypes.cast(ctypes.addressof(buf) + 16, ctypes.POINTER(ctypes.c_uint32))[0]
            if sensor_type == _ZES_TEMP_SENSORS_GPU:
                self._temp_handle = h
                logger.debug("XPUSYSMonitor: GPU temperature sensor found.")
                return

        # Fallback: use first handle
        if handles:
            self._temp_handle = handles[0]
            logger.debug("XPUSYSMonitor: using first temperature sensor as fallback.")

    # --- runtime reads ---

    @property
    def available(self) -> bool:
        return self._available

    def read_vram_state(self) -> Tuple[float, float]:
        """Return (free_gb, total_gb) via zesMemoryGetState. Fully GIL-free.

        zes_mem_state_t layout (64-bit):
          offset  0: stype (uint32)
          offset  4: pad
          offset  8: pNext (uint64)
          offset 16: health (uint32)
          offset 20: pad
          offset 24: free (uint64)   ← bytes free
          offset 32: size (uint64)   ← total bytes
        """
        if not self._available or not self._mem_handles:
            return 0.0, 0.0
        try:
            fn = self._lib.zesMemoryGetState
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

            total_b = 0
            free_b  = 0
            got_any = False
            for handle in self._mem_handles:
                buf = (ctypes.c_uint8 * 48)()
                ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = _ZES_STYPE_MEM_STATE
                ret = fn(handle, buf)
                if ret != ZE_RESULT_SUCCESS:
                    continue
                free  = ctypes.cast(ctypes.addressof(buf) + 24, ctypes.POINTER(ctypes.c_uint64))[0]
                size  = ctypes.cast(ctypes.addressof(buf) + 32, ctypes.POINTER(ctypes.c_uint64))[0]
                total_b += size
                free_b  += free
                got_any  = True

            if not got_any:
                return 0.0, 0.0
            gb = 1024 ** 3
            return free_b / gb, total_b / gb
        except Exception:
            return 0.0, 0.0

    def read_gpu_freq_mhz(self) -> float:
        """Return current GPU core frequency in MHz via zesFrequencyGetState.

        zes_freq_state_t field offsets (Level Zero spec, verified from pyzes.py):
          +16 currentVoltage (V)
          +24 request        (MHz) — driver target P-state
          +32 tdp            (MHz) — max freq under current TDP
          +40 efficient      (MHz) — efficient minimum
          +48 actual         (MHz) — RESOLVED real running clock ✅

        Confirmed vs Intel's own monitoring tool (2026-07-18):
          • offset 48 (actual) IS the real clock:
              - B580 idle  = 400 MHz
              - B580 load  = 2850 MHz (matches Intel tool exactly)
          • offset 24 (request) is the driver target, can be higher than actual
              - B580 load = 4250 (target, but hardware caps at 2850)
          • offset 32 (tdp) is the TDP ceiling (constant 2850 on B580)
          • offset 16 (currentVoltage) is in Volts (1.025V load / 0.730V idle)
          • offset 40 (efficient) is a constant low floor (400 on B580)
        """
        if not self._available or self._lib is None:
            return 0.0
        if not self._freq_handles:
            self._setup_frequency(self._lib, self._device)
        if not self._freq_handles:
            return 0.0

        fn = self._lib.zesFrequencyGetState
        fn.restype  = ctypes.c_int
        fn.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

        # Plausible GPU clock range for Arc (any tier): 100 – 3500 MHz
        _MIN_VALID = 100.0
        _MAX_VALID = 3500.0
        # Frequencies at or below this threshold are considered "floor/frozen"
        _FLOOR_MHZ = 410.0   # B580 hw minimum is ~400 MHz

        def _query_one(handle, can_ctrl, idx):
            """Returns (ret, voltage, request, tdp, efficient, actual)."""
            buf = (ctypes.c_uint8 * 80)()
            ctypes.cast(buf, ctypes.POINTER(ctypes.c_uint32))[0] = _ZES_STYPE_FREQ_STATE
            ret = fn(handle, buf)
            if ret != ZE_RESULT_SUCCESS:
                return ret, 0.0, 0.0, 0.0, 0.0, 0.0
            a = ctypes.addressof(buf)
            return (
                ret,
                ctypes.cast(a + 16, ctypes.POINTER(ctypes.c_double))[0],  # currentVoltage (V)
                ctypes.cast(a + 24, ctypes.POINTER(ctypes.c_double))[0],  # request (MHz)
                ctypes.cast(a + 32, ctypes.POINTER(ctypes.c_double))[0],  # tdp (MHz)
                ctypes.cast(a + 40, ctypes.POINTER(ctypes.c_double))[0],  # efficient (MHz)
                ctypes.cast(a + 48, ctypes.POINTER(ctypes.c_double))[0],  # actual (MHz) — real clock
            )

        def _pick_best(r_volt, r_req, r_tdp, r_eff, r_act) -> float:
            """Choose the most trustworthy frequency value from the five freq fields.

            Struct (verified from pyzes.py):
              +16 currentVoltage  +24 request  +32 tdp  +40 efficient  +48 actual

            Selection strategy (confirmed vs Intel's own tool 2026-07-18):
              1. actual (offset 48) — REAL resolved frequency
                 • idle: 400 MHz (power saving, real value)
                 • load: 2850 MHz on B580 (matches Intel tool exactly)
              2. request (offset 24) — driver target P-state, can exceed real clock
              3. tdp (offset 32) — TDP ceiling, last-resort fallback
            """
            # 1. actual — REAL resolved frequency (B580 verified: 400 idle / 2850 load)
            if _MIN_VALID <= r_act <= _MAX_VALID:
                return r_act
            # 2. request — driver target, can be higher than real (B580: 4250 load)
            if _MIN_VALID <= r_req <= _MAX_VALID:
                return r_req
            # 3. tdp — TDP ceiling (constant, only as last resort)
            if _MIN_VALID <= r_tdp <= _MAX_VALID:
                return r_tdp
            return 0.0

        try:
            best_val   = 0.0
            best_found = False
            stale      = False

            for handle, can_ctrl, idx in self._freq_handles:
                ret, r_volt, r_req, r_tdp, r_eff, r_act = _query_one(handle, can_ctrl, idx)
                if ret != ZE_RESULT_SUCCESS:
                    stale = True
                    continue
                val = _pick_best(r_volt, r_req, r_tdp, r_eff, r_act)
                # canControl=True domain is authoritative; otherwise take first
                if (not best_found) or can_ctrl:
                    best_val   = val
                    best_found = True

            if stale and not best_found:
                self._setup_frequency(self._lib, self._device)
                if not self._freq_handles:
                    return 0.0
                handle, can_ctrl, idx = self._freq_handles[0]
                ret, r_volt, r_req, r_tdp, r_eff, r_act = _query_one(handle, can_ctrl, idx)
                if ret != ZE_RESULT_SUCCESS:
                    return 0.0
                best_val = _pick_best(r_volt, r_req, r_tdp, r_eff, r_act)

            return best_val

        except Exception:
            return 0.0

    def read_gpu_temp_c(self) -> float:
        """Return GPU core temperature in °C via zesTemperatureGetState, or -1.0.

        Re-enumerates the sensor handle if the call fails (same stale-handle guard
        as read_gpu_freq_mhz).
        Once confirmed unavailable (non-admin / driver limitation), skips all
        re-enumeration attempts to avoid log spam.
        """
        if not self._available or self._lib is None:
            return -1.0
        if self._temp_unavailable:
            return -1.0
        if self._temp_handle is None:
            self._setup_temperature(self._lib, self._device)
        if self._temp_handle is None:
            return -1.0
        try:
            fn = self._lib.zesTemperatureGetState
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_double)]

            def _query(handle):
                t = ctypes.c_double(0.0)
                ret = fn(handle, ctypes.byref(t))
                return ret, max(0.0, t.value)

            ret, val = _query(self._temp_handle)
            if ret != ZE_RESULT_SUCCESS:
                self._temp_handle = None
                self._setup_temperature(self._lib, self._device)
                if self._temp_handle is None:
                    return -1.0
                ret, val = _query(self._temp_handle)
                if ret != ZE_RESULT_SUCCESS:
                    return -1.0
            return val
        except Exception:
            return -1.0

    def read_power_w(self) -> float:
        """Return total watts across all power domains, or -1.0 if unavailable."""
        if not self._available or not self._power_handles or self._power_denied:
            return -1.0
        try:
            fn = self._lib.zesPowerGetEnergyCounter
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ZesEnergyCounter)]

            total_w = 0.0
            got_any = False
            for i, handle in enumerate(self._power_handles):
                counter = _ZesEnergyCounter()
                ret = fn(handle, ctypes.byref(counter))
                if ret == ZE_RESULT_ERROR_INSUFFICIENT_PERMISSIONS:
                    logger.warning("XPUSYSMonitor: power read needs admin — showing N/A.")
                    self._power_denied = True
                    return -1.0
                if ret != ZE_RESULT_SUCCESS:
                    continue
                prev = self._prev_energies[i]
                if prev is not None:
                    dE = counter.energy    - prev.energy
                    dt = counter.timestamp - prev.timestamp
                    if dt > 0:
                        total_w += max(0.0, dE / dt)   # uJ/us = W
                        got_any = True
                self._prev_energies[i] = counter

            return total_w if got_any else 0.0
        except Exception:
            return -1.0

    def read_gpu_load_pct(self) -> float:
        """Return GPU utilisation %, or 0.0."""
        if not self._available or not self._engine_handles:
            return 0.0
        try:
            fn = self._lib.zesEngineGetActivity
            fn.restype  = ctypes.c_int
            fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ZesEngineStats)]
            s1 = _ZesEngineStats()
            if fn(self._engine_handles[0], ctypes.byref(s1)) != ZE_RESULT_SUCCESS:
                return 0.0
            time.sleep(0.05)
            s2 = _ZesEngineStats()
            if fn(self._engine_handles[0], ctypes.byref(s2)) != ZE_RESULT_SUCCESS:
                return 0.0
            dA = s2.activeTime - s1.activeTime
            dT = s2.timestamp  - s1.timestamp
            return min(100.0, (dA / dT) * 100.0) if dT > 0 else 0.0
        except Exception:
            return 0.0


# ---------------------------------------------------------------------------
# System-level stats (CPU / RAM) — shared utility, vendor-agnostic
# ---------------------------------------------------------------------------

def _read_commit_charge() -> Tuple[float, float]:
    """
    Return (commit_used_gb, commit_limit_gb).

    Windows: GlobalMemoryStatusEx — maps to Task Manager → Performance →
    Memory → "已提交 (Committed)":
      CommitLimit = ullTotalPageFile          (RAM + page file ceiling)
      CommitTotal = ullTotalPageFile - ullAvailPageFile

    Linux/macOS: psutil.swap_memory() — the closest POSIX equivalent to
    "virtual memory" (the Swap column of `free`). A machine with no swap
    configured reads 0 / 0 — that is the truth (no swap space), not a
    read failure.
    """
    gb = 1024 ** 3
    if os.name == "nt":
        try:
            class _MEMSTATEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength",            ctypes.c_ulong),
                    ("dwMemoryLoad",        ctypes.c_ulong),
                    ("ullTotalPhys",        ctypes.c_ulonglong),
                    ("ullAvailPhys",        ctypes.c_ulonglong),
                    ("ullTotalPageFile",    ctypes.c_ulonglong),
                    ("ullAvailPageFile",    ctypes.c_ulonglong),
                    ("ullTotalVirtual",     ctypes.c_ulonglong),
                    ("ullAvailVirtual",     ctypes.c_ulonglong),
                    ("ullAvailExtVirtual",  ctypes.c_ulonglong),
                ]
            stat = _MEMSTATEX()
            stat.dwLength = ctypes.sizeof(_MEMSTATEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            limit = stat.ullTotalPageFile / gb
            used  = (stat.ullTotalPageFile - stat.ullAvailPageFile) / gb
            return round(used, 2), round(limit, 2)
        except Exception:
            return 0.0, 0.0
    # POSIX: swap as "virtual memory"
    try:
        import psutil
        sw = psutil.swap_memory()
        return round(sw.used / gb, 2), round(sw.total / gb, 2)
    except Exception:
        return 0.0, 0.0


# ── Windows 实时 CPU 频率（PDH）──────────────────────────────────────────
# psutil.cpu_freq().current 在 Windows 上恒等于最大频率（psutil 已知限制：
# "On Windows, current is always reported as the maximum frequency"），导致
# CPU 胶囊频率在工作流运行期间完全不变。
# 这里改用任务管理器同款计数器：
#   \Processor Information(_Total)\% Processor Performance
#   （相对基准频率的百分比，支持 boost > 100%） × 注册表基准频率 ~MHz
# 复用轮询节奏做双采样（PdhCollectQueryData 需要间隔才产生有效值）。

class _PDH_FMT_COUNTERVALUE(ctypes.Structure):
    _fields_ = [("CStatus", ctypes.c_ulong),
                ("doubleValue", ctypes.c_double)]

_pdh         = None
_pdh_query   = None
_pdh_counter = None
_pdh_ready   = False
_cpu_base_mhz = 0


def _get_cpu_base_mhz() -> int:
    """CPU 基准频率（MHz），注册表一次读取并缓存。失败返回 0."""
    global _cpu_base_mhz
    if _cpu_base_mhz:
        return _cpu_base_mhz
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        ) as key:
            _cpu_base_mhz = int(winreg.QueryValueEx(key, "~MHz")[0])
    except Exception:
        _cpu_base_mhz = 0
    return _cpu_base_mhz


def _read_pdh_cpu_freq_mhz() -> float:
    """Windows 实时 CPU 频率（MHz）。非 Windows / 初始化失败返回 0（调用方回退 psutil）。"""
    global _pdh, _pdh_query, _pdh_counter, _pdh_ready
    if os.name != "nt":
        return 0.0
    base = _get_cpu_base_mhz()
    if base <= 0:
        return 0.0
    try:
        if _pdh is None:
            _pdh = ctypes.WinDLL("pdh.dll")
            _pdh_query = ctypes.c_void_p()
            if _pdh.PdhOpenQueryW(None, 0, ctypes.byref(_pdh_query)) != 0:
                _pdh = None
                return 0.0
            _pdh_counter = ctypes.c_void_p()
            path = ctypes.c_wchar_p(r"\Processor Information(_Total)\% Processor Performance")
            if _pdh.PdhAddEnglishCounterW(_pdh_query, path, 0, ctypes.byref(_pdh_counter)) != 0:
                _pdh = None
                return 0.0
            _pdh_ready = False
        # 每次轮询 collect 一次；计数器需两次采样间隔才产生有效值（复用 1s 轮询）
        _pdh.PdhCollectQueryData(_pdh_query)
        if not _pdh_ready:
            _pdh_ready = True
            return 0.0
        val = _PDH_FMT_COUNTERVALUE()
        ret = _pdh.PdhGetFormattedCounterValue(
            _pdh_counter, 0x00000200, None, ctypes.byref(val))
        if ret != 0 or val.CStatus != 0 or val.doubleValue <= 0:
            return 0.0
        return base * val.doubleValue / 100.0
    except Exception:
        return 0.0


def _read_cpu_ram_stats(psutil_ok: bool) -> dict:
    """Return CPU and RAM metrics via psutil + platform commit stats."""
    if not psutil_ok:
        return {}
    try:
        import psutil
        cpu_pct  = psutil.cpu_percent(interval=None)
        ram      = psutil.virtual_memory()
        gb       = 1024 ** 3
        commit_used, commit_limit = _read_commit_charge()
        # CPU 频率：Windows 优先 PDH 实时频率（psutil 在 Windows 恒返回最大频率）
        pdh_mhz = _read_pdh_cpu_freq_mhz()
        if pdh_mhz > 0:
            cpu_freq_ghz = round(pdh_mhz / 1000.0, 2)
        else:
            f = psutil.cpu_freq()
            cpu_freq_ghz = round(f.current / 1000.0, 2) if f else 0.0
        return {
            "cpu_pct":          cpu_pct,
            "cpu_freq_ghz":     cpu_freq_ghz,
            "ram_pct":          ram.percent,
            "ram_total_gb":     ram.total     / gb,
            "ram_used_gb":      ram.used      / gb,
            "ram_free_gb":      ram.available / gb,
            "commit_used_gb":   commit_used,
            "commit_limit_gb":  commit_limit,
        }
    except Exception as exc:
        logger.error(f"XPUSYSMonitor: cpu/ram stats error — {exc}")
        return {}


# ---------------------------------------------------------------------------
# IntelProvider — BaseGPUProvider implementation for Intel Arc
# ---------------------------------------------------------------------------

class IntelProvider(BaseGPUProvider):
    """
    Hardware provider for Intel Arc GPUs.

    Uses Level Zero Sysman for GPU metrics (VRAM, load, frequency,
    temperature, power) and torch.xpu for allocator statistics.
    CPU/RAM metrics are collected via psutil + WinAPI.
    """

    GPU_VENDOR = "intel"

    def __init__(self, interval_ms: int = 1000, device_index: int = -1):
        # device_index < 0 → 跟随 ComfyUI 主设备（torch.xpu.current_device()），
        # 即启动日志 "Device: xpu:N ..." 中 ComfyUI 实际选中的那张卡。
        self._torch_ok     = False
        self._psutil_ok    = False
        self._requested_index = device_index
        self._device_index = 0
        self._is_admin     = _is_admin()
        self._cpu_model    = ""
        self._cpu_threads  = 0
        # 硬件句柄锁：select_device()（HTTP 线程）与 _poll()（轮询线程）
        # 并发访问 _LevelZeroSysman 句柄，切换时需互斥，避免读到中间状态
        self._hw_lock = threading.RLock()
        self._check_torch()
        self._check_psutil()
        # 解析最终设备索引：显式指定用指定值，否则跟随 torch.xpu 主设备
        if self._requested_index is None or self._requested_index < 0:
            self._device_index = self._read_current_device_index()
        else:
            self._device_index = max(0, int(self._requested_index))
        self._lz = _LevelZeroSysman(self._is_admin, device_index=self._device_index)

        # BaseGPUProvider.__init__ starts the polling thread — call last
        super().__init__(interval_ms=interval_ms)

        logger.info(
            f"XPUSYSMonitor: IntelProvider started "
            f"(admin={self._is_admin}, torch={self._torch_ok}, lz={self._lz.available})"
        )

    def _read_current_device_index(self) -> int:
        """Return torch.xpu.current_device() — the GPU ComfyUI is actually using."""
        try:
            import torch
            if torch.xpu.is_available():
                idx = int(torch.xpu.current_device())
                logger.info(f"XPUSYSMonitor: following ComfyUI primary XPU device — xpu:{idx}")
                return idx
        except Exception:
            pass
        return 0

    # ------------------------------------------------------------------
    # Multi-GPU device selection
    # ------------------------------------------------------------------

    def device_count(self) -> int:
        n = self._lz.device_count()
        if n > 0:
            return n
        return 1

    def get_device_names(self) -> list:
        names = []
        total = self.device_count()
        if total == 0:
            return []
        try:
            import torch
            for i in range(total):
                try:
                    names.append(str(torch.xpu.get_device_name(i)))
                except Exception:
                    names.append(f"Intel GPU{i}")
        except Exception:
            names.append(self._lz.device_name or f"Intel GPU{self._device_index}")
        return names

    def get_selected_device(self) -> int:
        return self._device_index

    def select_device(self, index: int) -> bool:
        """Switch monitoring to another Intel GPU (rebinds Level Zero + torch)."""
        with self._hw_lock:   # 与 _poll 互斥，避免切换瞬间读到中间状态
            total = self.device_count()
            if not (0 <= index < total):
                logger.warning(f"XPUSYSMonitor: invalid Intel device index {index} (count={total})")
                return False
            if index == self._device_index:
                return True
            # Rebind Level Zero device
            if not self._lz.select_device(index):
                return False
            self._device_index = index
            logger.info(f"XPUSYSMonitor: switched to Intel device[{index}] = {self._lz.device_name!r}")
            return True

    # ------------------------------------------------------------------

    def _check_torch(self):
        try:
            import torch
            if torch.xpu.is_available():
                self._torch_ok = True
                logger.info(
                    f"XPUSYSMonitor: torch.xpu OK, "
                    f"device count={torch.xpu.device_count()}"
                )
            else:
                logger.warning("XPUSYSMonitor: torch.xpu not available.")
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: torch import error — {exc}")

    def _check_psutil(self):
        try:
            import psutil
            psutil.cpu_percent(interval=None)   # baseline call so next call is accurate
            self._psutil_ok = True
            self._cpu_model, self._cpu_threads = _get_cpu_info()
            logger.info(
                f"XPUSYSMonitor: psutil OK — CPU={self._cpu_model!r}, "
                f"threads={self._cpu_threads}"
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: psutil not available — {exc}")

    def _read_torch_stats(self) -> Tuple[float, float]:
        """Return (allocated_gb, reserved_gb) from the PyTorch XPU allocator."""
        if not self._torch_ok:
            return 0.0, 0.0
        try:
            import torch
            idx = self._device_index
            gb  = 1024 ** 3
            return (
                torch.xpu.memory_allocated(idx) / gb,
                torch.xpu.memory_reserved(idx)  / gb,
            )
        except Exception:
            return 0.0, 0.0

    def _poll(self) -> None:
        """Collect all hardware metrics and push a fresh GPUSnapshot."""
        snap = GPUSnapshot(gpu_vendor=self.GPU_VENDOR)
        snap.is_admin        = self._is_admin
        snap.power_available = self._is_admin and bool(self._lz._power_handles)

        # 硬件读取与 select_device() 互斥：切换显卡时轮询等待，保证快照一致
        with self._hw_lock:
            # VRAM total/free — Level Zero, fully GIL-free
            free_gb, total_gb        = self._lz.read_vram_state()
            snap.vram_total_gb       = total_gb
            snap.vram_free_gb        = free_gb
            snap.vram_driver_used_gb = max(0.0, total_gb - free_gb)

            # Allocator stats — torch.xpu only (no Level Zero equivalent)
            snap.vram_allocated_gb, snap.vram_reserved_gb = self._read_torch_stats()

            snap.gpu_load_pct = self._lz.read_gpu_load_pct()
            snap.gpu_freq_mhz = self._lz.read_gpu_freq_mhz()
            snap.gpu_temp_c   = self._lz.read_gpu_temp_c()
            snap.power_w      = self._lz.read_power_w()
            snap.device_name  = self._lz.device_name
            snap.pci_id       = self._lz.pci_id
            snap.tgp_w        = self._lz.tgp_w

        # CPU / RAM
        sys = _read_cpu_ram_stats(self._psutil_ok)
        snap.cpu_pct         = sys.get("cpu_pct",         0.0)
        snap.cpu_freq_ghz    = sys.get("cpu_freq_ghz",    0.0)
        snap.cpu_model       = self._cpu_model
        snap.cpu_threads     = self._cpu_threads
        snap.ram_pct         = sys.get("ram_pct",         0.0)
        snap.ram_total_gb    = sys.get("ram_total_gb",    0.0)
        snap.ram_used_gb     = sys.get("ram_used_gb",     0.0)
        snap.ram_free_gb     = sys.get("ram_free_gb",     0.0)
        snap.commit_used_gb  = sys.get("commit_used_gb",  0.0)
        snap.commit_limit_gb = sys.get("commit_limit_gb", 0.0)

        self._update_snapshot(snap)
