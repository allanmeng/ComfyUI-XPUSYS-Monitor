"""
providers/amd.py — AMD GPU hardware provider.

Telemetry priority:
  1. ADLXPybind (ADLX)  — Windows primary path (AMD official SDK)
  2. amdsmi             — Linux / ROCm primary path (official successor to rocm_smi)
  3. rocm_smi           — legacy ROCm fallback (old environments)
  4. torch.cuda         — basic fallback (total VRAM only)

PyTorch allocator stats always come from torch.cuda.memory_allocated /
memory_reserved (AMD PyTorch exposes allocator stats under the cuda namespace).

The ADLX implementation follows the proven call pattern from
ComfyUI-ADLX-Monitor (zvonac99): GetSupportedGPUMetrics for capability
pre-checks, then GetCurrentGPUMetrics for live values.  The amdsmi path uses
the official AMD SMI Python API (amdsmi_init / amdsmi_get_processor_handles /
amdsmi_get_gpu_*).  Only the telemetry extraction is shared — the UI and
architecture remain native to XPUSYS-Monitor.

Dependencies:
  pip install ADLXPybind        (Windows only; declared in requirements.txt)
  pip install amdsmi            (Linux / ROCm; optional, replaces rocm_smi_lib)
"""

import logging
import os
import threading
from typing import Optional, Tuple

from .base import BaseGPUProvider, GPUSnapshot
from .intel import _get_cpu_info, _read_cpu_ram_stats, _read_commit_charge  # shared system utils

logger = logging.getLogger("XPUSYSMonitor")


def _is_admin() -> bool:
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ---------------------------------------------------------------------------
# AMDProvider
# ---------------------------------------------------------------------------

