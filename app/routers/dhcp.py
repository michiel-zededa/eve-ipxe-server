"""
DHCP server management API — start / stop / configure the dnsmasq container.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import dhcp_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dhcp", tags=["dhcp"])


class DHCPSettings(BaseModel):
    interface:   str            = Field("eth0",                               description="Host network interface to bind (e.g. eth0, eno1)")
    dhcp_range:  str            = Field("192.168.1.100,192.168.1.200,12h",   description="DHCP pool range and lease time (dnsmasq format)")
    dhcp_router: Optional[str]  = Field(None,                                description="Default gateway pushed to clients (optional)")
    dhcp_dns:    Optional[str]  = Field(None,                                description="DNS server pushed to clients (optional)")
    server_host: Optional[str]  = Field(None,                                description="TFTP/HTTP server IP shown to PXE clients (auto-detected if empty)")


@router.get("/status")
async def get_dhcp_status():
    """Return the dnsmasq container state and current settings."""
    status   = await dhcp_manager.get_container_status()
    settings = dhcp_manager.load_settings()
    return {**status, "settings": settings}


@router.post("/start")
async def start_dhcp():
    """Start the dnsmasq DHCP server."""
    status = await dhcp_manager.get_container_status()
    if not status.get("available"):
        raise HTTPException(status_code=503, detail=status.get("error", "Container unavailable"))
    if status.get("running"):
        return {"message": "DHCP server is already running"}
    try:
        await dhcp_manager.start_container()
        return {"message": "DHCP server started"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start DHCP server: {exc}")


@router.post("/stop")
async def stop_dhcp():
    """Stop the dnsmasq DHCP server."""
    status = await dhcp_manager.get_container_status()
    if not status.get("running"):
        return {"message": "DHCP server is already stopped"}
    try:
        await dhcp_manager.stop_container()
        return {"message": "DHCP server stopped"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to stop DHCP server: {exc}")


@router.get("/config")
async def get_dhcp_config():
    """Return the current DHCP settings."""
    return dhcp_manager.load_settings()


@router.put("/config")
async def update_dhcp_config(settings: DHCPSettings):
    """Persist DHCP settings and regenerate dnsmasq.conf (does not restart)."""
    data = {
        "interface":   settings.interface,
        "dhcp_range":  settings.dhcp_range,
        "dhcp_router": settings.dhcp_router or "",
        "dhcp_dns":    settings.dhcp_dns or "",
        "server_host": settings.server_host or "",
    }
    dhcp_manager.save_settings(data)
    return {"message": "Settings saved", "settings": data}


@router.post("/apply")
async def apply_dhcp_config(settings: DHCPSettings):
    """Save settings and restart the DHCP server if it is running."""
    data = {
        "interface":   settings.interface,
        "dhcp_range":  settings.dhcp_range,
        "dhcp_router": settings.dhcp_router or "",
        "dhcp_dns":    settings.dhcp_dns or "",
        "server_host": settings.server_host or "",
    }
    dhcp_manager.save_settings(data)

    status = await dhcp_manager.get_container_status()
    if status.get("running"):
        try:
            await dhcp_manager.restart_container()
            return {"message": "Settings applied and DHCP server restarted", "settings": data}
        except Exception as exc:
            raise HTTPException(status_code=500,
                                detail=f"Settings saved but restart failed: {exc}")
    return {"message": "Settings saved (DHCP server not running — press Start to activate)", "settings": data}
