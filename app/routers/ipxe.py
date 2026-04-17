"""
iPXE script serving endpoints.

These routes are consumed by iPXE clients (not browsers), so they return
plain text rather than JSON.

  GET /ipxe/boot.ipxe              — served from TFTP root (HTTP mirror)
  GET /ipxe/config/{id}/script     — generate a config-specific boot script
  GET /api/server-info             — server network info for the UI
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models import BootConfig, DownloadStatus, ServerInfoResponse
from app.services import ipxe_generator

logger = logging.getLogger(__name__)
router = APIRouter(tags=["ipxe"])


@router.get("/ipxe/boot.ipxe", response_class=PlainTextResponse)
async def serve_default_boot_script(db: AsyncSession = Depends(get_db)):
    """
    Serve the default iPXE boot script over HTTP.
    This is a mirror of the TFTP-served boot.ipxe so HTTP-capable iPXE
    clients can fetch it without TFTP.
    """
    cfg = get_settings()
    tftp_boot_ipxe = cfg.tftp_root / "boot.ipxe"

    if tftp_boot_ipxe.exists():
        return tftp_boot_ipxe.read_text()

    # Fall back: generate a menu from all ready configs
    result = await db.execute(
        select(BootConfig)
        .where(BootConfig.download_status == DownloadStatus.ready.value)
        .order_by(BootConfig.is_active.desc(), BootConfig.created_at.desc())
    )
    configs = result.scalars().all()

    if configs:
        return ipxe_generator.generate_menu_script(list(configs))

    # Nothing ready — redirect to the web UI
    server = cfg.get_server_host()
    return (
        "#!ipxe\n"
        "echo No EVE-OS boot configuration is ready yet.\n"
        f"echo Please open the web UI: http://{server}:{cfg.webui_port}\n"
        "prompt --key s --timeout 60 Press s for shell... && shell || reboot\n"
    )


@router.get("/ipxe/config/{config_id}/script", response_class=PlainTextResponse)
async def serve_config_script(
    config_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Generate and serve the iPXE boot script for a specific configuration."""
    result = await db.execute(select(BootConfig).where(BootConfig.id == config_id))
    cfg_obj = result.scalar_one_or_none()
    if cfg_obj is None:
        raise HTTPException(status_code=404, detail=f"Config {config_id!r} not found")
    if cfg_obj.download_status != DownloadStatus.ready.value:
        raise HTTPException(
            status_code=409,
            detail=f"Artifacts not ready (status={cfg_obj.download_status!r})",
        )
    try:
        return ipxe_generator.generate_script(cfg_obj)
    except Exception as exc:
        logger.exception("Script generation failed for config %s", config_id)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/api/server-info", response_model=ServerInfoResponse)
async def get_server_info():
    """Return server network information for the web UI."""
    cfg = get_settings()
    host = cfg.get_server_host()
    return ServerInfoResponse(
        server_host=host,
        webui_port=cfg.webui_port,
        http_port=cfg.http_port,
        tftp_port_external=69,
        artifact_http_base=cfg.artifact_http_base(),
        webui_base=cfg.webui_base(),
        ipxe_boot_url=f"http://{host}:{cfg.webui_port}/ipxe/boot.ipxe",
        ipxe_boot_tftp=f"tftp://{host}/boot.ipxe",
    )