class AMDProvider(BaseGPUProvider):
    """
    Hardware provider for AMD GPUs.

    Windows: ADLX (primary) — full telemetry via ADLXPybind.
    Linux  : amdsmi (primary) — official AMD SMI Python API; rocm_smi legacy fallback.
    Fallback: basic torch.cuda stats if no vendor telemetry is available.

    Multi-GPU: device selection is exposed via select_device(index); on the
    ADLX path the GPU list from GetGPUs() is indexed directly, on the amdsmi
    path the processor handle list is indexed directly.  The default picks
    the GPU with the largest VRAM (matches ComfyUI-ADLX-Monitor).
    """

    GPU_VENDOR = "amd"

    def __init__(self, interval_ms: int = 1000):
        self._adlx_ok      = False
        self._adlx         = None
        self._adlx_helper  = None
        self._adlx_system  = None
        self._adlx_perf    = None
        self._adlx_gpus    = []        # full GPU list (for select_device)
        self._adlx_gpu     = None      # currently selected GPU object
        self._amdsmi_ok    = False
        self._amdsmi       = None
        self._amdsmi_handles = []      # full processor handles (for select_device)
        self._amdsmi_handle  = None    # currently selected handle
        self._rocm_ok      = False
        self._torch_ok     = False
        self._psutil_ok    = False
        self._device_index = 0
        self._is_admin     = _is_admin()
        self._cpu_model    = ""
        self._cpu_threads  = 0
        # Guards hardware handle rebinding (select_device runs on the HTTP
        # thread) against concurrent reads in the polling thread.
        self._hw_lock      = threading.Lock()

        self._init_adlx()
        self._init_amdsmi()
        self._init_rocm()
        self._check_torch()
        self._check_psutil()

        # BaseGPUProvider.__init__ starts the polling thread — call last
        super().__init__(interval_ms=interval_ms)

        logger.info(
            f"XPUSYSMonitor: AMDProvider started "
            f"(adlx={self._adlx_ok}, amdsmi={self._amdsmi_ok}, "
            f"rocm={self._rocm_ok}, torch={self._torch_ok})"
        )

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_adlx(self) -> None:
        """Initialise ADLX on Windows and pick the most capable AMD GPU."""
        if os.name != "nt":
            return

        try:
            import ADLXPybind as ADLX

            helper = ADLX.ADLXHelper()
            result = helper.Initialize()
            if result != ADLX.ADLX_RESULT.ADLX_OK:
                logger.warning(f"XPUSYSMonitor: ADLX init returned {result}.")
                return

            system = helper.GetSystemServices()
            perf = system.GetPerformanceMonitoringServices() if system is not None else None
            gpus = system.GetGPUs() if system is not None else []

            if not gpus or perf is None:
                logger.warning(
                    "XPUSYSMonitor: ADLX initialized but no AMD GPU metrics are available."
                )
                return

            # Default: GPU with the largest VRAM (matches ADLX-Monitor strategy)
            gpu = max(gpus, key=lambda item: getattr(item, "TotalVRAM")())

            self._adlx = ADLX
            self._adlx_helper = helper
            self._adlx_system = system
            self._adlx_perf = perf
            self._adlx_gpus = list(gpus)
            self._adlx_gpu = gpu
            self._adlx_ok = True
            logger.info(
                "XPUSYSMonitor: ADLX OK — selected AMD GPU %r with %.2f GB VRAM "
                "(%d GPU(s) detected).",
                gpu.Name(),
                float(gpu.TotalVRAM()) / 1024.0,
                len(gpus),
            )
        except ImportError:
            logger.info(
                "XPUSYSMonitor: ADLXPybind not installed — "
                "Windows AMD telemetry disabled (install with `pip install ADLXPybind`)."
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: ADLX init error — {exc}")

    def _init_amdsmi(self) -> None:
        """Initialise AMD SMI (amdsmi) on Linux/ROCm if ADLX is unavailable."""
        if self._adlx_ok:
            return
        try:
            import amdsmi

            amdsmi.amdsmi_init()
            handles = amdsmi.amdsmi_get_processor_handles()
            if not handles:
                logger.warning("XPUSYSMonitor: amdsmi initialized but no AMD GPUs found.")
                return

            name = "AMD GPU"
            try:
                info = amdsmi.amdsmi_get_gpu_asic_info(handles[0])
                name = info.get("market_name", "AMD GPU")
            except Exception:
                pass

            self._amdsmi = amdsmi
            self._amdsmi_handles = list(handles)
            self._amdsmi_handle = handles[0]
            self._amdsmi_ok = True
            logger.info(
                "XPUSYSMonitor: amdsmi OK — device[0] = %r (%d GPU(s) detected).",
                name,
                len(handles),
            )
        except ImportError:
            logger.info(
                "XPUSYSMonitor: amdsmi not installed — "
                "run `pip install amdsmi` to enable full Linux AMD support."
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: amdsmi init error — {exc}")

    def _init_rocm(self) -> None:
        """Initialise ROCm SMI (legacy fallback) if ADLX/amdsmi are unavailable."""
        if self._adlx_ok or self._amdsmi_ok:
            return
        try:
            import rocm_smi
            rocm_smi.initializeRsmiTracking(self._device_index)
            self._rocm_ok = True
            name = rocm_smi.getCardName(self._device_index)
            logger.info(f"XPUSYSMonitor: rocm_smi OK — device[{self._device_index}] = {name!r}")
        except ImportError:
            logger.warning(
                "XPUSYSMonitor: rocm_smi not installed — "
                "run `pip install rocm_smi_lib` to enable full AMD support."
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: rocm_smi init error — {exc}")

    # ------------------------------------------------------------------
    # Multi-GPU device selection
    # ------------------------------------------------------------------

    def device_count(self) -> int:
        if self._adlx_ok:
            return len(self._adlx_gpus)
        if self._amdsmi_ok:
            return len(self._amdsmi_handles)
        try:
            import rocm_smi
            return int(rocm_smi.getDeviceCount())
        except Exception:
            return 1

    def get_device_names(self) -> list:
        if self._adlx_ok:
            names = []
            for gpu in self._adlx_gpus:
                try:
                    names.append(str(gpu.Name()))
                except Exception:
                    names.append("AMD GPU")
            return names
        if self._amdsmi_ok:
            names = []
            for handle in self._amdsmi_handles:
                try:
                    info = self._amdsmi.amdsmi_get_gpu_asic_info(handle)
                    names.append(str(info.get("market_name", "AMD GPU")))
                except Exception:
                    names.append("AMD GPU")
            return names
        names = []
        try:
            import rocm_smi
            for i in range(self.device_count()):
                try:
                    names.append(str(rocm_smi.getCardName(i)))
                except Exception:
                    names.append(f"AMD GPU{i}")
        except Exception:
            names.append(self._read_device_name())
        return names

    def get_selected_device(self) -> int:
        return self._device_index

    def select_device(self, index: int) -> bool:
        """Switch monitoring to another AMD GPU (rebinds ADLX/amdsmi/rocm_smi)."""
        with self._hw_lock:
            if self._adlx_ok:
                total = len(self._adlx_gpus)
                if not (0 <= index < total):
                    logger.warning(f"XPUSYSMonitor: invalid AMD device index {index} (count={total})")
                    return False
                if index == self._device_index:
                    return True
                try:
                    self._adlx_gpu = self._adlx_gpus[index]
                    self._device_index = index
                    logger.info(
                        f"XPUSYSMonitor: switched to AMD device[{index}] = {self._adlx_gpu.Name()!r}"
                    )
                    return True
                except Exception as exc:
                    logger.warning(f"XPUSYSMonitor: ADLX select_device failed — {exc}")
                    return False
            if self._amdsmi_ok:
                total = len(self._amdsmi_handles)
                if not (0 <= index < total):
                    logger.warning(f"XPUSYSMonitor: invalid AMD device index {index} (count={total})")
                    return False
                if index == self._device_index:
                    return True
                try:
                    self._amdsmi_handle = self._amdsmi_handles[index]
                    self._device_index = index
                    info = self._amdsmi.amdsmi_get_gpu_asic_info(self._amdsmi_handle)
                    name = info.get("market_name", "AMD GPU")
                    logger.info(f"XPUSYSMonitor: switched to AMD device[{index}] = {name!r}")
                    return True
                except Exception as exc:
                    logger.warning(f"XPUSYSMonitor: amdsmi select_device failed — {exc}")
                    return False
            try:
                import rocm_smi
                count = int(rocm_smi.getDeviceCount())
                if not (0 <= index < count):
                    logger.warning(f"XPUSYSMonitor: invalid AMD device index {index} (count={count})")
                    return False
                self._device_index = index
                try:
                    name = rocm_smi.getCardName(index)
                except Exception:
                    name = f"AMD GPU{index}"
                logger.info(f"XPUSYSMonitor: switched to AMD device[{index}] = {name!r}")
                return True
            except Exception as exc:
                logger.warning(f"XPUSYSMonitor: select_device failed — {exc}")
                return False

    def _check_torch(self) -> None:
        """Check if torch.cuda is available (AMD PyTorch uses cuda backend)."""
        try:
            import torch
            if torch.cuda.is_available():
                self._torch_ok = True
                logger.info(
                    f"XPUSYSMonitor: torch.cuda OK (AMD), "
                    f"device count={torch.cuda.device_count()}"
                )
            else:
                logger.warning("XPUSYSMonitor: torch.cuda not available.")
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: torch import error — {exc}")

    def _check_psutil(self) -> None:
        try:
            import psutil
            psutil.cpu_percent(interval=None)
            self._psutil_ok = True
            self._cpu_model, self._cpu_threads = _get_cpu_info()
            logger.info(
                f"XPUSYSMonitor: psutil OK — CPU={self._cpu_model!r}, "
                f"threads={self._cpu_threads}"
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: psutil not available — {exc}")

    # ------------------------------------------------------------------
    # Hardware reads
    # ------------------------------------------------------------------

    def _get_adlx_support_and_metrics(self) -> Tuple[Optional[object], Optional[object]]:
        """Return (support, metrics) from ADLX, or (None, None) when unavailable."""
        if not self._adlx_ok or self._adlx_perf is None or self._adlx_gpu is None:
            return None, None
        try:
            support = self._adlx_perf.GetSupportedGPUMetrics(self._adlx_gpu)
            metrics = self._adlx_perf.GetCurrentGPUMetrics(self._adlx_gpu)
            return support, metrics
        except Exception:
            return None, None

    @staticmethod
    def _read_adlx_metric(support, metrics, support_name: str, metric_name: str, default: float) -> float:
        """Read an ADLX metric guarded by its capability pre-check."""
        if support is None or metrics is None:
            return default
        try:
            if not getattr(support, support_name)():
                return default
            return float(getattr(metrics, metric_name)())
        except Exception:
            return default

    def _read_device_name(self) -> str:
        if self._adlx_ok and self._adlx_gpu is not None:
            try:
                return self._adlx_gpu.Name()
            except Exception:
                pass
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                info = self._amdsmi.amdsmi_get_gpu_asic_info(self._amdsmi_handle)
                return str(info.get("market_name", "AMD GPU"))
            except Exception:
                pass
        if self._rocm_ok:
            try:
                import rocm_smi
                return rocm_smi.getCardName(self._device_index)
            except Exception:
                pass
        if self._torch_ok:
            try:
                import torch
                return torch.cuda.get_device_name(self._device_index)
            except Exception:
                pass
        return "AMD GPU"

    def _read_pci_id(self) -> str:
        """Return PCI device ID as hex string e.g. '0x744c', or '' on failure.

        Priority:
          1. ADLX — IADLXGPU::DeviceId() returns the manufacturer-programmed
             4-digit hex device id (GPUOpen: "consists of four hexadecimal
             digits"), which is the PCI device ID used by gpu_specs.json.
             The Python binding method name varies by ADLXPybind build, so
             several candidates are tried and the result normalised to
             "0x" + 4 hex digits.
          2. rocm_smi — getPciId returns the device id directly.
          3. amdsmi — exposes only the BDF (bus:device.function), which is
             not a device ID → skipped (frontend name_match fallback covers it).

        When no vendor path yields a device ID, this returns '' and the
        frontend resolves the SPEC capsule via matchSpecByName instead.
        """
        if self._adlx_ok and self._adlx_gpu is not None:
            try:
                gpu = self._adlx_gpu
                # Candidate names across ADLXPybind builds / pybind11 bindings
                for name in ("DeviceId", "DeviceID", "deviceId", "DeviceID_"):
                    fn = getattr(gpu, name, None)
                    if fn is None:
                        continue
                    raw = fn()
                    # pybind11 may return (ADLX_RESULT, str) or the bare string
                    if isinstance(raw, tuple):
                        raw = raw[1] if len(raw) > 1 else ""
                    if raw is None:
                        continue
                    s = str(raw).strip().lower()
                    if s.startswith("0x"):
                        s = s[2:]
                    if len(s) == 4 and all(ch in "0123456789abcdef" for ch in s):
                        return "0x" + s
                logger.debug(
                    "XPUSYSMonitor: ADLX DeviceId not resolvable "
                    "(has %s) — SPEC falls back to name matching.",
                    ", ".join(n for n in ("DeviceId", "DeviceID", "deviceId", "DeviceID_") if hasattr(gpu, n)) or "none",
                )
            except Exception as exc:
                logger.debug(f"XPUSYSMonitor: ADLX DeviceId read error — {exc}")
        if self._amdsmi_ok:
            # amdsmi_get_gpu_device_bdf gives BDF, not a PCI device ID — skip.
            pass
        if self._rocm_ok:
            try:
                import rocm_smi
                # rocm_smi.getPciId returns PCI ID as hex string like "0x744c"
                raw = rocm_smi.getPciId(self._device_index)
                if isinstance(raw, int):
                    return f"0x{raw:04x}"
                raw = str(raw).strip().lower()
                if raw.startswith("0x"):
                    return raw
                return f"0x{raw}"
            except Exception:
                pass
        if self._torch_ok:
            try:
                import torch
                # torch.cuda.get_device_properties may expose pci_bus_id; the
                # bus:dev.func form is not a device ID — not usable for lookup.
                props = torch.cuda.get_device_properties(self._device_index)
                _ = getattr(props, "pci_bus_id", None)
            except Exception:
                pass
        return ""

    def _read_vram(self, support=None, metrics=None) -> Tuple[float, float, float]:
        """Return (free_gb, total_gb, driver_used_gb)."""
        if self._adlx_ok and self._adlx_gpu is not None:
            try:
                total_mb = float(self._adlx_gpu.TotalVRAM())
                used_mb = self._read_adlx_metric(support, metrics, "IsSupportedGPUVRAM", "GPUVRAM", 0.0)
                total_gb = total_mb / 1024.0
                used_gb = used_mb / 1024.0
                free_gb = max(total_gb - used_gb, 0.0)
                return free_gb, total_gb, used_gb
            except Exception:
                pass
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                vram = self._amdsmi.amdsmi_get_gpu_vram_usage(self._amdsmi_handle)
                gb = 1024 ** 3
                total_gb = float(vram.get("vram_total", 0)) / gb
                used_gb = float(vram.get("vram_used", 0)) / gb
                free_gb = max(total_gb - used_gb, 0.0)
                return free_gb, total_gb, used_gb
            except Exception:
                pass
        if self._rocm_ok:
            try:
                import rocm_smi
                # VRAM usage in bytes
                vram_used = rocm_smi.getMemUsedVdev(self._device_index)
                vram_free = rocm_smi.getMemFreeVdev(self._device_index)
                vram_total = rocm_smi.getMemSizeVdev(self._device_index)
                gb = 1024 ** 3
                return (
                    vram_free / gb,
                    vram_total / gb,
                    vram_used / gb,
                )
            except Exception:
                pass

        # Fallback: torch.cuda (AMD PyTorch without rocm_smi)
        if self._torch_ok:
            try:
                import torch
                gb = 1024 ** 3
                total = torch.cuda.get_device_properties(self._device_index).total_memory / gb
                return 0.0, total, 0.0  # free/used unavailable without rocm_smi
            except Exception:
                pass

        return 0.0, 0.0, 0.0

    def _read_torch_stats(self) -> Tuple[float, float]:
        """Return (allocated_gb, reserved_gb) from torch.cuda allocator."""
        if not self._torch_ok:
            return 0.0, 0.0
        try:
            import torch
            idx = self._device_index
            gb = 1024 ** 3
            return (
                torch.cuda.memory_allocated(idx) / gb,
                torch.cuda.memory_reserved(idx) / gb,
            )
        except Exception:
            return 0.0, 0.0

    def _read_gpu_load(self, support=None, metrics=None) -> float:
        """Return GPU utilisation % via ADLX, amdsmi or rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUUsage", "GPUUsage", 0.0)
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                activity = self._amdsmi.amdsmi_get_gpu_activity(self._amdsmi_handle)
                return float(activity.get("gfx_activity", 0.0))
            except Exception:
                return 0.0
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # GPU busy percentage
            return float(rocm_smi.getGpuBusyVdev(self._device_index))
        except Exception:
            return 0.0

    def _read_gpu_freq_mhz(self, support=None, metrics=None) -> float:
        """Return current GPU clock in MHz via ADLX, amdsmi or rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUClockSpeed", "GPUClockSpeed", 0.0)
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                clk = self._amdsmi.amdsmi_get_clock_info(
                    self._amdsmi_handle,
                    self._amdsmi.AmdSmiClkType.GFX,
                )
                return float(clk.get("cur_clk", 0.0))
            except Exception:
                return 0.0
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # SCLK (system clock) in MHz
            sclk = rocm_smi.getSingleClockSpeed(self._device_index)
            if isinstance(sclk, str):
                # Some versions return string like "2100 MHz"
                sclk = int(sclk.split()[0])
            return float(sclk)
        except Exception:
            return 0.0

    def _read_gpu_temp_c(self, support=None, metrics=None) -> float:
        """Return GPU temperature in °C via ADLX, amdsmi or rocm_smi."""
        if self._adlx_ok:
            return self._read_adlx_metric(support, metrics, "IsSupportedGPUTemperature", "GPUTemperature", -1.0)
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                temp = self._amdsmi.amdsmi_get_temp_metric(
                    self._amdsmi_handle,
                    self._amdsmi.AmdSmiTemperatureType.EDGE,
                    self._amdsmi.AmdSmiTemperatureMetric.CURRENT,
                )
                return float(temp)
            except Exception:
                return -1.0
        if not self._rocm_ok:
            return -1.0
        try:
            import rocm_smi
            # Temperature in Celsius
            return float(rocm_smi.getTempVdev(self._device_index))
        except Exception:
            return -1.0

    def _read_power(self, support=None, metrics=None) -> Tuple[float, float, bool]:
        """Return (power_w, tgp_w, power_available) via ADLX, amdsmi or rocm_smi."""
        if self._adlx_ok:
            board_power = self._read_adlx_metric(
                support,
                metrics,
                "IsSupportedGPUTotalBoardPower",
                "GPUTotalBoardPower",
                -1.0,
            )
            chip_power = self._read_adlx_metric(
                support,
                metrics,
                "IsSupportedGPUPower",
                "GPUPower",
                -1.0,
            )
            if board_power >= 0.0:
                return (chip_power if chip_power >= 0.0 else board_power), board_power, True
            if chip_power >= 0.0:
                return chip_power, chip_power, True
            return -1.0, 0.0, False
        if self._amdsmi_ok and self._amdsmi_handle is not None:
            try:
                power = self._amdsmi.amdsmi_get_power_info(self._amdsmi_handle)
                # Field names vary across amdsmi versions (5.7 vs 7.x)
                power_w = power.get("current_socket_power")
                if power_w is None:
                    power_w = power.get("average_socket_power")
                power_w = float(power_w) if power_w is not None else -1.0
                tgp_w = float(power.get("power_limit", 0.0) or 0.0)
                if power_w >= 0.0:
                    return power_w, tgp_w, True
                return -1.0, tgp_w, False
            except Exception:
                return -1.0, 0.0, False
        if not self._rocm_ok:
            return -1.0, 0.0, False
        try:
            import rocm_smi
            # Power in Watts
            power_w = float(rocm_smi.getPowerVdev(self._device_index))
            # TDP (average power) - fallback to current if not available
            try:
                tgp_w = float(rocm_smi.getPowerCapVdev(self._device_index))
            except Exception:
                tgp_w = power_w  # Use current as estimate
            return power_w, tgp_w, True
        except Exception:
            return -1.0, 0.0, False

    # ------------------------------------------------------------------
    # Poll — called by BaseGPUProvider._loop() every interval
    # ------------------------------------------------------------------

    def _poll(self) -> None:
        """Collect all hardware metrics and push a fresh GPUSnapshot."""
        snap = GPUSnapshot(gpu_vendor=self.GPU_VENDOR)
        snap.is_admin = self._is_admin

        if not (self._adlx_ok or self._amdsmi_ok or self._rocm_ok or self._torch_ok):
            # No AMD telemetry at all — still collect CPU/RAM
            snap.error = "AMD telemetry unavailable"
        else:
            try:
                with self._hw_lock:
                    snap.device_name = self._read_device_name()
                    snap.pci_id      = self._read_pci_id()

                    support, metrics = self._get_adlx_support_and_metrics()

                    # VRAM
                    free_gb, total_gb, driver_used_gb = self._read_vram(support, metrics)
                    snap.vram_total_gb       = total_gb
                    snap.vram_free_gb        = free_gb
                    snap.vram_driver_used_gb = driver_used_gb

                    # torch allocator stats
                    snap.vram_allocated_gb, snap.vram_reserved_gb = self._read_torch_stats()

                    # GPU metrics
                    snap.gpu_load_pct = self._read_gpu_load(support, metrics)
                    snap.gpu_freq_mhz = self._read_gpu_freq_mhz(support, metrics)
                    snap.gpu_temp_c   = self._read_gpu_temp_c(support, metrics)

                    # Power
                    snap.power_w, snap.tgp_w, snap.power_available = self._read_power(support, metrics)

            except Exception as exc:
                logger.debug(f"XPUSYSMonitor: AMDProvider poll error — {exc}")
                snap.error = str(exc)

        # CPU / RAM — always collected regardless of GPU state
        sys = _read_cpu_ram_stats(self._psutil_ok)
        snap.cpu_pct         = sys.get("cpu_pct",         0.0)
        snap.cpu_freq_ghz    = sys.get("cpu_freq_ghz",    0.0)
        snap.cpu_model       = self._cpu_model
        snap.cpu_threads     = self._cpu_threads
        snap.ram_pct         = sys.get("ram_pct",         0.0)
        snap.ram_total_gb    = sys.get("ram_total_gb",    0.0)
        snap.ram_used_gb     = sys.get("ram_used_gb",      0.0)
        snap.ram_free_gb     = sys.get("ram_free_gb",      0.0)
        snap.commit_used_gb  = sys.get("commit_used_gb",   0.0)
        snap.commit_limit_gb = sys.get("commit_limit_gb",  0.0)

        self._update_snapshot(snap)


__all__ = ["AMDProvider"]
