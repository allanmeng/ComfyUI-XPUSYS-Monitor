"""
providers/nvidia.py — NVIDIA GPU hardware provider.

VRAM free/total   : pynvml — nvmlDeviceGetMemoryInfo
PyTorch stats     : torch.cuda.memory_allocated / memory_reserved
GPU load          : pynvml — nvmlDeviceGetUtilizationRates
GPU frequency     : pynvml — nvmlDeviceGetClockInfo (GRAPHICS clock)
GPU temperature   : pynvml — nvmlDeviceGetTemperature  (no admin required)
Power / TGP       : pynvml — nvmlDeviceGetPowerUsage / GetEnforcedPowerLimit
                             (no admin required on most NVIDIA drivers)

Dependency: pip install pynvml
  Included in nvidia-ml-py, which ships with most NVIDIA CUDA toolkits.
  If pynvml is not installed or no NVIDIA driver is present, this provider
  will raise ImportError / NVMLError at init time — the factory catches it.
"""

import logging
import os
from typing import Tuple

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
# NvidiaProvider
# ---------------------------------------------------------------------------

class NvidiaProvider(BaseGPUProvider):
    """
    Hardware provider for NVIDIA GPUs.

    Uses pynvml (nvidia-ml-py) for all GPU metrics.  Unlike the Intel
    provider, temperature and power do NOT require administrator privileges
    on NVIDIA drivers.

    Only the first GPU (index 0) is monitored — multi-GPU support can be
    added later if needed.
    """

    GPU_VENDOR = "nvidia"

    def __init__(self, interval_ms: int = 1000):
        self._nvml_ok      = False
        self._handle       = None   # nvml device handle for GPU 0
        self._torch_ok     = False
        self._psutil_ok    = False
        self._device_index = 0
        self._is_admin     = _is_admin()
        self._cpu_model    = ""
        self._cpu_threads  = 0

        self._init_nvml()
        self._check_torch()
        self._check_psutil()

        # BaseGPUProvider.__init__ starts the polling thread — call last
        super().__init__(interval_ms=interval_ms)

        logger.info(
            f"XPUSYSMonitor: NvidiaProvider started "
            f"(nvml={self._nvml_ok}, torch={self._torch_ok})"
        )

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_nvml(self) -> None:
        """Initialise pynvml and grab the device handle for GPU 0."""
        try:
            import pynvml
            pynvml.nvmlInit()
            count = pynvml.nvmlDeviceGetCount()
            if count == 0:
                logger.warning("XPUSYSMonitor: pynvml — no NVIDIA devices found.")
                return
            self._handle  = pynvml.nvmlDeviceGetHandleByIndex(self._device_index)
            self._nvml_ok = True
            name = pynvml.nvmlDeviceGetName(self._handle)
            # pynvml may return bytes on older versions
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            logger.info(f"XPUSYSMonitor: pynvml OK — device[0] = {name!r}")
        except ImportError:
            logger.warning(
                "XPUSYSMonitor: pynvml not installed — "
                "run `pip install pynvml` to enable NVIDIA support."
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: pynvml init error — {exc}")

    def _check_torch(self) -> None:
        try:
            import torch
            if torch.cuda.is_available():
                self._torch_ok = True
                logger.info(
                    f"XPUSYSMonitor: torch.cuda OK, "
                    f"device count={torch.cuda.device_count()}"
                )
            else:
                logger.warning("XPUSYSMonitor: torch.cuda not available.")
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: torch import error — {exc}")

    def _check_psutil(self) -> None:
        try:
            import psutil
            psutil.cpu_percent(interval=None)   # baseline call
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

    def _read_device_name(self) -> str:
        try:
            import pynvml
            name = pynvml.nvmlDeviceGetName(self._handle)
            if isinstance(name, bytes):
                name = name.decode("utf-8", errors="replace")
            return name
        except Exception:
            return "NVIDIA GPU"

    def _read_vram(self) -> Tuple[float, float, float]:
        """Return (free_gb, total_gb, driver_used_gb)."""
        try:
            import pynvml
            info = pynvml.nvmlDeviceGetMemoryInfo(self._handle)
            gb = 1024 ** 3
            total = info.total / gb
            free  = info.free  / gb
            used  = info.used  / gb
            return free, total, used
        except Exception:
            return 0.0, 0.0, 0.0

    def _read_torch_stats(self) -> Tuple[float, float]:
        """Return (allocated_gb, reserved_gb) from torch.cuda allocator."""
        if not self._torch_ok:
            return 0.0, 0.0
        try:
            import torch
            idx = self._device_index
            gb  = 1024 ** 3
            return (
                torch.cuda.memory_allocated(idx) / gb,
                torch.cuda.memory_reserved(idx)  / gb,
            )
        except Exception:
            return 0.0, 0.0

    def _read_gpu_load(self) -> float:
        """Return GPU utilisation % via nvmlDeviceGetUtilizationRates."""
        try:
            import pynvml
            rates = pynvml.nvmlDeviceGetUtilizationRates(self._handle)
            return float(rates.gpu)
        except Exception:
            return 0.0

    def _read_gpu_freq_mhz(self) -> float:
        """Return current GPU graphics clock in MHz."""
        try:
            import pynvml
            # NVML_CLOCK_GRAPHICS = 0
            return float(pynvml.nvmlDeviceGetClockInfo(self._handle, 0))
        except Exception:
            return 0.0

    def _read_gpu_temp_c(self) -> float:
        """Return GPU temperature in °C. No admin required on NVIDIA."""
        try:
            import pynvml
            # NVML_TEMPERATURE_GPU = 0
            return float(pynvml.nvmlDeviceGetTemperature(self._handle, 0))
        except Exception:
            return -1.0

    def _read_power(self) -> Tuple[float, float, bool]:
        """Return (power_w, tgp_w, power_available)."""
        try:
            import pynvml
            # nvmlDeviceGetPowerUsage returns milliwatts
            power_mw = pynvml.nvmlDeviceGetPowerUsage(self._handle)
            power_w  = power_mw / 1000.0

            # Enforced power limit (TGP) in milliwatts
            try:
                tgp_mw = pynvml.nvmlDeviceGetEnforcedPowerLimit(self._handle)
                tgp_w  = tgp_mw / 1000.0
            except Exception:
                tgp_w = 0.0

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

        if not self._nvml_ok or self._handle is None:
            # nvml unavailable — still collect CPU/RAM
            snap.error = "pynvml unavailable"
        else:
            try:
                snap.device_name = self._read_device_name()

                # VRAM
                free_gb, total_gb, driver_used_gb = self._read_vram()
                snap.vram_total_gb       = total_gb
                snap.vram_free_gb        = free_gb
                snap.vram_driver_used_gb = driver_used_gb

                # torch allocator stats
                snap.vram_allocated_gb, snap.vram_reserved_gb = self._read_torch_stats()

                # GPU metrics
                snap.gpu_load_pct = self._read_gpu_load()
                snap.gpu_freq_mhz = self._read_gpu_freq_mhz()
                snap.gpu_temp_c   = self._read_gpu_temp_c()

                # Power
                snap.power_w, snap.tgp_w, snap.power_available = self._read_power()

            except Exception as exc:
                logger.debug(f"XPUSYSMonitor: NvidiaProvider poll error — {exc}")
                snap.error = str(exc)

        # CPU / RAM — always collected regardless of GPU state
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
