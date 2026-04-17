"""
GitHub Releases API — list EVE-OS versions and their assets.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from app.models import Release
from app.services.github_client import GitHubClient

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/releases", tags=["releases"])


@router.get("", response_model=list[Release])
async def list_releases(
    per_page: int = Query(default=20, ge=1, le=100),
    page: int = Query(default=1, ge=1),
    include_prereleases: bool = Query(default=False),
):
    """
    List available EVE-OS releases from GitHub, newest first.
    Results are cached for 5 minutes to avoid GitHub rate limits.
    """
    async with GitHubClient() as gh:
        try:
            releases = await gh.list_releases(
                per_page=per_page,
                page=page,
                include_prereleases=include_prereleases,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
    return releases


@router.get("/{tag}", response_model=Release)
async def get_release(tag: str):
    """Get a specific EVE-OS release by tag name (e.g. '16.12.0')."""
    async with GitHubClient() as gh:
        try:
            release = await gh.get_release(tag)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:
            if "404" in str(exc):
                raise HTTPException(status_code=404, detail=f"Release {tag!r} not found")
            raise HTTPException(status_code=502, detail=str(exc))
    return release


@router.get("/{tag}/assets")
async def get_release_assets(
    tag: str,
    arch: Optional[str] = Query(default=None, description="Filter by architecture (amd64/arm64)"),
    hv: Optional[str] = Query(default=None, description="Filter by hypervisor (k/kvm)"),
):
    """
    List installer-relevant assets for a specific release.
    Optionally filter by architecture and hypervisor mode.
    """
    async with GitHubClient() as gh:
        try:
            release = await gh.get_release(tag)
        except RuntimeError as exc:
            raise HTTPException(status_code=502, detail=str(exc))
        except Exception as exc:
            if "404" in str(exc):
                raise HTTPException(status_code=404, detail=f"Release {tag!r} not found")
            raise

    # Return only installer-relevant assets
    relevant_types = ("installer-net.tar", "installer.iso", "installer.raw", "sha256sums")
    assets = []
    for a in release.assets:
        if not any(t in a.name for t in relevant_types):
            continue
        if arch and arch not in a.name:
            continue
        if hv and f".{hv}." not in a.name:
            continue
        assets.append({
            "name": a.name,
            "size": a.size,
            "size_human": _human_size(a.size),
            "type": _asset_type(a.name),
            "arch": _extract_arch(a.name),
            "hv": _extract_hv(a.name),
            "variant": _extract_variant(a.name),
        })

    return {"tag": tag, "assets": assets}


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def _asset_type(name: str) -> str:
    if "installer-net" in name:
        return "installer-net"
    if "installer.iso" in name:
        return "installer-iso"
    if "installer.raw" in name:
        return "installer-raw"
    if "sha256sums" in name:
        return "checksum"
    return "other"


def _extract_arch(name: str) -> str:
    for arch in ("amd64", "arm64", "riscv64"):
        if name.startswith(arch + "."):
            return arch
    return "unknown"


def _extract_hv(name: str) -> str:
    parts = name.split(".")
    return parts[1] if len(parts) > 1 else "unknown"


def _extract_variant(name: str) -> str:
    parts = name.split(".")
    return parts[2] if len(parts) > 2 else "unknown"
