"""
Embedded TFTP server using the tftpy library.

The server runs in a background daemon thread so it shares the process with
FastAPI.  The TFTP root directory is populated with:
  - undionly.kpxe        BIOS iPXE chainload binary
  - ipxe.efi             UEFI x86_64 iPXE binary
  - ipxe-arm64.efi       UEFI ARM64 iPXE binary
  - boot.ipxe            Default boot script (regenerated when config changes)

TFTP listens on port 6969 inside the container (Docker maps host:69 → 6969/udp).
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional

import tftpy

from app.config import get_settings

logger = logging.getLogger(__name__)

_server_thread: Optional[threading.Thread] = None
_tftp_server: Optional[tftpy.TftpServer] = None


def start() -> None:
    """Start the TFTP server in a background daemon thread."""
    global _server_thread, _tftp_server

    if _server_thread is not None and _server_thread.is_alive():
        logger.debug("TFTP server already running")
        return

    cfg = get_settings()
    tftp_root = cfg.tftp_root
    tftp_root.mkdir(parents=True, exist_ok=True)

    # tftpy is quite chatty by default — suppress below WARNING
    logging.getLogger("tftpy").setLevel(logging.WARNING)

    _tftp_server = tftpy.TftpServer(str(tftp_root))

    def _run() -> None:
        logger.info(
            "TFTP server starting on 0.0.0.0:%d, root=%s",
            cfg.tftp_port, tftp_root,
        )
        try:
            _tftp_server.listen("0.0.0.0", cfg.tftp_port)
        except Exception as exc:
            logger.error("TFTP server exited unexpectedly: %s", exc)

    _server_thread = threading.Thread(target=_run, name="tftp-server", daemon=True)
    _server_thread.start()
    logger.info("TFTP server thread started (port %d)", cfg.tftp_port)


def stop() -> None:
    """Signal the TFTP server to stop."""
    global _tftp_server
    if _tftp_server is not None:
        try:
            _tftp_server.stop()
        except Exception as exc:
            logger.debug("TFTP stop: %s", exc)
        _tftp_server = None


def is_running() -> bool:
    return _server_thread is not None and _server_thread.is_alive()


def write_boot_script(content: str, filename: str = "boot.ipxe") -> None:
    """Write an iPXE script to the TFTP root atomically so a booting node
    never reads a partially-written file."""
    cfg = get_settings()
    dest = cfg.tftp_root / filename
    tmp = dest.with_suffix(".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(dest)  # atomic on POSIX
    logger.info("Wrote iPXE script to TFTP root: %s", dest)
