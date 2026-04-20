"""
DHCP server management API — start / stop / configure the dnsmasq container.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app.services import dhcp_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dhcp", tags=["dhcp"])


class DHCPSettings(BaseModel):
    interface:   str            = Field("eth0",                               description="Host network interface to bind (e.g. eth0, eno1)")
    dhcp_range:  str            = Field("192.168.1.100,192.168.1.200,12h",   description="DHCP pool: start IP, end IP, lease time")
    subnet_mask: Optional[str]  = Field("255.255.255.0",                     description="Subnet mask pushed to clients and inserted into dhcp-range")
    dhcp_router: Optional[str]  = Field(None,                                description="Default gateway pushed to clients (optional)")
    dhcp_dns:    Optional[str]  = Field(None,                                description="DNS server pushed to clients (optional)")
    server_host: Optional[str]  = Field(None,                                description="TFTP/HTTP server IP shown to PXE clients (auto-detected if empty)")

    @model_validator(mode="after")
    def validate_range_fits_mask(self) -> "DHCPSettings":
        mask = (self.subnet_mask or "").strip()
        if not mask:
            return self
        parts = [p.strip() for p in self.dhcp_range.split(",")]
        if len(parts) < 2:
            return self
        start_ip, end_ip = parts[0], parts[1]
        try:
            mask_obj  = ipaddress.IPv4Address(mask)
            start_obj = ipaddress.IPv4Address(start_ip)
            end_obj   = ipaddress.IPv4Address(end_ip)
            mask_int  = int(mask_obj)
            if start_obj > end_obj:
                raise ValueError(f"Range start {start_ip} must be less than end {end_ip}")
            if (int(start_obj) & mask_int) != (int(end_obj) & mask_int):
                raise ValueError(
                    f"Range start {start_ip} and end {end_ip} are on different subnets "
                    f"for mask {mask}"
                )
        except ipaddress.AddressValueError as e:
            raise ValueError(f"Invalid IP in range or mask: {e}")
        return self


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
        "subnet_mask": settings.subnet_mask or "255.255.255.0",
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
        "subnet_mask": settings.subnet_mask or "255.255.255.0",
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
