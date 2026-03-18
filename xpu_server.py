"""
xpu_server.py — WebSocket / HTTP endpoint for GPU metrics.

Registers a /xpusys/stats route on ComfyUI's PromptServer that returns
the latest GPUSnapshot as JSON.  A background task also broadcasts data
to all connected WebSocket clients at the configured interval.

This module is provider-agnostic: it works with any BaseGPUProvider
implementation (Intel, NVIDIA, AMD, ...).
"""

import asyncio
import json
import logging
import os
from aiohttp import web

try:
    import folder_paths as _fp
except ImportError:
    _fp = None

logger = logging.getLogger("XPUSYSMonitor")

# Will be set by __init__.py after creating the provider
_provider = None


def set_provider(provider):
    global _provider
    _provider = provider


def _snapshot_to_dict(snap) -> dict:
    return {
        # VRAM breakdown
        "vram_total_gb":       round(snap.vram_total_gb,       2),
        "vram_free_gb":        round(snap.vram_free_gb,        2),
        "vram_driver_used_gb": round(snap.vram_driver_used_gb, 2),
        "vram_allocated_gb":   round(snap.vram_allocated_gb,   2),
        "vram_reserved_gb":    round(snap.vram_reserved_gb,    2),
        # GPU
        "gpu_load_pct":        round(snap.gpu_load_pct, 1),
        "gpu_freq_mhz":        round(snap.gpu_freq_mhz, 0),
        "gpu_temp_c":          round(snap.gpu_temp_c,   1),
        # Power
        "power_w":             round(snap.power_w, 1),
        "power_available":     snap.power_available,
        "tgp_w":               round(snap.tgp_w, 1),
        "device_name":         snap.device_name,
        # CPU
        "cpu_pct":             round(snap.cpu_pct,      1),
        "cpu_freq_ghz":        round(snap.cpu_freq_ghz, 2),
        "cpu_model":           snap.cpu_model,
        "cpu_threads":         snap.cpu_threads,
        # RAM
        "ram_pct":             round(snap.ram_pct,          1),
        "ram_total_gb":        round(snap.ram_total_gb,     2),
        "ram_used_gb":         round(snap.ram_used_gb,      2),
        "ram_free_gb":         round(snap.ram_free_gb,      2),
        "commit_used_gb":      round(snap.commit_used_gb,   2),
        "commit_limit_gb":     round(snap.commit_limit_gb,  2),
        # Meta
        "is_admin":            snap.is_admin,
        "gpu_vendor":          snap.gpu_vendor,
        "error":               snap.error,
    }


def register_routes(server):
    """Call this with the PromptServer instance to attach our HTTP route."""

    @server.routes.get("/xpusys/stats")
    async def get_stats(request):
        if _provider is None:
            return web.json_response({"error": "provider not ready"}, status=503)
        snap = _provider.get_snapshot()
        return web.json_response(_snapshot_to_dict(snap))

    @server.routes.post("/xpusys/model_sizes")
    async def get_model_sizes(request):
        """
        Accept a list of {name, type} model descriptors from the frontend,
        resolve each to a physical file, and return {name, size} in GB.
        Route name is intentionally distinct from /vram_predict/* used by
        the standalone ComfyUI-Vram-Predictor plugin.
        """
        if _fp is None:
            return web.json_response({"models": []})
        try:
            data  = await request.json()
            items = data.get("models", [])
            _ALLOWED = {".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".onnx"}
            _SEARCH  = ["checkpoints", "vae", "loras", "controlnet", "clip",
                        "upscale_models", "unet", "diffusion_models",
                        "ultralytics", "annotator", "bbox", "onnx"]
            results = []
            for m in items:
                name = m.get("name", "")
                if not name:
                    continue
                if os.path.splitext(name)[1].lower() not in _ALLOWED:
                    continue
                hint = m.get("type", "checkpoints")
                path = _fp.get_full_path(hint, name)
                if not path:
                    for folder in _SEARCH:
                        p = _fp.get_full_path(folder, name)
                        if p:
                            path = p
                            break
                if path and os.path.isfile(path):
                    size_gb = os.path.getsize(path) / (1024 ** 3)
                    if size_gb > 0.001:
                        results.append({"name": name, "size": round(size_gb, 2)})
            return web.json_response({"models": results})
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: model_sizes error — {exc}")
            return web.json_response({"models": []})

    logger.info("XPUSYSMonitor: HTTP routes /xpusys/stats and /xpusys/model_sizes registered.")


async def broadcast_loop(server, interval_s: float = 1.0):
    """
    Continuously broadcast XPU stats to all WebSocket clients via
    ComfyUI's built-in send_json helper.
    """
    while True:
        await asyncio.sleep(interval_s)
        if _provider is None:
            continue
        try:
            snap = _provider.get_snapshot()
            data = _snapshot_to_dict(snap)
            await server.send_json("xpusys_stats", data)
        except Exception as exc:
            logger.debug(f"XPUSYSMonitor: broadcast error — {exc}")
