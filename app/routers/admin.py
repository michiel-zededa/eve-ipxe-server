"""
Admin / operational endpoints.

  POST /api/admin/shutdown  — stop all stack containers gracefully.
    Requires /var/run/docker.sock to be mounted in the container
    (see docker-compose.yml).  The Docker API is used to stop
    eve-ipxe-dnsmasq, eve-ipxe-nginx, and eve-ipxe-webui in order.

    Without the socket the endpoint returns 503 with instructions to
    use ./server.sh stop instead — sending SIGTERM to the uvicorn
    process is NOT a valid fallback because Docker's restart: unless-stopped
    policy will immediately restart the container.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"])

_DOCKER_SOCK = Path("/var/run/docker.sock")
# Containers to stop (in order). webui is last so the HTTP response is sent first.
_STACK_CONTAINERS = ["eve-ipxe-dnsmasq", "eve-ipxe-nginx", "eve-ipxe-webui"]


@router.post("/shutdown")
async def shutdown_server():
    """
    Gracefully stop all stack containers via the Docker API.

    Requires /var/run/docker.sock to be mounted (see docker-compose.yml).
    Returns 503 if the socket is not available — use ./server.sh stop instead.
    """
    if not _DOCKER_SOCK.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "Docker socket not mounted — cannot stop containers from inside "
                "the container. Run './server.sh stop' on the host instead."
            ),
        )

    # Verify the socket is actually accessible (permission check)
    if not _DOCKER_SOCK.stat().st_mode & 0o002:  # world-writable bit
        try:
            _DOCKER_SOCK.open("rb").close()
        except PermissionError:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Docker socket exists but is not readable by this process. "
                    "Ensure the container runs as root (user: '0' in docker-compose.yml) "
                    "or run './server.sh stop' on the host."
                ),
            )

    asyncio.create_task(_stop_via_docker())
    return {
        "message": "Stopping all stack containers…",
        "containers": _STACK_CONTAINERS,
    }


async def _stop_via_docker() -> None:
    """Use the Docker HTTP API over the unix socket to stop stack containers."""
    await asyncio.sleep(0.5)   # let the HTTP response reach the browser first
    try:
        transport = httpx.AsyncHTTPTransport(uds=str(_DOCKER_SOCK))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://docker",
            timeout=20.0,
        ) as client:
            for name in _STACK_CONTAINERS:
                try:
                    resp = await client.post(
                        f"/containers/{name}/stop",
                        params={"t": 5},  # 5-second SIGTERM grace period before SIGKILL
                    )
                    logger.info("Docker stop %s → HTTP %s", name, resp.status_code)
                except Exception as exc:
                    logger.warning("Could not stop container %s: %s", name, exc)
    except Exception as exc:
        logger.error("Docker API shutdown failed: %s", exc)
