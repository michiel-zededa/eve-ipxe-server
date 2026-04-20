"""
DHCP server management API — start / stop / configure the dnsmasq container.
"""
from __future__ import annotations

import ipaddress
import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.config import get_settings
from app.services import dhcp_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/dhcp", tags=["dhcp"])


# ── Pydantic models ───────────────────────────────────────────────────────────

class DHCPSettings(BaseModel):
    """The four fields a user can actually change."""
    interface:   str = Field("eth0", description="Host interface to bind (e.g. eth0, eno1)")
    range_start: str = Field("192.168.1.100", description="DHCP pool start IP")
    range_end:   str = Field("192.168.1.200", description="DHCP pool end IP")
    lease_time:  str = Field("12h",           description="Lease duration (e.g. 1h, 12h, 24h, 7d)")

    @field_validator("lease_time")
    @classmethod
    def validate_lease_time(cls, v: str) -> str:
        if not re.fullmatch(r"\d+[smhd]", v.strip()):
            raise ValueError("lease_time must be a number followed by s/m/h/d (e.g. 12h, 7d)")
        return v.strip()

    @field_validator("range_start", "range_end")
    @classmethod
    def validate_ip(cls, v: str) -> str:
        try:
            ipaddress.IPv4Address(v.strip())
        except ipaddress.AddressValueError:
            raise ValueError(f"Invalid IPv4 address: {v!r}")
        return v.strip()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _enrich_settings(s: DHCPSettings, iface_info: Optional[dict]) -> dict:
    """
    Build the full settings dict for persistence, filling in the auto-derived
    fields (gateway, prefix_length, server_host, dhcp_dns) from detected
    interface info where available.
    """
    cfg = get_settings()

    if iface_info:
        gateway      = iface_info.get("gateway", "")
        prefix_length = iface_info.get("prefix_length", 24)
    else:
        # Fall back to whatever is already saved
        saved = dhcp_manager.load_settings()
        gateway       = saved.get("gateway", "")
        prefix_length = saved.get("prefix_length", 24)

    server_host = cfg.get_server_host()

    # Validate that pool IPs are in the same subnet as the interface
    mask_bits = (0xFFFFFFFF << (32 - prefix_length)) & 0xFFFFFFFF
    try:
        start_int = int(ipaddress.IPv4Address(s.range_start))
        end_int   = int(ipaddress.IPv4Address(s.range_end))
    except ipaddress.AddressValueError as e:
        raise ValueError(f"Invalid pool IP: {e}")
    if start_int >= end_int:
        raise ValueError("range_start must be less than range_end")
    if (start_int & mask_bits) != (end_int & mask_bits):
        raise ValueError(
            f"range_start ({s.range_start}) and range_end ({s.range_end}) "
            f"are on different subnets for /{prefix_length}"
        )

    return {
        "interface":    s.interface,
        "gateway":      gateway,
        "prefix_length": prefix_length,
        "range_start":  s.range_start,
        "range_end":    s.range_end,
        "lease_time":   s.lease_time,
        "dhcp_dns":     gateway,   # use gateway as DNS fallback; UI doesn't expose this
        "server_host":  server_host,
    }


async def _resolve_iface(interface_name: str) -> Optional[dict]:
    """Return the detected info dict for the named interface, or None."""
    interfaces = await dhcp_manager.get_host_interfaces()
    for iface in interfaces:
        if iface["interface"] == interface_name:
            return iface
    return None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/interfaces")
async def list_interfaces():
    """
    Return the host's IPv4 network interfaces (detected via the dnsmasq
    container which runs with host networking).
    """
    interfaces = await dhcp_manager.get_host_interfaces()
    return {"interfaces": interfaces}


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
    iface_info = await _resolve_iface(settings.interface)
    try:
        data = _enrich_settings(settings, iface_info)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    dhcp_manager.save_settings(data)
    return {"message": "Settings saved", "settings": data}


@router.post("/apply")
async def apply_dhcp_config(settings: DHCPSettings):
    """Save settings and restart the DHCP server if it is running."""
    iface_info = await _resolve_iface(settings.interface)
    try:
        data = _enrich_settings(settings, iface_info)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    dhcp_manager.save_settings(data)

    status = await dhcp_manager.get_container_status()
    if status.get("running"):
        try:
            await dhcp_manager.restart_container()
            return {"message": "Settings applied and DHCP server restarted", "settings": data}
        except Exception as exc:
            raise HTTPException(status_code=500,
                                detail=f"Settings saved but restart failed: {exc}")
    return {"message": "Settings saved (DHCP server not running — press Start to activate)",
            "settings": data}
