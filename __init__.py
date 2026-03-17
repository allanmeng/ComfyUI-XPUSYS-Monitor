"""
ComfyUI-XPUSYS-Monitor — GPU resource monitor plugin for ComfyUI.

Entry point: auto-detects the GPU vendor, instantiates the appropriate
hardware provider, registers web routes, and starts the background
broadcast loop.
"""

import asyncio
import logging

logger = logging.getLogger("XPUSYSMonitor")

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ---------------------------------------------------------------------------
# Initialise backend
# ---------------------------------------------------------------------------

try:
    from .providers import auto_detect_provider
    from .xpu_server import register_routes, set_provider, broadcast_loop

    _provider = auto_detect_provider(interval_ms=1000)
    set_provider(_provider)

    # Attach HTTP routes to PromptServer
    try:
        from server import PromptServer
        server = PromptServer.instance
        if server is not None:
            register_routes(server)

            # Schedule the WebSocket broadcast loop onto the server's event loop
            loop = server.loop
            if loop is not None:
                asyncio.run_coroutine_threadsafe(
                    broadcast_loop(server, interval_s=1.0), loop
                )
    except Exception as exc:
        logger.warning(f"XPUSYSMonitor: could not attach to PromptServer — {exc}")

    logger.info("XPUSYSMonitor: plugin loaded successfully.")

except Exception as exc:
    logger.error(f"XPUSYSMonitor: failed to initialise — {exc}", exc_info=True)
    NODE_CLASS_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
