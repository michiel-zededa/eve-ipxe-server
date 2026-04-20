"""
DHCP server management API — start / stop / configure the dnsmasq container.
"""
from __future__ import annotations

import ipaddress
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from app.services import dhcp_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dhcp", tags=["dhcp"])


class DHCPSettings(BaseModel):
    interface:    str           = Field("eth0",            description="Host interface to bind (e.g. eth0, eno1)")
    gateway:      Optional[str] = Field(None,              description="Router/gateway IP — subnet anchor, pushed to clients")
    prefix_length: int          = Field(24, ge=8, le=30,   description="CIDR prefix length (e.g. 24 → 255.255.255.0)")
    range_start:  str           = Field("192.168.1.100",   description="DHCP pool start IP")
    range_end:    str           = Field("192.168.1.200",   description="DHCP pool end IP")
    lease_time:   str           = Field("12h",             description="Lease duration (e.g. 1h, 12h, 24h, 7d)")
    dhcp_dns:     Optional[str] = Field(None,              description="DNS server pushed to clients (optional)")
    server_host:  Optional[str] = Field(None,              description="TFTP/HTTP server IP (auto-detected if empty)")

    @field_validator("lease_time")
    @classmethod
    def validate_lease_time(cls, v: str) -> str:
        import re
        if not re.fullmatch(r"\d+[smhd]", v.strip()):
            raise ValueError("lease_time must be a number followed by s/m/h/d (e.g. 12h, 7d)")
        return v.strip()

    @model_validator(mode="after")
    def validate_range_in_subnet(self) -> "DHCPSettings":
        mask_bits = (0xFFFFFFFF << (32 - self.prefix_length)) & 0xFFFFFFFF
        try:
            start_int = int(ipaddress.IPv4Address(self.range_start))
            end_int   = int(ipaddress.IPv4Address(self.range_end))
        except ipaddress.AddressValueError as e:
            raise ValueError(f"Invalid IP address: {e}")
        if start_int >= end_int:
            raise ValueError(f"range_start must be less than range_end")
        if (start_int & mask_bits) != (end_int & mask_bits):
            raise ValueError(
                f"range_start ({self.range_start}) and range_end ({self.range_end}) "
                f"are on different subnets for /{self.prefix_length}"
            )
        if self.gateway:
            try:
                gw_int = int(ipaddress.IPv4Address(self.gateway))
                if (gw_int & mask_bits) != (start_int & mask_bits):
                    raise ValueError(
                        f"gateway ({self.gateway}) is not in the same subnet as the DHCP range"
                    )
            except ipaddress.AddressValueError as e:
                raise ValueError(f"Invalid gateway IP: {e}")
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
    data = _settings_to_dict(settings)
    dhcp_manager.save_settings(data)
    return {"message": "Settings saved", "settings": data}


@router.post("/apply")
async def apply_dhcp_config(settings: DHCPSettings):
    """Save settings and restart the DHCP server if it is running."""
    data = _settings_to_dict(settings)
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


def _settings_to_dict(s: DHCPSettings) -> dict:
    return {
        "interface":    s.interface,
        "gateway":      s.gateway or "",
        "prefix_length": s.prefix_length,
        "range_start":  s.range_start,
        "range_end":    s.range_end,
        "lease_time":   s.lease_time,
        "dhcp_dns":     s.dhcp_dns or "",
        "server_host":  s.server_host or "",
    }
