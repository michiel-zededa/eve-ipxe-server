"""
SQLAlchemy ORM models and Pydantic schemas for the eve-ipxe-server.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import (
    JSON, Boolean, Column, DateTime, Enum, Integer, String, Text,
    func,
)
from sqlalchemy.orm import DeclarativeBase


# ── ORM base ──────────────────────────────────────────────────────────────────

class Base(DeclarativeBase):
    pass


# ── Enumerations ──────────────────────────────────────────────────────────────

class Architecture(str, enum.Enum):
    amd64 = "amd64"
    arm64 = "arm64"


class HypervisorMode(str, enum.Enum):
    k   = "k"    # bare-metal, no KVM (amd64 only)
    kvm = "kvm"  # KVM hypervisor


class Variant(str, enum.Enum):
    generic    = "generic"
    nvidia_jp5 = "nvidia-jp5"
    nvidia_jp6 = "nvidia-jp6"


class InstallScenario(str, enum.Enum):
    baremetal = "baremetal"   # Physical server, no hypervisor layer
    vm        = "vm"          # QEMU/KVM virtual machine
    edge      = "edge"        # Edge device (Raspberry Pi, Jetson, etc.)


class DownloadStatus(str, enum.Enum):
    pending     = "pending"
    downloading = "downloading"
    extracting  = "extracting"
    ready       = "ready"
    failed      = "failed"


# ── ORM Models ────────────────────────────────────────────────────────────────

class BootConfig(Base):
    """Persisted iPXE boot configuration."""
    __tablename__ = "boot_configs"

    id              = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name            = Column(String(128), nullable=False, default="Default Config")
    is_active       = Column(Boolean, nullable=False, default=False)
    created_at      = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    updated_at      = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    # EVE version selection
    eve_version     = Column(String(32), nullable=False)
    architecture    = Column(String(8), nullable=False)
    hv_mode         = Column(String(8), nullable=False, default="kvm")
    variant         = Column(String(16), nullable=False, default="generic")

    # Install scenario
    scenario        = Column(String(16), nullable=False, default="baremetal")

    # Boot parameters
    install_disk    = Column(String(64), nullable=False, default="/dev/sda")
    persist_disk    = Column(String(64), nullable=True)
    controller_url  = Column(String(256), nullable=True)
    onboarding_key  = Column(String(256), nullable=True)
    soft_serial     = Column(String(64), nullable=True)
    reboot_after_install = Column(Boolean, nullable=False, default=True)
    nuke_disk       = Column(Boolean, nullable=False, default=False)
    pause_before_install = Column(Boolean, nullable=False, default=False)

    # Console
    console         = Column(String(64), nullable=False, default="tty0 ttyS0,115200n8")

    # Extra raw kernel command line appended verbatim
    extra_cmdline   = Column(Text, nullable=True)

    # Download state for the associated artifacts
    download_status = Column(String(16), nullable=False, default=DownloadStatus.pending.value)
    download_error  = Column(Text, nullable=True)
    download_progress = Column(Integer, nullable=True)  # 0-100


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

class ReleaseAsset(BaseModel):
    name: str
    size: int
    browser_download_url: str
    content_type: str


class Release(BaseModel):
    tag_name: str
    name: str
    published_at: str
    prerelease: bool
    draft: bool
    assets: list[ReleaseAsset]


class ArtifactKey(BaseModel):
    eve_version: str
    architecture: Architecture
    hv_mode:      HypervisorMode
    variant:      Variant = Variant.generic

    def asset_prefix(self) -> str:
        return f"{self.architecture}.{self.hv_mode}.{self.variant}"

    def cache_dir_name(self) -> str:
        return f"{self.eve_version}/{self.asset_prefix()}"


class ArtifactStatusResponse(BaseModel):
    key: ArtifactKey
    status: DownloadStatus
    progress: Optional[int]
    error: Optional[str]
    artifacts: Optional[list[str]]
    bytes_downloaded: Optional[int]
    bytes_total: Optional[int]


class BootConfigCreate(BaseModel):
    name: str = "Default Config"
    eve_version: str = Field(..., min_length=1, description="EVE-OS release tag (e.g. '16.12.0')")
    architecture: Architecture
    hv_mode: HypervisorMode = HypervisorMode.kvm
    variant: Variant = Variant.generic
    scenario: InstallScenario = InstallScenario.baremetal
    install_disk: str = "/dev/sda"
    persist_disk: Optional[str] = None
    controller_url: Optional[str] = None
    onboarding_key: Optional[str] = None
    soft_serial: Optional[str] = None
    reboot_after_install: bool = True
    nuke_disk: bool = False
    pause_before_install: bool = False
    console: str = "tty0 ttyS0,115200n8"
    extra_cmdline: Optional[str] = None

    @field_validator("install_disk")
    @classmethod
    def validate_disk(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("/dev/"):
            raise ValueError("Disk path must start with /dev/")
        return v

    @field_validator("persist_disk")
    @classmethod
    def validate_persist_disk(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v.strip() == "":
            return None
        v = v.strip()
        if not v.startswith("/dev/"):
            raise ValueError("Persist disk path must start with /dev/")
        return v

    @field_validator("controller_url")
    @classmethod
    def validate_controller_url(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v.strip() == "":
            return None
        v = v.strip()
        # Auto-fix common single-slash typo: https:/foo → https://foo
        import re
        v = re.sub(r'^(https?:/)(?!/)', r'\1/', v)
        if not (v.startswith("https://") or v.startswith("http://")):
            raise ValueError("Controller URL must start with https:// or http://")
        return v

    @field_validator("extra_cmdline")
    @classmethod
    def validate_extra_cmdline(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v.strip() == "":
            return None
        v = v.strip()
        # Reject newlines and null bytes which could break kernel cmdline parsing
        if any(c in v for c in ("\n", "\r", "\x00")):
            raise ValueError("extra_cmdline must not contain newlines or null bytes")
        return v

    @model_validator(mode="after")
    def validate_hv_arch_combo(self) -> "BootConfigCreate":
        # amd64.k.generic is the only non-KVM combo that has installer-net
        if self.hv_mode == HypervisorMode.k and self.architecture != Architecture.amd64:
            raise ValueError(
                "hv_mode 'k' (no-KVM bare-metal) is only available for amd64. "
                "Use hv_mode 'kvm' for arm64."
            )
        return self


class BootConfigResponse(BaseModel):
    id: str
    name: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    eve_version: str
    architecture: str
    hv_mode: str
    variant: str
    scenario: str
    install_disk: str
    persist_disk: Optional[str]
    controller_url: Optional[str]
    onboarding_key: Optional[str]
    soft_serial: Optional[str]
    reboot_after_install: bool
    nuke_disk: bool
    pause_before_install: bool
    console: str
    extra_cmdline: Optional[str]
    download_status: str
    download_error: Optional[str]
    download_progress: Optional[int]

    model_config = {"from_attributes": True}


class BootConfigListResponse(BaseModel):
    """Like BootConfigResponse but omits sensitive fields for list endpoints."""
    id: str
    name: str
    is_active: bool
    created_at: datetime
    updated_at: datetime
    eve_version: str
    architecture: str
    hv_mode: str
    variant: str
    scenario: str
    install_disk: str
    persist_disk: Optional[str]
    controller_url: Optional[str]
    soft_serial: Optional[str]
    reboot_after_install: bool
    nuke_disk: bool
    pause_before_install: bool
    console: str
    extra_cmdline: Optional[str]
    download_status: str
    download_error: Optional[str]
    download_progress: Optional[int]

    model_config = {"from_attributes": True}


class IPXEScriptResponse(BaseModel):
    config_id: str
    script: str
    tftp_filename: str
    http_url: str


class ServerInfoResponse(BaseModel):
    server_host: str
    webui_port: int
    http_port: int
    tftp_port_external: int   # always 69 (Docker maps from 6969)
    artifact_http_base: str
    webui_base: str
    ipxe_boot_url: str
    ipxe_boot_tftp: str
