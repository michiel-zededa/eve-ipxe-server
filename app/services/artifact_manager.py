"""
Artifact manager — downloads, extracts, and manages EVE-OS installer artifacts.

EVE-OS PXE boot changed at version 12:

  Pre-v12 ("direct" boot):
    installer-net.tar contains:
      kernel        — Linux kernel binary
      initrd.img    — Initial ramdisk

    iPXE loads kernel + initrd directly:
      kernel http://.../kernel <cmdline>
      initrd http://.../initrd.img
      boot

  v12+ ("grub-chain" boot):
    installer-net.tar contains:
      installer.iso          — Full installer ISO (~650 MB)
      ipxe.efi.cfg           — EVE's reference iPXE config (template)
      EFI/BOOT/BOOTX64.EFI   — GRUB EFI binary (x86_64)
      EFI/BOOT/BOOTAA64.EFI  — GRUB EFI binary (arm64)
      EFI/BOOT/grub.cfg      — GRUB config that loop-mounts installer.iso

    Boot flow:
      iPXE sets url= → chains to GRUB EFI → GRUB reads grub.cfg from same url →
      GRUB loop-mounts installer.iso → sources ISO's grub.cfg → loads kernel+initrd

    Our customisation is injected by prepending variable overrides to the
    served EFI/BOOT/grub.cfg so GRUB picks them up on startup.

Both modes are auto-detected from the extracted tar contents.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tarfile
from pathlib import Path
from typing import Optional

import httpx

from app.config import get_settings
from app.models import ArtifactKey, DownloadStatus
from app.services.github_client import GitHubClient

logger = logging.getLogger(__name__)

# ── Boot mode constants ────────────────────────────────────────────────────────
BOOT_MODE_GRUB_CHAIN  = "grub-chain"   # v12+: iPXE → GRUB EFI → loop-mount ISO
BOOT_MODE_DIRECT      = "direct"       # pre-v12: iPXE → kernel + initrd directly
BOOT_MODE_UNKNOWN     = "unknown"

# Files that indicate the grub-chain mode
_GRUB_CHAIN_MARKERS = {"installer.iso", os.path.join("EFI", "BOOT", "BOOTX64.EFI")}
# Files that indicate direct mode
_DIRECT_MARKERS = {"kernel", "initrd.img"}

# ── In-memory progress store ───────────────────────────────────────────────────
# {cache_dir_name: {"status": ..., "progress": 0-100, "error": ..., "boot_mode": ...}}
_progress: dict[str, dict] = {}

# Semaphore to cap concurrent downloads (initialised lazily)
_sem: Optional[asyncio.Semaphore] = None

# ── iPXE bootstrap binaries ───────────────────────────────────────────────────
IPXE_BINARY_URLS = {
    "undionly.kpxe":  "https://boot.ipxe.org/undionly.kpxe",
    "ipxe.efi":       "https://boot.ipxe.org/ipxe.efi",
    "ipxe-arm64.efi": "https://boot.ipxe.org/arm64-efi/ipxe.efi",
}


# ── Public helpers ─────────────────────────────────────────────────────────────

def _get_sem() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        cfg = get_settings()
        _sem = asyncio.Semaphore(cfg.max_concurrent_downloads)
    return _sem


def get_progress(key: str) -> dict:
    return _progress.get(key, {"status": "unknown", "progress": None, "error": None,
                                "boot_mode": None, "bytes_downloaded": None,
                                "bytes_total": None})


def artifact_dir(key: ArtifactKey) -> Path:
    cfg = get_settings()
    return cfg.artifacts_dir / key.cache_dir_name()


def detect_boot_mode(dest_dir: Path) -> str:
    """Detect which boot mode the extracted artifacts support."""
    grub_chain = all(
        (dest_dir / m).exists() for m in _GRUB_CHAIN_MARKERS
    )
    direct = all(
        (dest_dir / m).exists() for m in _DIRECT_MARKERS
    )
    if grub_chain:
        return BOOT_MODE_GRUB_CHAIN
    if direct:
        return BOOT_MODE_DIRECT
    return BOOT_MODE_UNKNOWN


def is_ready(key: ArtifactKey) -> bool:
    """Return True if at least one known boot mode's files are present."""
    d = artifact_dir(key)
    return detect_boot_mode(d) != BOOT_MODE_UNKNOWN


def read_boot_mode(key: ArtifactKey) -> str:
    """Return the cached boot mode (written to disk during extraction)."""
    mode_file = artifact_dir(key) / ".boot_mode"
    if mode_file.exists():
        return mode_file.read_text().strip()
    return detect_boot_mode(artifact_dir(key))


# ── iPXE binary bootstrap ─────────────────────────────────────────────────────

