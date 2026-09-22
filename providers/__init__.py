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
  3. AMD driver present + ADLX GPU list (Windows) → AMDProvider   (ADLX)
  4. amdsmi / hip / sysfs vendor (Linux)          → AMDProvider   (amdsmi)
  5. torch.xpu.is_available()                    → IntelProvider  (Intel Arc)
  6. ze_loader.dll present                        → IntelProvider  (fallback)
  7. pynvml available                             → NvidiaProvider (fallback)
  8. Last resort                                 → IntelProvider  (limited)

Fallback tiers 6-7 cover edge cases where torch is not yet imported or the
user is running a non-standard environment without torch.

Tiers 3-4 are AMD signals independent of torch.cuda: Windows AMD machines use
ADLX, Linux AMD machines use amdsmi (or hip / sysfs vendor probing).  Tier 3
sits after the torch.cuda tiers so mixed AMD+NVIDIA machines keep following
ComfyUI's primary device (NVIDIA).  Tier 4 sits before the Intel tier so an
AMD dGPU on Linux is never shadowed by an Intel iGPU (issue #5).

Tier 3 needs the *optional* ADLXPybind wheel; Windows AMD users install it
manually (see requirements.txt — it is deliberately not auto-installed, because
shipping a native AMD extension to every Windows machine is exactly what broke
startup before).  Two guards protect everyone else:

  * ADLX is only ever touched after _amd_gpu_present() — a passive, crash-free
    pre-check for AMD hardware or driver — has confirmed it is worth probing.
    Handing control to the AMD runtime on a machine that has a stray
    amdadlx64.dll but no usable AMD runtime can end the process with a native
    access violation, which no `try/except` can contain.
  * When AMD hardware is present but ADLX is unusable, tier 3 logs an explicit
    and actionable hint (wheel missing vs. wheel present but init failed)
    instead of silently degrading into a bare "no supported GPU detected".
"""

import logging
import os
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

    # Windows AMD-only machines (non-ROCm torch): ADLX is the full telemetry path
    adlx_available = _detect_adlx()
    if adlx_available:
        logger.info("XPUSYSMonitor: ADLX available (Windows AMD) — using AMDProvider.")
        from .amd import AMDProvider
        return AMDProvider(interval_ms=interval_ms)

    # AMD hardware or driver is present, yet ADLX is unusable.  Windows AMD has no
    # other telemetry path, and letting this fall through silently would surface
    # only a bare "no supported GPU detected" from the tiers below — which tells
    # the user nothing.  State the real cause and the fix instead.
    # Provider selection is deliberately left untouched: _amd_gpu_present() is a
    # loose gate (it also accepts stray AMD driver DLLs), so it must never decide
    # which provider a machine gets.
    if _amd_gpu_present():
        if _adlx_installed():
            logger.warning(
                "XPUSYSMonitor: AMD GPU detected but ADLX failed to initialise — "
                "AMD GPU telemetry is unavailable (check the AMD driver install)."
            )
        else:
            logger.warning(
                "XPUSYSMonitor: AMD GPU or AMD display driver detected, but the "
                "optional ADLXPybind package is not installed — Windows AMD "
                "telemetry is unavailable.  For full monitoring run:  "
                "pip install ADLXPybind"
            )

    # Linux AMD machines (non-ROCm torch / container): amdsmi or sysfs probing.
    # Must run BEFORE the Intel tier so an AMD dGPU is never shadowed by an
    # Intel iGPU (issue #5: RX 9070 XT + Ultra 7 265K misdetected as iGPU).
    if _detect_amd_linux():
        logger.info("XPUSYSMonitor: AMD detected on Linux — using AMDProvider.")
        from .amd import AMDProvider
        return AMDProvider(interval_ms=interval_ms)

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


# AMD display-driver user-mode DLLs.  A machine with an AMD GPU driver
# installed has at least one of these in System32; Intel/NVIDIA-only machines
# have none.  Used by _amd_gpu_present() as a passive pre-check.
_AMD_DRIVER_DLLS = (
    "atio6axx.dll",   # OpenGL ICD
    "atidxx64.dll",   # D3D 10/11
    "amdxx64.dll",    # D3D 12
    "amdxc64.dll",    # D3D 12 (DXIL)
    "amdvlk64.dll",   # Vulkan
    "amfrt64.dll",    # AMF
    "atiumd6a.dll",   # legacy UVD
)

# HKLM display-adapter class key — one numeric subkey per installed adapter.
_DISPLAY_CLASS_KEY = (
    r"SYSTEM\CurrentControlSet\Control\Class"
    r"\{4d36e968-e325-11ce-bfc1-08002be10318}"
)


def _amd_gpu_present() -> bool:
    """
    Passive, crash-free check for AMD hardware / AMD display driver (Windows).

    Why this exists
    ---------------
    `ADLXHelper.Initialize()` loads AMD's ADLX runtime.  On a machine with
    neither an AMD GPU nor an AMD display driver the call does not always
    return an error code — it has been observed to die with a **native access
    violation**.  A native crash is not a Python exception, so no `try/except`
    can contain it: the whole ComfyUI process is killed while custom nodes are
    being imported.  Confirmed in the wild (Intel-only machine, faulthandler
    stack pointing at `if _detect_adlx():`).

    Therefore ADLX is only ever touched after this pre-check has confirmed that
    AMD hardware or its driver is actually present.  Both signals are read-only
    and load no vendor DLL, so they cannot crash:

      1. Registry — display-adapter class key; DriverDesc contains "radeon" or
         "amd".  Intel/NVIDIA driver descriptions never contain either word.
      2. Filesystem — AMD user-mode driver DLLs present in System32, which
         covers minimal or unconventional driver installs.

    Returns False whenever the check cannot be performed, so the caller simply
    skips the AMD probe and falls through to the Intel/NVIDIA tiers.
    """
    if os.name != "nt":
        return False

    # 1. Registry — most authoritative: the adapter's own driver description
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _DISPLAY_CLASS_KEY) as key:
            index = 0
            while True:
                try:
                    subkey = winreg.EnumKey(key, index)
                except OSError:
                    break
                index += 1
                if not subkey.isdigit():
                    continue   # "Properties", "Configuration", ...
                try:
                    with winreg.OpenKey(key, subkey) as adapter:
                        desc = str(
                            winreg.QueryValueEx(adapter, "DriverDesc")[0]
                        ).lower()
                except OSError:
                    continue
                if "radeon" in desc or "amd" in desc:
                    return True
    except Exception:
        pass

    # 2. Filesystem — AMD driver DLLs, without loading any of them
    try:
        system32 = os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"), "System32"
        )
        for dll in _AMD_DRIVER_DLLS:
            if os.path.isfile(os.path.join(system32, dll)):
                return True
    except Exception:
        pass

    return False


def _adlx_installed() -> bool:
    """
    Return True if the optional ADLXPybind wheel is importable (Windows only).

    Import-only by design: it loads the native extension module but never hands
    control to the AMD driver, so unlike `ADLXHelper.Initialize()` it cannot die
    with the process-killing access violation (measured on an Intel-only
    machine: the import succeeds, then `Initialize()` returns ADLX_FAIL).

    This is a *dependency* check, not a hardware check — pair it with
    `_amd_gpu_present()` whenever the answer decides what to log or do.
    """
    if os.name != "nt":
        return False
    try:
        import ADLXPybind  # noqa: F401
        return True
    except BaseException:
        return False


def _detect_adlx() -> bool:
    """
    Return True if ADLX is usable and at least one AMD GPU is present.

    Windows-only: ADLXPybind is the AMD official SDK binding and does not
    exist on Linux.

    ADLX is never probed before _amd_gpu_present() confirms AMD hardware or
    driver: calling into it on a machine without an AMD GPU can terminate the
    process with a native access violation (see _amd_gpu_present).  On real AMD
    machines Initialize() succeeds and a non-empty GPU list is a trustworthy
    AMD signal even when torch.cuda is unavailable.
    """
    if os.name != "nt":
        return False
    if not _amd_gpu_present():
        return False
    try:
        import ADLXPybind as ADLX
        helper = ADLX.ADLXHelper()
        if helper.Initialize() != ADLX.ADLX_RESULT.ADLX_OK:
            return False
        system = helper.GetSystemServices()
        gpus = system.GetGPUs() if system is not None else []
        return bool(gpus)
    except BaseException:
        # BaseException, not Exception: an error raised from inside the native
        # binding (including SystemExit) must not abort plugin loading.
        # A native access violation is still uncatchable — that is precisely
        # what the _amd_gpu_present() gate above is for.
        return False


def _detect_amd_linux() -> bool:
    """
    Return True if an AMD GPU is present on Linux, independent of torch.cuda.

    Three independent signals, tried in order:
      1. amdsmi — official AMD SMI Python API (successor to rocm_smi_lib);
         a successful init + non-empty processor handle list is authoritative.
      2. torch.version.hip — ROCm PyTorch marker (hip is set on ROCm builds).
      3. sysfs — /sys/class/drm/card*/device/vendor == 0x1002 (AMD vendor ID).

    Any single signal being True is enough to prefer the AMD provider, so a
    Linux AMD dGPU is never shadowed by an Intel iGPU (issue #5).
    """
    if os.name == "nt":
        return False  # Windows AMD is handled by _detect_adlx()

    # 1. amdsmi (official successor to rocm_smi_lib)
    try:
        import amdsmi
        amdsmi.amdsmi_init()
        handles = amdsmi.amdsmi_get_processor_handles()
        if handles:
            return True
    except Exception:
        pass

    # 2. ROCm PyTorch marker
    try:
        import torch
        if getattr(torch.version, "hip", None):
            return True
    except Exception:
        pass

    # 3. sysfs vendor probing (works without any ROCm stack installed)
    try:
        import glob
        for vendor_file in glob.glob("/sys/class/drm/card*/device/vendor"):
            try:
                with open(vendor_file, "r") as handle:
                    if handle.read().strip().lower() == "0x1002":
                        return True
            except Exception:
                continue
    except Exception:
        pass

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

    AMD ROCm PyTorch builds may expose the marker under either name:
      - torch.version.roc  — classic ROCm builds (True or version string)
      - torch.version.hip  — newer ROCm builds (e.g. PyTorch 2.14+rocm10.1
        where `roc` is None but `hip` carries the HIP version string)
    Returns True if either marker is present, False otherwise (NVIDIA/CUDA).
    """
    try:
        import torch
        if torch.version.roc is not None:
            return True
        if getattr(torch.version, "hip", None):
            return True
        return False
    except Exception:
        return False


__all__ = [
    "BaseGPUProvider",
    "GPUSnapshot",
    "auto_detect_provider",
]
