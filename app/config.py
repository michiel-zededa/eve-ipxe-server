"""
Application configuration loaded from environment variables.
All settings have production-safe defaults.
"""
from __future__ import annotations

import socket
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Paths ──────────────────────────────────────────────────────────────────
    artifacts_dir: Path = Path("/data/artifacts")
    config_dir: Path = Path("/data/config")
    tftp_root: Path = Path("/data/tftp")

    # ── Network ───────────────────────────────────────────────────────────────
    server_host: str = ""          # auto-detected if empty
    webui_port: int = 8080
    http_port: int = 8081          # nginx artifact port (external)
    tftp_port: int = 6969          # internal TFTP port (mapped to host:69)

    # ── GitHub ────────────────────────────────────────────────────────────────
    github_token: str = ""
    github_api_base: str = "https://api.github.com"
    eve_repo: str = "lf-edge/eve"

    # ── Misc ──────────────────────────────────────────────────────────────────
    log_level: str = "info"
    # Max concurrent artifact downloads
    max_concurrent_downloads: int = 2

    def get_server_host(self) -> str:
        """Return the configured host, or auto-detect the host's LAN IP.

        When running inside a Docker container the routing-table approach
        returns the container's internal bridge IP (e.g. 172.18.0.2) which
        is unreachable by PXE clients on the LAN.  We detect this and fall
        back to host.docker.internal (resolved by Docker Desktop / Docker
        Engine on Linux with --add-host) which gives the real host LAN IP.
        """
        if self.server_host:
            return self.server_host

        def _is_docker_bridge(ip: str) -> bool:
            """Return True if ip looks like a Docker-managed bridge address."""
            # 172.16.0.0/12 is the range Docker uses for bridge networks
            parts = ip.split(".")
            if len(parts) != 4:
                return False
            try:
                return int(parts[0]) == 172 and 16 <= int(parts[1]) <= 31
            except ValueError:
                return False

        # Try ip route first (Linux)
        candidate = ""
        try:
            result = subprocess.run(
                ["ip", "-4", "route", "get", "1.1.1.1"],
                capture_output=True, text=True, timeout=2,
            )
            tokens = result.stdout.split()
            if "src" in tokens:
                candidate = tokens[tokens.index("src") + 1]
        except Exception:
            pass

        # If we're in a container (/.dockerenv exists) and the detected IP is
        # a Docker bridge address, try host.docker.internal instead — this
        # resolves to the actual host machine's IP on Docker Desktop (Mac/Win)
        # and on Linux when --add-host=host.docker.internal:host-gateway is set.
        in_container = Path("/.dockerenv").exists()
        if (not candidate or _is_docker_bridge(candidate)) and in_container:
            try:
                host_ip = socket.getaddrinfo("host.docker.internal", None,
                                             socket.AF_INET)[0][4][0]
                if host_ip and not _is_docker_bridge(host_ip):
                    return host_ip
            except Exception:
                pass

        if candidate:
            return candidate

        # Final fallback: socket trick
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(("8.8.8.8", 80))
                return s.getsockname()[0]
        except Exception:
            return "127.0.0.1"

    def artifact_http_base(self) -> str:
        host = self.get_server_host()
        return f"http://{host}:{self.http_port}/artifacts"

    def webui_base(self) -> str:
        host = self.get_server_host()
        return f"http://{host}:{self.webui_port}"

    def ensure_directories(self) -> None:
        """Create required directories if they don't exist."""
        for d in (self.artifacts_dir, self.config_dir, self.tftp_root):
            d.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
