"""
providers/base.py — Abstract base class and shared data contract.

All GPU provider implementations must subclass BaseGPUProvider and
implement get_snapshot().  The GPUSnapshot dataclass is the single
contract between the hardware layer and every consumer (server,
predictor, frontend).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Shared data snapshot — the contract between providers and consumers
# ---------------------------------------------------------------------------

@dataclass
class GPUSnapshot:
    # --- VRAM (all in GB) ---
    vram_total_gb:        float = 0.0   # driver total
    vram_free_gb:         float = 0.0   # driver free
    vram_driver_used_gb:  float = 0.0   # total - free  (all consumers)
    vram_allocated_gb:    float = 0.0   # torch allocated (ComfyUI workload)
    vram_reserved_gb:     float = 0.0   # torch cached / reserved pool

    # --- GPU ---
    gpu_load_pct:  float = 0.0
    gpu_freq_mhz:  float = 0.0    # current GPU clock in MHz  (0 = unavailable)
    gpu_temp_c:    float = -1.0   # GPU core temp in °C       (-1 = unavailable)

    # --- Power ---
    power_w:         float = -1.0   # -1 = unavailable
    power_available: bool  = False
    tgp_w:           float = 0.0    # sustained TGP limit in W  (0 = unknown)
    device_name:     str   = ""

    # --- CPU ---
    cpu_pct:      float = 0.0
    cpu_freq_ghz: float = 0.0
    cpu_model:    str   = ""
    cpu_threads:  int   = 0

    # --- RAM ---
    ram_pct:          float = 0.0
    ram_total_gb:     float = 0.0
    ram_used_gb:      float = 0.0
    ram_free_gb:      float = 0.0
    # Windows Commit Charge (≈ Task Manager "已提交")
    commit_used_gb:   float = 0.0   # CommitTotal  = ullTotalPageFile - ullAvailPageFile
    commit_limit_gb:  float = 0.0   # CommitLimit  = ullTotalPageFile

    # --- Meta ---
    is_admin:     bool          = False
    gpu_vendor:   str           = ""    # "intel" | "nvidia" | "amd" | "unknown"
    error:        Optional[str] = None


# ---------------------------------------------------------------------------
# Abstract base provider
# ---------------------------------------------------------------------------

class BaseGPUProvider:
    """
    Abstract base class for all GPU hardware providers.

    Subclasses implement _poll() to fill a GPUSnapshot and call
    _update_snapshot(snap) when done.  The base class handles
    thread-safe snapshot storage and the polling loop lifecycle.

    Consumers always call get_snapshot() — they never see the
    concrete provider type.
    """

    # Subclasses set this to identify their vendor in GPUSnapshot.gpu_vendor
    GPU_VENDOR: str = "unknown"

    def __init__(self, interval_ms: int = 1000):
        self._interval  = max(100, interval_ms) / 1000.0
        self._snapshot  = GPUSnapshot(gpu_vendor=self.GPU_VENDOR)
        self._lock      = threading.Lock()
        self._stop      = threading.Event()

        self._thread = threading.Thread(
            target=self._loop, daemon=True, name=f"XPUSYSMonitor-{self.GPU_VENDOR}"
        )
        self._thread.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_snapshot(self) -> GPUSnapshot:
        """Return the latest hardware snapshot. Thread-safe."""
        with self._lock:
            return self._snapshot

    def set_interval(self, ms: int) -> None:
        """Adjust polling interval at runtime."""
        self._interval = max(100, ms) / 1000.0

    def stop(self) -> None:
        """Stop the background polling thread."""
        self._stop.set()
        self._thread.join(timeout=5)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _update_snapshot(self, snap: GPUSnapshot) -> None:
        """Atomically replace the stored snapshot. Called from _poll()."""
        with self._lock:
            self._snapshot = snap

    def _loop(self) -> None:
        """Background polling loop — calls _poll() every interval."""
        while not self._stop.is_set():
            try:
                self._poll()
            except Exception as exc:
                snap = GPUSnapshot(gpu_vendor=self.GPU_VENDOR, error=str(exc))
                self._update_snapshot(snap)
            self._stop.wait(self._interval)

    def _poll(self) -> None:
        """
        Override in subclass: collect hardware data and call
        _update_snapshot(snap) with a freshly built GPUSnapshot.
        """
        raise NotImplementedError
