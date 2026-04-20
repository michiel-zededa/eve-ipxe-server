"""
Server settings API — allows updating the server host IP at runtime
without restarting the stack.
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/server", tags=["server"])


def _settings_path():
    return get_settings().config_dir / "server-settings.json"


class ServerSettingsUpdate(BaseModel):
    server_host: str


@router.get("/settings")
async def get_server_settings():
    """Return the current server host IP."""
    return {"server_host": get_settings().get_server_host()}


@router.put("/settings")
async def update_server_settings(body: ServerSettingsUpdate):
    """
    Update the server host IP at runtime.

    Writes to /data/config/server-settings.json which takes priority over
    the SERVER_HOST env var on the next request — no restart required.
    """
    host = body.server_host.strip()
    if not host:
        raise HTTPException(status_code=422, detail="server_host must not be empty")

    try:
        _settings_path().write_text(json.dumps({"server_host": host}, indent=2))
        logger.info("Server host updated to %s", host)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not save settings: {exc}")

    return {"server_host": host, "message": "Server IP updated — new value takes effect immediately"}
