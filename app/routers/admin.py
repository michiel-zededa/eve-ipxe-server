"""
Admin / operational endpoints.

  POST /api/admin/shutdown  — stop all stack containers gracefully.
    If /var/run/docker.sock is mounted, the Docker API is used to stop
    eve-ipxe-nginx, eve-ipxe-dnsmasq, and eve-ipxe-webui in order.
    Without the socket, only the webui process is stopped (SIGTERM).
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
from pathlib import Path

import httpx
from fastapi import APIRouter

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"])

_DOCKER_SOCK = Path("/var/run/docker.sock")
# Containers to stop (in order).  webui last so the response can be sent first.
_STACK_CONTAINERS = ["eve-ipxe-dnsmasq", "eve-ipxe-nginx", "eve-ipxe-webui"]


@router.post("/shutdown")
async def shutdown_server():
    """
    Gracefully stop the server stack.

    With /var/run/docker.sock mounted: stops all stack containers via the
    Docker API (nginx, dnsmasq, then webui).

    Without the socket: sends SIGTERM to the webui process only — the
    container exits and Docker may restart it per the restart policy.
    For a full stack shutdown without the socket, use ./server.sh stop.
    """
    if _DOCKER_SOCK.exists():
        asyncio.create_task(_stop_via_docker())
        return {
            "message": "Stopping all stack containers via Docker API…",
            "containers": _STACK_CONTAINERS,
        }
    else:
        asyncio.create_task(_stop_self())
        return {
            "message": "Docker socket not available — stopping webui process only. "
                       "Run ./server.sh stop for a full stack shutdown.",
        }


async def _stop_via_docker() -> None:
    """Use the Docker HTTP API over the unix socket to stop stack containers."""
    await asyncio.sleep(0.3)   # let the HTTP response reach the browser first
    try:
        transport = httpx.AsyncHTTPTransport(uds=str(_DOCKER_SOCK))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://docker",
            timeout=15.0,
        ) as client:
            for name in _STACK_CONTAINERS:
                try:
                    resp = await client.post(f"/containers/{name}/stop", params={"t": 5})
                    logger.info("Docker stop %s → %s", name, resp.status_code)
                except Exception as exc:
                    logger.warning("Could not stop container %s: %s", name, exc)
    except Exception as exc:
        logger.error("Docker API shutdown failed: %s — falling back to SIGTERM", exc)
        os.kill(os.getpid(), signal.SIGTERM)


async def _stop_self() -> None:
    """Send SIGTERM to the uvicorn process so the container exits cleanly."""
    await asyncio.sleep(0.3)
    os.kill(os.getpid(), signal.SIGTERM)
