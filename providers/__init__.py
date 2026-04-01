"""
providers/__init__.py — Provider registry and auto-detection factory.

Usage:
    from .providers import auto_detect_provider, BaseGPUProvider, GPUSnapshot

    provider = auto_detect_provider(interval_ms=1000)
    snap = provider.get_snapshot()

Detection strategy — align with ComfyUI's own device selection:
  ComfyUI uses torch.cuda.is_available() for NVIDIA and torch.xpu.is_available()
  for Intel.  We follow the same signals so the monitor always tracks whichever
  device ComfyUI is actually running on.

Detection order:
  1. torch.cuda.is_available() + torch.version.roc → AMDProvider   (ROCm)
  2. torch.cuda.is_available()                    → NvidiaProvider (NVIDIA)
  3. torch.xpu.is_available()                    → IntelProvider  (Intel Arc)
  4. ze_loader.dll present                        → IntelProvider  (fallback)
  5. pynvml available                             → NvidiaProvider (fallback)
  6. Last resort                                 → IntelProvider  (limited)

Fallback tiers 4-5 cover edge cases where torch is not yet imported or the
user is running a non-standard environment without torch.
"""

import logging
from .base import BaseGPUProvider, GPUSnapshot

logger = logging.getLogger("XPUSYSMonitor")


def auto_detect_provider(interval_ms: int = 1000) -> BaseGPUProvider:
    """
    Detect the available GPU hardware and return the appropriate provider.

    Primary strategy: mirror ComfyUI's own torch-based device selection so the
    monitor always tracks the same device that ComfyUI is running inference on.
    Fallback strategy: raw driver/library probing for non-standard environments.
    """

    # --- Primary: follow torch (mirrors ComfyUI model_management.py) ---
    if _detect_nvidia_torch():
        # torch.cuda available — determine if NVIDIA or AMD via torch.version.roc
        if _is_amd_rocme():
            # torch.version.roc is not None → AMD ROCm
            logger.info("XPUSYSMonitor: torch.cuda + ROCm — using AMDProvider.")
            from .amd import AMDProvider
            return AMDProvider(interval_ms=interval_ms)
        else:
            # torch.version.roc is None → NVIDIA
            logger.info("XPUSYSMonitor: torch.cuda (NVIDIA) — using NvidiaProvider.")
            from .nvidia import NvidiaProvider
            return NvidiaProvider(interval_ms=interval_ms)

    if _detect_intel_torch():
        logger.info("XPUSYSMonitor: torch.xpu available — using IntelProvider.")
        from .intel import IntelProvider
        return IntelProvider(interval_ms=interval_ms)

    # --- Fallback: raw driver probing (torch not imported yet / non-std env) ---
    if _detect_intel_driver():
        logger.info(
            "XPUSYSMonitor: ze_loader.dll found (torch unavailable) — "
            "using IntelProvider."
        )
        from .intel import IntelProvider
        return IntelProvider(interval_ms=interval_ms)

    if _detect_nvidia_driver():
        logger.info(
            "XPUSYSMonitor: NVIDIA driver found (torch unavailable) — "
            "using NvidiaProvider."
        )
        from .nvidia import NvidiaProvider
        return NvidiaProvider(interval_ms=interval_ms)

    # --- Last resort ---
    logger.warning(
        "XPUSYSMonitor: no supported GPU detected — "
        "falling back to IntelProvider (limited functionality)."
    )
    from .intel import IntelProvider
    return IntelProvider(interval_ms=interval_ms)


# ---------------------------------------------------------------------------
# Primary detectors — torch-based (align with ComfyUI)
# ---------------------------------------------------------------------------

def _detect_nvidia_torch() -> bool:
    """Return True if torch has a working CUDA backend (mirrors ComfyUI)."""
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def _detect_intel_torch() -> bool:
    """Return True if torch has a working XPU backend (mirrors ComfyUI)."""
    try:
        import torch
        return torch.xpu.is_available()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Fallback detectors — raw driver / library probing
# Used when torch is not yet available or in non-standard environments.
# ---------------------------------------------------------------------------

def _detect_intel_driver() -> bool:
    """Return True if Intel Level Zero runtime (ze_loader.dll) is present."""
    import ctypes
    try:
        ctypes.WinDLL("ze_loader.dll")
        return True
    except OSError:
        return False


def _detect_nvidia_driver() -> bool:
    """Return True if pynvml is installed and NVIDIA driver is reachable."""
    try:
        import pynvml
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        pynvml.nvmlShutdown()
        return count > 0
    except Exception:
        return False


def _is_amd_rocme() -> bool:
    """
    Check if torch.cuda is backed by AMD ROCm.

    Returns True if torch.version.roc is not None (AMD ROCm PyTorch).
    Returns False if torch.version.roc is None (NVIDIA or standard CUDA).
    """
    try:
        import torch
        # torch.version.roc: True/str = AMD ROCm, None = NVIDIA/other
        return torch.version.roc is not None
    except Exception:
        return False


__all__ = [
    "BaseGPUProvider",
    "GPUSnapshot",
    "auto_detect_provider",
]
