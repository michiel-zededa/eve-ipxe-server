"""
Artifact download management — trigger downloads, stream progress via SSE,
list cached artifacts, and expose artifact file info.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.models import (
    Architecture,
    ArtifactKey,
    BootConfig,
    DownloadStatus,
    HypervisorMode,
    Variant,
)
from app.services import artifact_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/artifacts", tags=["artifacts"])


def _make_key(
    eve_version: str,
    architecture: str,
    hv_mode: str,
    variant: str = "generic",
) -> ArtifactKey:
    try:
        return ArtifactKey(
            eve_version=eve_version,
            architecture=Architecture(architecture),
            hv_mode=HypervisorMode(hv_mode),
            variant=Variant(variant),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/download")
async def trigger_download(
    eve_version: str,
    architecture: str,
    hv_mode: str,
    background_tasks: BackgroundTasks,
    variant: str = "generic",
    db: AsyncSession = Depends(get_db),
):
    """
    Trigger an artifact download for the given EVE version/arch/hv combo.
    The download runs in the background; poll /status or stream /stream for progress.
    """
    key = _make_key(eve_version, architecture, hv_mode, variant)

    # Update matching BootConfig download_status records
    result = await db.execute(
        select(BootConfig).where(
            BootConfig.eve_version == eve_version,
            BootConfig.architecture == architecture,
            BootConfig.hv_mode == hv_mode,
            BootConfig.variant == variant,
        )
    )
    # Only update DB status if not currently downloading
    in_progress_statuses = (DownloadStatus.downloading.value, DownloadStatus.extracting.value)
    current_progress = artifact_manager.get_progress(key.cache_dir_name())
    if current_progress["status"] not in in_progress_statuses:
        for cfg in result.scalars().all():
            cfg.download_status = DownloadStatus.downloading.value
            cfg.download_error = None

    background_tasks.add_task(
        _download_and_update_db,
        key=key,
        eve_version=eve_version,
        architecture=architecture,
        hv_mode=hv_mode,
        variant=variant,
    )

    return {
        "message": "Download started",
        "key": key.cache_dir_name(),
        "stream_url": f"/api/artifacts/stream/{eve_version}/{architecture}/{hv_mode}/{variant}",
    }


async def _download_and_update_db(
    key: ArtifactKey,
    eve_version: str,
    architecture: str,
    hv_mode: str,
    variant: str,
) -> None:
    """Run the download then sync final status back into the database."""
    from app.database import get_session_factory

    await artifact_manager.download_artifacts(key)
    progress = artifact_manager.get_progress(key.cache_dir_name())

    factory = get_session_factory()
    async with factory() as db:
        try:
            result = await db.execute(
                select(BootConfig).where(
                    BootConfig.eve_version == eve_version,
                    BootConfig.architecture == architecture,
                    BootConfig.hv_mode == hv_mode,
                    BootConfig.variant == variant,
                )
            )
            for cfg in result.scalars().all():
                cfg.download_status = progress.get("status", DownloadStatus.failed.value)
                cfg.download_error = progress.get("error")
                cfg.download_progress = progress.get("progress")
            await db.commit()
        except Exception as exc:
            logger.error("Failed to update DB after download: %s", exc)
            await db.rollback()


@router.get("/status/{eve_version}/{architecture}/{hv_mode}/{variant}")
async def get_download_status(
    eve_version: str,
    architecture: str,
    hv_mode: str,
    variant: str = "generic",
):
    """Poll the current download status for an artifact set."""
    key = _make_key(eve_version, architecture, hv_mode, variant)
    progress = artifact_manager.get_progress(key.cache_dir_name())

    # If not in memory, check disk
    if progress["status"] == "unknown":
        if artifact_manager.is_ready(key):
            boot_mode = artifact_manager.read_boot_mode(key)
            progress = {
                "status": "ready",
                "progress": 100,
                "error": None,
                "boot_mode": boot_mode,
            }

    return {
        "key": key.cache_dir_name(),
        **progress,
    }


@router.get("/stream/{eve_version}/{architecture}/{hv_mode}/{variant}")
async def stream_download_progress(
    eve_version: str,
    architecture: str,
    hv_mode: str,
    variant: str = "generic",
):
    """
    Server-Sent Events stream for download progress.
    The client receives a JSON event every second until the download
    reaches a terminal state (ready or failed).
    """
    key = _make_key(eve_version, architecture, hv_mode, variant)
    cache_key = key.cache_dir_name()

    async def generate():
        deadline = asyncio.get_event_loop().time() + 7200  # 2-hour max
        while asyncio.get_event_loop().time() < deadline:
            progress = artifact_manager.get_progress(cache_key)
            if progress["status"] == "unknown" and artifact_manager.is_ready(key):
                progress = {
                    "status": "ready",
                    "progress": 100,
                    "error": None,
                    "boot_mode": artifact_manager.read_boot_mode(key),
                }
            yield {"event": "progress", "data": json.dumps(progress)}

            status = progress.get("status", "unknown")
            if status in (DownloadStatus.ready.value, DownloadStatus.failed.value):
                yield {"event": "done", "data": json.dumps(progress)}
                return

            await asyncio.sleep(1)

        timeout_data = {"status": "failed", "error": "Download timed out after 2 hours"}
        yield {"event": "done", "data": json.dumps(timeout_data)}

    return EventSourceResponse(generate())


@router.get("/list")
async def list_cached_artifacts():
    """List all artifact sets currently cached on disk."""
    artifacts = await artifact_manager.list_cached_artifacts()
    return {"artifacts": artifacts}


@router.delete("/{eve_version}/{architecture}/{hv_mode}/{variant}", status_code=204)
async def delete_artifacts(
    eve_version: str,
    architecture: str,
    hv_mode: str,
    variant: str = "generic",
    db: AsyncSession = Depends(get_db),
):
    """
    Delete cached artifacts for the given combo.
    Any active BootConfig using these artifacts will have its status reset to 'pending'.
    """
    import shutil
    key = _make_key(eve_version, architecture, hv_mode, variant)
    dest = artifact_manager.artifact_dir(key)

    if not dest.exists():
        raise HTTPException(status_code=404, detail="No cached artifacts found for this combination")

    # Refuse to delete while a download is *actively running* (lock held).
    # We check the lock rather than the progress dict, which can be stale
    # after a crash or container restart.
    if artifact_manager.is_downloading(key):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete artifacts while a download is in progress",
        )

    try:
        shutil.rmtree(dest)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete artifacts: {exc}")

    # Evict the stale in-memory progress so status endpoints return "unknown" (not "ready")
    artifact_manager.clear_progress(key.cache_dir_name())

    # Reset download status in DB
    result = await db.execute(
        select(BootConfig).where(
            BootConfig.eve_version == eve_version,
            BootConfig.architecture == architecture,
            BootConfig.hv_mode == hv_mode,
            BootConfig.variant == variant,
        )
    )
    for cfg in result.scalars().all():
        cfg.download_status = DownloadStatus.pending.value
        cfg.download_error = None
        cfg.download_progress = None
