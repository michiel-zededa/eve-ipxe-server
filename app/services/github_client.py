"""
GitHub Releases API client for the lf-edge/eve repository.
Handles rate-limit headers, ETag caching, and token auth.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import httpx

from app.config import get_settings
from app.models import Release, ReleaseAsset

logger = logging.getLogger(__name__)

# Simple in-process cache: {url: (etag, data, timestamp)}
_cache: dict[str, tuple[str, list, float]] = {}
_CACHE_TTL = 300  # seconds


class GitHubClient:
    def __init__(self) -> None:
        cfg = get_settings()
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "eve-ipxe-server/1.0",
        }
        if cfg.github_token:
            headers["Authorization"] = f"Bearer {cfg.github_token}"
        self._base = cfg.github_api_base
        self._repo = cfg.eve_repo
        self._client = httpx.AsyncClient(headers=headers, timeout=30.0, follow_redirects=True)

    async def __aenter__(self) -> "GitHubClient":
        return self

    async def __aexit__(self, *_) -> None:
        await self._client.aclose()

    async def _get(self, url: str, params: Optional[dict] = None) -> list | dict:
        """GET with ETag caching and rate-limit awareness."""
        cache_key = f"{url}?{params}"
        cached = _cache.get(cache_key)
        headers: dict[str, str] = {}

        if cached:
            etag, data, ts = cached
            if time.monotonic() - ts < _CACHE_TTL:
                return data
            headers["If-None-Match"] = etag

        try:
            resp = await self._client.get(url, params=params, headers=headers)
        except httpx.RequestError as exc:
            raise RuntimeError(f"GitHub API request failed: {exc}") from exc

        # Rate limit check
        remaining = int(resp.headers.get("X-RateLimit-Remaining", "999"))
        if remaining < 5:
            reset_ts = int(resp.headers.get("X-RateLimit-Reset", "0"))
            wait = max(0, reset_ts - int(time.time()))
            logger.warning(
                "GitHub API rate limit nearly exhausted (%d remaining). "
                "Consider setting GITHUB_TOKEN. Reset in %ds.",
                remaining, wait,
            )

        if resp.status_code == 304 and cached:
            # Not modified — refresh TTL
            etag, data, _ = cached
            _cache[cache_key] = (etag, data, time.monotonic())
            return data

        if resp.status_code == 403:
            raise RuntimeError(
                "GitHub API returned 403. You may have hit the rate limit. "
                "Set GITHUB_TOKEN to increase the limit to 5000 req/hour."
            )

        resp.raise_for_status()
        data = resp.json()
        etag = resp.headers.get("ETag", "")
        _cache[cache_key] = (etag, data, time.monotonic())
        return data

    async def list_releases(
        self,
        per_page: int = 30,
        page: int = 1,
        include_prereleases: bool = False,
    ) -> list[Release]:
        """Return EVE-OS releases from GitHub, newest first."""
        url = f"{self._base}/repos/{self._repo}/releases"
        raw = await self._get(url, params={"per_page": per_page, "page": page})

        releases = []
        for r in raw:
            if r.get("draft"):
                continue
            if r.get("prerelease") and not include_prereleases:
                continue
            assets = [
                ReleaseAsset(
                    name=a["name"],
                    size=a["size"],
                    browser_download_url=a["browser_download_url"],
                    content_type=a.get("content_type", "application/octet-stream"),
                )
                for a in r.get("assets", [])
            ]
            releases.append(
                Release(
                    tag_name=r["tag_name"],
                    name=r.get("name") or r["tag_name"],
                    published_at=r["published_at"],
                    prerelease=r.get("prerelease", False),
                    draft=r.get("draft", False),
                    assets=assets,
                )
            )
        return releases

    async def get_release(self, tag: str) -> Release:
        """Return a single release by tag name."""
        url = f"{self._base}/repos/{self._repo}/releases/tags/{tag}"
        r = await self._get(url)
        assets = [
            ReleaseAsset(
                name=a["name"],
                size=a["size"],
                browser_download_url=a["browser_download_url"],
                content_type=a.get("content_type", "application/octet-stream"),
            )
            for a in r.get("assets", [])
        ]
        return Release(
            tag_name=r["tag_name"],
            name=r.get("name") or r["tag_name"],
            published_at=r["published_at"],
            prerelease=r.get("prerelease", False),
            draft=r.get("draft", False),
            assets=assets,
        )

    def find_installer_net_asset(
        self, release: Release, arch: str, hv: str, variant: str = "generic"
    ) -> Optional[ReleaseAsset]:
        """
        Find the installer-net.tar asset for the given arch/hv/variant combo.
        Asset naming convention: {arch}.{hv}.{variant}.installer-net.tar
        Example: amd64.kvm.generic.installer-net.tar
        """
        target = f"{arch}.{hv}.{variant}.installer-net.tar"
        for asset in release.assets:
            if asset.name == target:
                return asset
        # Fallback: look for any installer-net.tar with the prefix
        prefix = f"{arch}.{hv}.{variant}."
        for asset in release.assets:
            if asset.name.startswith(prefix) and "installer-net" in asset.name:
                return asset
        return None

    def find_installer_iso_asset(
        self, release: Release, arch: str, hv: str, variant: str = "generic"
    ) -> Optional[ReleaseAsset]:
        """Find the installer ISO for direct ISO-boot / sanboot fallback."""
        target = f"{arch}.{hv}.{variant}.installer.iso"
        for asset in release.assets:
            if asset.name == target:
                return asset
        return None

    def find_checksum_asset(
        self, release: Release, arch: str, hv: str, variant: str = "generic"
    ) -> Optional[ReleaseAsset]:
        """Find the sha256sums file for the given artifact set."""
        target = f"{arch}.{hv}.{variant}.sha256sums"
        for asset in release.assets:
            if asset.name == target:
                return asset
        return None
