"""
providers/amd.py — AMD GPU hardware provider.

VRAM free/total   : rocm_smi — or torch.cuda (if AMD PyTorch)
PyTorch stats     : torch.cuda.memory_allocated / memory_reserved
GPU load          : rocm_smi
GPU frequency     : rocm_smi
GPU temperature   : rocm_smi
Power             : rocm_smi (requires ROCm installed)

Dependency: pip install rocm_smi_lib
  Or use AMD version of PyTorch which bundles ROCm components.

If ROCm is not available, falls back to basic torch.cuda stats only.
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
# AMDProvider
# ---------------------------------------------------------------------------

class AMDProvider(BaseGPUProvider):
    """
    Hardware provider for AMD GPUs (ROCm).

    Uses rocm_smi (or AMD PyTorch's torch.cuda) for GPU metrics.
    Falls back to basic torch.cuda stats if ROCm is not installed.

    Only the first GPU (index 0) is monitored.
    """

    GPU_VENDOR = "amd"

    def __init__(self, interval_ms: int = 1000):
        self._rocm_ok      = False
        self._torch_ok     = False
        self._psutil_ok   = False
        self._device_index = 0
        self._is_admin     = _is_admin()
        self._cpu_model    = ""
        self._cpu_threads  = 0

        self._init_rocm()
        self._check_torch()
        self._check_psutil()

        # BaseGPUProvider.__init__ starts the polling thread — call last
        super().__init__(interval_ms=interval_ms)

        logger.info(
            f"XPUSYSMonitor: AMDProvider started "
            f"(rocm={self._rocm_ok}, torch={self._torch_ok})"
        )

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def _init_rocm(self) -> None:
        """Initialise ROCm SMI and grab the device handle for GPU 0."""
        try:
            import rocm_smi
            rocm_smi.initializeRsmiTracking(0)
            self._rocm_ok = True
            name = rocm_smi.getCardName(0)
            logger.info(f"XPUSYSMonitor: rocm_smi OK — device[0] = {name!r}")
        except ImportError:
            logger.warning(
                "XPUSYSMonitor: rocm_smi not installed — "
                "run `pip install rocm_smi_lib` to enable full AMD support."
            )
        except Exception as exc:
            logger.warning(f"XPUSYSMonitor: rocm_smi init error — {exc}")

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

    def _read_device_name(self) -> str:
        if self._rocm_ok:
            try:
                import rocm_smi
                return rocm_smi.getCardName(0)
            except Exception:
                pass
        return "AMD GPU"

    def _read_vram(self) -> Tuple[float, float, float]:
        """Return (free_gb, total_gb, driver_used_gb)."""
        if self._rocm_ok:
            try:
                import rocm_smi
                # VRAM usage in bytes
                vram_used = rocm_smi.getMemUsedVdev(0)
                vram_free = rocm_smi.getMemFreeVdev(0)
                vram_total = rocm_smi.getMemSizeVdev(0)
                gb = 1024 ** 3
                return (
                    vram_free / gb,
                    vram_total / gb,
                    vram_used / gb,
                )
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

    def _read_gpu_load(self) -> float:
        """Return GPU utilisation % via rocm_smi."""
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # GPU busy percentage
            return float(rocm_smi.getGpuBusyVdev(0))
        except Exception:
            return 0.0

    def _read_gpu_freq_mhz(self) -> float:
        """Return current GPU clock in MHz via rocm_smi."""
        if not self._rocm_ok:
            return 0.0
        try:
            import rocm_smi
            # SCLK (system clock) in MHz
            sclk = rocm_smi.getSingleClockSpeed(0)
            if isinstance(sclk, str):
                # Some versions return string like "2100 MHz"
                sclk = int(sclk.split()[0])
            return float(sclk)
        except Exception:
            return 0.0

    def _read_gpu_temp_c(self) -> float:
        """Return GPU temperature in °C via rocm_smi."""
        if not self._rocm_ok:
            return -1.0
        try:
            import rocm_smi
            # Temperature in Celsius
            return float(rocm_smi.getTempVdev(0))
        except Exception:
            return -1.0

    def _read_power(self) -> Tuple[float, float, bool]:
        """Return (power_w, tgp_w, power_available) via rocm_smi."""
        if not self._rocm_ok:
            return -1.0, 0.0, False
        try:
            import rocm_smi
            # Power in Watts
            power_w = float(rocm_smi.getPowerVdev(0))
            # TDP (average power) - fallback to current if not available
            try:
                tgp_w = float(rocm_smi.getPowerCapVdev(0))
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

        if not self._rocm_ok and not self._torch_ok:
            # No ROCm and no torch — still collect CPU/RAM
            snap.error = "AMD ROCm unavailable"
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