async def ensure_ipxe_binaries() -> None:
    """Download iPXE chainload binaries to the TFTP root on first run."""
    cfg = get_settings()
    tftp_root = cfg.tftp_root
    tftp_root.mkdir(parents=True, exist_ok=True)

    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        for filename, url in IPXE_BINARY_URLS.items():
            dest = tftp_root / filename
            if dest.exists():
                continue
            logger.info("Downloading iPXE binary: %s", filename)
            try:
                async with client.stream("GET", url) as resp:
                    resp.raise_for_status()
                    tmp = dest.with_suffix(".tmp")
                    with tmp.open("wb") as fh:
                        async for chunk in resp.aiter_bytes(65536):
                            fh.write(chunk)
                    tmp.rename(dest)
                    logger.info("Cached %s (%d bytes)", filename, dest.stat().st_size)
            except Exception as exc:
                logger.warning("Could not download %s: %s", filename, exc)


# ── Main download entry point ──────────────────────────────────────────────────

async def download_artifacts(key: ArtifactKey) -> None:
    """
    Background task: download and extract installer-net.tar for *key*.
    Concurrent calls for the same key are de-duplicated.
    """
    cache_key = key.cache_dir_name()
    existing = _progress.get(cache_key, {})
    if existing.get("status") in (
        DownloadStatus.downloading.value,
        DownloadStatus.extracting.value,
        DownloadStatus.ready.value,
    ):
        return

    _progress[cache_key] = {
        "status": DownloadStatus.downloading.value,
        "progress": 0,
        "error": None,
        "boot_mode": None,
    }

    async with _get_sem():
        try:
            await _do_download(key, cache_key)
        except Exception as exc:
            logger.exception("Download failed for %s: %s", cache_key, exc)
            _progress[cache_key] = {
                "status": DownloadStatus.failed.value,
                "progress": None,
                "error": str(exc),
                "boot_mode": None,
            }


async def _do_download(key: ArtifactKey, cache_key: str) -> None:
    cfg = get_settings()
    dest_dir = artifact_dir(key)
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Already extracted?
    boot_mode = detect_boot_mode(dest_dir)
    if boot_mode != BOOT_MODE_UNKNOWN:
        logger.info("Artifacts already cached (%s): %s", boot_mode, cache_key)
        _progress[cache_key] = {
            "status": DownloadStatus.ready.value,
            "progress": 100,
            "error": None,
            "boot_mode": boot_mode,
        }
        return

    async with GitHubClient() as gh:
        release = await gh.get_release(key.eve_version)
        asset = gh.find_installer_net_asset(
            release, key.architecture.value, key.hv_mode.value, key.variant.value
        )
        if asset is None:
            available = [a.name for a in release.assets]
            raise RuntimeError(
                f"No installer-net asset found for "
                f"{key.architecture}/{key.hv_mode}/{key.variant} in {key.eve_version}. "
                f"Available: {available}"
            )

        logger.info("Downloading %s (%s)", asset.name, _human_size(asset.size))
        tar_path = dest_dir / asset.name
        await _stream_download(asset.browser_download_url, tar_path, asset.size,
                               cache_key, cfg)

    _progress[cache_key] = {
        "status": DownloadStatus.extracting.value,
        "progress": 90,
        "error": None,
        "boot_mode": None,
    }
    await asyncio.to_thread(_extract_tar, tar_path, dest_dir)

    boot_mode = detect_boot_mode(dest_dir)
    if boot_mode == BOOT_MODE_UNKNOWN:
        contents = list(dest_dir.rglob("*"))
        raise RuntimeError(
            f"Extraction complete but no recognised boot files found. "
            f"Contents: {[str(p.relative_to(dest_dir)) for p in contents[:40]]}"
        )

    # Persist boot mode so we don't re-detect every time
    (dest_dir / ".boot_mode").write_text(boot_mode)
    logger.info("Boot mode detected: %s for %s", boot_mode, cache_key)

    # Remove the raw tarball to save disk space
    tar_path.unlink(missing_ok=True)

    _progress[cache_key] = {
        "status": DownloadStatus.ready.value,
        "progress": 100,
        "error": None,
        "boot_mode": boot_mode,
    }
    logger.info("Artifacts ready [%s]: %s", boot_mode, cache_key)


# ── Streaming download ────────────────────────────────────────────────────────

