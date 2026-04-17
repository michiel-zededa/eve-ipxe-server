"""
Boot configuration CRUD — create, read, update, delete, and activate configs.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import (
    BootConfig,
    BootConfigCreate,
    BootConfigListResponse,
    BootConfigResponse,
    DownloadStatus,
)
from app.services import ipxe_generator

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/configs", tags=["configuration"])


# ── Helpers ────────────────────────────────────────────────────────────────────

def _to_response(cfg: BootConfig) -> BootConfigResponse:
    return BootConfigResponse.model_validate(cfg)


async def _get_or_404(db: AsyncSession, config_id: str) -> BootConfig:
    result = await db.execute(select(BootConfig).where(BootConfig.id == config_id))
    cfg = result.scalar_one_or_none()
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Config {config_id!r} not found")
    return cfg


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("", response_model=list[BootConfigListResponse])
async def list_configs(db: AsyncSession = Depends(get_db)):
    """List all saved boot configurations, newest first."""
    result = await db.execute(
        select(BootConfig).order_by(BootConfig.created_at.desc())
    )
    return [BootConfigListResponse.model_validate(c) for c in result.scalars().all()]


@router.post("", response_model=BootConfigResponse, status_code=201)
async def create_config(
    payload: BootConfigCreate,
    db: AsyncSession = Depends(get_db),
):
    """
    Create a new boot configuration.

    The configuration is saved immediately.  Artifacts for the selected
    EVE version/arch are NOT downloaded here — call
    POST /api/artifacts/download to trigger that separately.
    """
    cfg = BootConfig(
        name                 = payload.name,
        eve_version          = payload.eve_version,
        architecture         = payload.architecture.value,
        hv_mode              = payload.hv_mode.value,
        variant              = payload.variant.value,
        scenario             = payload.scenario.value,
        install_disk         = payload.install_disk,
        persist_disk         = payload.persist_disk,
        controller_url       = payload.controller_url,
        onboarding_key       = payload.onboarding_key,
        soft_serial          = payload.soft_serial,
        reboot_after_install = payload.reboot_after_install,
        nuke_disk            = payload.nuke_disk,
        pause_before_install = payload.pause_before_install,
        console              = payload.console,
        extra_cmdline        = payload.extra_cmdline,
        download_status      = DownloadStatus.pending.value,
    )
    db.add(cfg)
    await db.flush()
    await db.refresh(cfg)
    return _to_response(cfg)


@router.get("/{config_id}", response_model=BootConfigResponse)
async def get_config(config_id: str, db: AsyncSession = Depends(get_db)):
    """Get a specific boot configuration by ID."""
    cfg = await _get_or_404(db, config_id)
    return _to_response(cfg)


@router.put("/{config_id}", response_model=BootConfigResponse)
async def update_config(
    config_id: str,
    payload: BootConfigCreate,
    db: AsyncSession = Depends(get_db),
):
    """Update an existing boot configuration."""
    cfg = await _get_or_404(db, config_id)

    # Check if artifact-relevant fields changed — if so, reset download status
    artifact_changed = (
        cfg.eve_version   != payload.eve_version
        or cfg.architecture != payload.architecture.value
        or cfg.hv_mode      != payload.hv_mode.value
        or cfg.variant      != payload.variant.value
    )

    cfg.name                 = payload.name
    cfg.eve_version          = payload.eve_version
    cfg.architecture         = payload.architecture.value
    cfg.hv_mode              = payload.hv_mode.value
    cfg.variant              = payload.variant.value
    cfg.scenario             = payload.scenario.value
    cfg.install_disk         = payload.install_disk
    cfg.persist_disk         = payload.persist_disk
    cfg.controller_url       = payload.controller_url
    cfg.onboarding_key       = payload.onboarding_key
    cfg.soft_serial          = payload.soft_serial
    cfg.reboot_after_install = payload.reboot_after_install
    cfg.nuke_disk            = payload.nuke_disk
    cfg.pause_before_install = payload.pause_before_install
    cfg.console              = payload.console
    cfg.extra_cmdline        = payload.extra_cmdline

    if artifact_changed:
        cfg.download_status   = DownloadStatus.pending.value
        cfg.download_error    = None
        cfg.download_progress = None
        cfg.is_active         = False

    await db.flush()
    await db.refresh(cfg)

    if cfg.is_active and cfg.download_status == DownloadStatus.ready.value:
        try:
            ipxe_generator.write_active_script(cfg)
        except Exception as exc:
            # Artifacts may have been deleted externally; mark config as needing re-download
            logger.warning("Could not regenerate boot script for config %s: %s", config_id, exc)
            cfg.is_active = False
            cfg.download_status = DownloadStatus.pending.value
            await db.flush()
            await db.refresh(cfg)

    return _to_response(cfg)


@router.delete("/{config_id}", status_code=204)
async def delete_config(config_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a boot configuration."""
    cfg = await _get_or_404(db, config_id)
    await db.delete(cfg)


@router.post("/{config_id}/activate", response_model=BootConfigResponse)
async def activate_config(config_id: str, db: AsyncSession = Depends(get_db)):
    """
    Mark a configuration as active and regenerate the TFTP boot.ipxe script.
    Only one configuration can be active at a time.
    """
    # De-activate all others efficiently
    await db.execute(
        update(BootConfig)
        .where(BootConfig.id != config_id)
        .values(is_active=False)
    )

    cfg = await _get_or_404(db, config_id)

    if cfg.download_status != DownloadStatus.ready.value:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Cannot activate config {config_id!r}: artifacts are not ready "
                f"(status={cfg.download_status!r}). "
                "Download the artifacts first via POST /api/artifacts/download."
            ),
        )

    cfg.is_active = True
    await db.flush()
    await db.refresh(cfg)

    # Write the boot script to TFTP root
    try:
        ipxe_generator.write_active_script(cfg)
    except Exception as exc:
        logger.error("Failed to write active boot script: %s", exc)
        raise HTTPException(status_code=500, detail=f"Script generation failed: {exc}")

    return _to_response(cfg)


@router.get("/{config_id}/script")
async def preview_script(config_id: str, db: AsyncSession = Depends(get_db)):
    """Preview the generated iPXE script without activating it."""
    cfg = await _get_or_404(db, config_id)
    try:
        script = ipxe_generator.generate_script(cfg)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Script generation error: {exc}")
    return {"config_id": config_id, "script": script}
