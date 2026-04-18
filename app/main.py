"""
eve-ipxe-server — FastAPI application entry point.

Startup sequence:
  1. Ensure data directories exist.
  2. Initialise the SQLite database (create tables).
  3. Download iPXE bootstrap binaries (undionly.kpxe, ipxe.efi, ipxe-arm64.efi).
  4. Start the embedded TFTP server on port 6969.
  5. Regenerate the active boot.ipxe script (if a config exists from a previous run).
  6. Start Uvicorn serving the FastAPI app on port 8080.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.database import init_db, get_session_factory
from app.models import BootConfig, DownloadStatus
from app.routers import releases, configuration, artifacts, ipxe
from app.services import artifact_manager, tftp_server, ipxe_generator

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown logic."""
    cfg = get_settings()
    logger.info("EVE-OS iPXE Server starting up")
    logger.info("  Server host : %s", cfg.get_server_host())
    logger.info("  Artifacts   : %s", cfg.artifacts_dir)
    logger.info("  TFTP root   : %s", cfg.tftp_root)
    logger.info("  Config DB   : %s", cfg.config_dir / "eve-ipxe.db")

    # 1. Ensure all directories exist
    cfg.ensure_directories()

    # 2. Initialise database
    await init_db()
    logger.info("Database initialised")
    artifact_manager.init_semaphore(cfg.max_concurrent_downloads)
    logger.info("Download semaphore initialised (max=%d)", cfg.max_concurrent_downloads)

    # 3. Download iPXE binaries (runs in background, non-blocking)
    _bootstrap_task = asyncio.create_task(_bootstrap_ipxe_binaries())
    _bootstrap_task.add_done_callback(
        lambda t: logger.error("iPXE bootstrap task raised: %s", t.exception())
        if not t.cancelled() and t.exception() else None
    )

    # 4. Start TFTP server
    tftp_server.start()

    # 5. Regenerate active boot script from previous session
    _restore_task = asyncio.create_task(_restore_active_script())
    _restore_task.add_done_callback(
        lambda t: logger.error("Script restore task raised: %s", t.exception())
        if not t.cancelled() and t.exception() else None
    )

    yield  # application runs here

    # Shutdown
    tftp_server.stop()
    logger.info("EVE-OS iPXE Server shut down")


async def _bootstrap_ipxe_binaries() -> None:
    try:
        await artifact_manager.ensure_ipxe_binaries()
    except Exception as exc:
        logger.warning("iPXE binary bootstrap failed: %s", exc)


async def _restore_active_script() -> None:
    """Regenerate boot.ipxe for the previously active config (if any)."""
    try:
        factory = get_session_factory()
        async with factory() as db:
            from sqlalchemy import select
            result = await db.execute(
                select(BootConfig).where(
                    BootConfig.is_active == True,
                    BootConfig.download_status == DownloadStatus.ready.value,
                )
            )
            active = result.scalar_one_or_none()
            if active:
                ipxe_generator.write_active_script(active)
                logger.info("Restored active boot script for config %s", active.name)
    except Exception as exc:
        logger.warning("Could not restore active boot script: %s", exc)


# ── Application ────────────────────────────────────────────────────────────────

app = FastAPI(
    title="EVE-OS iPXE Boot Server",
    description=(
        "Web-based iPXE network boot service for deploying EVE-OS onto "
        "bare-metal nodes, virtual machines, and edge devices."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS — allow the browser-based wizard to call the API from any origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ────────────────────────────────────────────────────────────────────
app.include_router(releases.router)
app.include_router(configuration.router)
app.include_router(artifacts.router)
app.include_router(ipxe.router)

# ── Static files (web UI) ──────────────────────────────────────────────────────
_static_dir = Path(__file__).parent / "static"
_static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")


# ── Health & root ──────────────────────────────────────────────────────────────

@app.get("/health", include_in_schema=False)
async def health():
    tftp_ok = tftp_server.is_running()
    payload = {"status": "ok" if tftp_ok else "degraded", "tftp": tftp_ok}
    if not tftp_ok:
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.get("/", include_in_schema=False)
async def root():
    """Redirect browser requests to the web UI."""
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url="/static/index.html")


# ── Global exception handler ───────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": "An internal error occurred. Check server logs."},
    )