async def _stream_download(
    url: str, dest: Path, total_size: int, cache_key: str, cfg
) -> None:
    tmp = dest.with_suffix(".tmp")
    downloaded = 0

    headers: dict[str, str] = {}
    if cfg.github_token:
        headers["Authorization"] = f"Bearer {cfg.github_token}"

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(connect=30, read=3600, write=60, pool=30),
        follow_redirects=True,
        headers=headers,
    ) as client:
        async with client.stream("GET", url) as resp:
            resp.raise_for_status()
            with tmp.open("wb") as fh:
                async for chunk in resp.aiter_bytes(1 << 20):  # 1 MiB
                    fh.write(chunk)
                    downloaded += len(chunk)
                    pct = int(downloaded * 88 / total_size) if total_size > 0 else 0
                    _progress[cache_key].update({
                        "progress": pct,
                        "bytes_downloaded": downloaded,
                        "bytes_total": total_size,
                    })

    tmp.rename(dest)


# ── Tar extraction ────────────────────────────────────────────────────────────

def _extract_tar(tar_path: Path, dest_dir: Path) -> None:
    """
    Extract installer-net.tar to dest_dir, preserving the directory structure.

    Security: we validate member paths to prevent path traversal attacks.
    """
    logger.info("Extracting %s to %s", tar_path, dest_dir)
    dest_dir_str = str(dest_dir.resolve())

    with tarfile.open(tar_path, "r:*") as tf:
        for member in tf.getmembers():
            # Normalise the member path
            member_path = Path(member.name)
            # Reject absolute paths and traversal components
            if member_path.is_absolute() or ".." in member_path.parts:
                logger.warning("Skipping unsafe tar member: %s", member.name)
                continue

            target = (dest_dir / member_path).resolve()
            if not str(target).startswith(dest_dir_str):
                logger.warning("Skipping path-traversal attempt: %s", member.name)
                continue

            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with tf.extractfile(member) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
                logger.debug("Extracted: %s (%s)", member.name, _human_size(member.size))

    logger.info("Extraction complete for %s", tar_path.name)


# ── grub.cfg customisation ────────────────────────────────────────────────────

def patch_grub_cfg(dest_dir: Path, grub_vars: dict[str, str]) -> None:
    """
    Prepend EVE-install variable overrides to the served EFI/BOOT/grub.cfg.

    GRUB reads this file on startup.  Variables set here override the
    defaults from the original EVE grub config without modifying the ISO.

    Variables relevant to the EVE installer:
      eve_install_disk     — target install disk  (e.g. /dev/sda)
      eve_persist_disk     — persist partition disk
      eve_soft_serial      — device serial override
      dom0_extra_args      — appended verbatim to kernel cmdline
      timeout              — grub menu timeout (0 = instant boot)
      default              — default menu entry index
    """
    grub_cfg_path = dest_dir / "EFI" / "BOOT" / "grub.cfg"
    if not grub_cfg_path.exists():
        logger.warning("grub.cfg not found at %s — skipping patch", grub_cfg_path)
        return

    original_content = grub_cfg_path.read_text(encoding="utf-8", errors="replace")

    # Build the prefix block
    lines = [
        "# ── EVE-OS iPXE Server — auto-generated variable overrides ───────────────",
        "# Generated by eve-ipxe-server; do not edit — regenerate via the web UI.",
        "",
    ]
    for var, val in grub_vars.items():
        if val:  # skip empty/None values
            # Escape double quotes within the value
            safe_val = val.replace('"', '\\"')
            lines.append(f'set {var}="{safe_val}"')

    lines += ["", "# ── Original EVE installer GRUB configuration ───────────────────────────", ""]
    prefix = "\n".join(lines) + "\n"

    # Write the patched version (keep the original backed up)
    orig_backup = grub_cfg_path.with_suffix(".cfg.orig")
    if not orig_backup.exists():
        orig_backup.write_text(original_content, encoding="utf-8")

    grub_cfg_path.write_text(prefix + original_content, encoding="utf-8")
    logger.info("Patched EFI/BOOT/grub.cfg with %d variable overrides", len(grub_vars))


# ── Cache listing ─────────────────────────────────────────────────────────────

async def list_cached_artifacts() -> list[dict]:
    """Return a list of all artifact sets that have been (fully or partially) downloaded."""
    cfg = get_settings()
    result = []
    root = cfg.artifacts_dir
    if not root.exists():
        return result

    for version_dir in sorted(root.iterdir()):
        if not version_dir.is_dir() or version_dir.name.startswith("."):
            continue
        for combo_dir in sorted(version_dir.iterdir()):
            if not combo_dir.is_dir() or combo_dir.name.startswith("."):
                continue
            boot_mode = detect_boot_mode(combo_dir)
            files = [p for p in combo_dir.rglob("*") if p.is_file()]
            result.append({
                "version": version_dir.name,
                "combo": combo_dir.name,
                "boot_mode": boot_mode,
                "status": "ready" if boot_mode != BOOT_MODE_UNKNOWN else "incomplete",
                "files": sorted(str(f.relative_to(combo_dir)) for f in files),
                "size_bytes": sum(f.stat().st_size for f in files),
            })
    return result


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"
