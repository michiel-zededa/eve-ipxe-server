"""
iPXE script generator.

Handles two distinct boot modes introduced across EVE-OS versions:

  BOOT_MODE_GRUB_CHAIN  (v12+)
  ─────────────────────────────
  installer-net.tar contains GRUB EFI binaries + installer.iso.
  Generated boot.ipxe:
    1. Sets ${url} to our HTTP artifact base.
    2. Sets ${console} (kernel console specs).
    3. Chains to EFI/BOOT/BOOTX64.EFI or BOOTAA64.EFI (GRUB).
    4. BIOS fallback: sanboot --no-describe ${url}installer.iso
  User parameters are injected into EFI/BOOT/grub.cfg via
  artifact_manager.patch_grub_cfg(), which GRUB reads on startup.

  BOOT_MODE_DIRECT  (pre-v12)
  ────────────────────────────
  installer-net.tar contains bare kernel + initrd.img.
  Generated boot.ipxe loads them directly:
    kernel http://.../kernel <full cmdline>
    initrd http://.../initrd.img
    boot

EVE-OS kernel parameters (kernel cmdline reference)
────────────────────────────────────────────────────
  eve_install_disk=<dev>          Target installation disk (e.g. /dev/sda)
  eve_persist_disk=<dev>          Persist data partition disk
  eve_install_server=<url>        ZedCloud controller URL
  eve_onboarding_key=<key>        Device onboarding key
  eve_soft_serial=<str>           Device serial number override
  eve_reboot_after_install=1      Reboot immediately after install
  eve_nuke_disk=<dev>             Wipe disk (DESTRUCTIVE – use with care)
  eve_pause_before_install=1      Drop to debug shell before install
  eve_pause_after_install=1       Drop to debug shell after install
  console=<spec>                  Linux console (repeatable)
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app.config import get_settings
from app.models import (
    ArtifactKey, Architecture, BootConfig, HypervisorMode, InstallScenario, Variant,
)
from app.services.artifact_manager import (
    BOOT_MODE_DIRECT,
    BOOT_MODE_GRUB_CHAIN,
    artifact_dir,
    patch_grub_cfg,
    read_boot_mode,
)

logger = logging.getLogger(__name__)

_TEMPLATE_DIR = Path(__file__).parent.parent / "templates"


def _jinja_env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(_TEMPLATE_DIR)),
        undefined=StrictUndefined,
        autoescape=False,
        trim_blocks=True,
        lstrip_blocks=True,
    )


# ── Kernel cmdline construction ───────────────────────────────────────────────

def build_kernel_cmdline(cfg: BootConfig) -> str:
    """
    Build the Linux kernel command line for the EVE installer.
    Used for BOOT_MODE_DIRECT (pre-v12) where iPXE loads the kernel directly.
    """
    parts: list[str] = []

    # Console(s) — always first for serial visibility
    console = cfg.console or "tty0 ttyS0,115200n8"
    for spec in console.split():
        parts.append(f"console={spec}")

    # Install disk (required)
    parts.append(f"eve_install_disk={cfg.install_disk}")

    # Persist disk
    if cfg.persist_disk:
        parts.append(f"eve_persist_disk={cfg.persist_disk}")

    # ZedCloud controller
    if cfg.controller_url:
        parts.append(f"eve_install_server={cfg.controller_url}")

    # Onboarding key
    if cfg.onboarding_key:
        parts.append(f"eve_onboarding_key={cfg.onboarding_key}")

    # Serial override
    if cfg.soft_serial:
        parts.append(f"eve_soft_serial={cfg.soft_serial}")
    else:
        # Use MAC-based serial as default (EVE convention)
        parts.append("eve_soft_serial=${net0/mac:hexhyp}")

    # Behaviour flags
    if cfg.reboot_after_install:
        parts.append("eve_reboot_after_install=1")
    if cfg.nuke_disk:
        parts.append(f"eve_nuke_disk={cfg.install_disk}")
    if cfg.pause_before_install:
        parts.append("eve_pause_before_install=1")

    # Extra user-supplied params
    if cfg.extra_cmdline and cfg.extra_cmdline.strip():
        parts.append(cfg.extra_cmdline.strip())

    return " ".join(parts)


def build_grub_vars(cfg: BootConfig) -> dict[str, str]:
    """
    Build the GRUB variable overrides injected into EFI/BOOT/grub.cfg.
    Used for BOOT_MODE_GRUB_CHAIN (v12+).

    dom0_extra_args is appended verbatim to the Linux kernel cmdline by
    EVE's grub configuration (rootfs.cfg / grub_installer.cfg).
    """
    extra_args_parts: list[str] = []

    extra_args_parts.append(f"eve_install_disk={cfg.install_disk}")

    if cfg.persist_disk:
        extra_args_parts.append(f"eve_persist_disk={cfg.persist_disk}")

    if cfg.controller_url:
        extra_args_parts.append(f"eve_install_server={cfg.controller_url}")

    if cfg.onboarding_key:
        extra_args_parts.append(f"eve_onboarding_key={cfg.onboarding_key}")

    if cfg.soft_serial:
        extra_args_parts.append(f"eve_soft_serial={cfg.soft_serial}")

    if cfg.reboot_after_install:
        extra_args_parts.append("eve_reboot_after_install=1")

    if cfg.nuke_disk:
        extra_args_parts.append(f"eve_nuke_disk={cfg.install_disk}")

    if cfg.pause_before_install:
        extra_args_parts.append("eve_pause_before_install=1")

    if cfg.extra_cmdline and cfg.extra_cmdline.strip():
        extra_args_parts.append(cfg.extra_cmdline.strip())

    grub_vars: dict[str, str] = {
        "timeout": "0",           # boot immediately without showing the menu
        "default": "0",           # always choose the first menu entry (install)
        "dom0_extra_args": " ".join(extra_args_parts),
    }

    # Scenario-specific console tweaks
    console = cfg.console or "tty0 ttyS0,115200n8"
    if cfg.scenario == InstallScenario.vm.value:
        # QEMU/KVM typically uses hvc0 or ttyS0
        grub_vars["dom0_console"] = "console=hvc0 console=ttyS0"
    elif cfg.scenario == InstallScenario.edge.value and cfg.architecture == "arm64":
        grub_vars["dom0_console"] = "console=ttyAMA0,115200n8 console=ttyS0,115200n8"
    else:
        # Build from the user's console config
        console_args = " ".join(f"console={s}" for s in console.split())
        grub_vars["dom0_console"] = console_args

    return grub_vars


# ── Script generation ─────────────────────────────────────────────────────────

def generate_script(config: BootConfig) -> str:
    """
    Generate a complete iPXE boot script for the given BootConfig.
    Auto-detects the boot mode from cached artifacts and generates
    the appropriate script.

    Returns the iPXE script text.
    """
    settings = get_settings()
    server = settings.get_server_host()
    http_port = settings.http_port
    webui_port = settings.webui_port

    artifact_base_path = (
        f"{config.eve_version}/{config.architecture}.{config.hv_mode}.{config.variant}"
    )
    artifact_http_base = (
        f"http://{server}:{http_port}/artifacts/{artifact_base_path}"
    )

    # Determine boot mode from cached artifacts
    try:
        _key = ArtifactKey(
            eve_version=config.eve_version,
            architecture=Architecture(config.architecture),
            hv_mode=HypervisorMode(config.hv_mode),
            variant=Variant(config.variant),
        )
        boot_mode = read_boot_mode(_key)
    except Exception:
        _key = None
        boot_mode = BOOT_MODE_GRUB_CHAIN  # safe default for modern EVE

    env = _jinja_env()

    if boot_mode == BOOT_MODE_GRUB_CHAIN:
        tmpl = env.get_template("boot_grub_chain.ipxe.j2")
        script = tmpl.render(
            config=config,
            artifact_http_base=artifact_http_base,
            server=server,
            webui_port=webui_port,
            http_port=http_port,
        )
    else:
        # BOOT_MODE_DIRECT or BOOT_MODE_UNKNOWN — fall back to direct iPXE kernel loading
        kernel_cmdline = build_kernel_cmdline(config)
        tmpl = env.get_template("boot_direct.ipxe.j2")
        script = tmpl.render(
            config=config,
            artifact_http_base=artifact_http_base,
            kernel_cmdline=kernel_cmdline,
            server=server,
            webui_port=webui_port,
        )

    return script


def generate_menu_script(configs: list[BootConfig]) -> str:
    """
    Generate an iPXE menu script displayed when multiple configs exist.
    Served as boot.ipxe from the TFTP root.
    """
    settings = get_settings()
    server = settings.get_server_host()
    webui_port = settings.webui_port

    env = _jinja_env()
    tmpl = env.get_template("menu.ipxe.j2")
    return tmpl.render(
        configs=configs,
        server=server,
        webui_port=webui_port,
    )


def write_active_script(config: BootConfig) -> Path:
    """
    Write the iPXE script for *config* to the TFTP root and patch grub.cfg:
      - config-<id>.ipxe  (config-specific URL)
      - boot.ipxe          (default — always points to the active config)
      - EFI/BOOT/grub.cfg  (patched with install vars for grub-chain mode)
    Returns the path of boot.ipxe.
    """
    from app.services import tftp_server

    # Determine boot mode to decide whether to patch grub.cfg
    try:
        _key = ArtifactKey(
            eve_version=config.eve_version,
            architecture=Architecture(config.architecture),
            hv_mode=HypervisorMode(config.hv_mode),
            variant=Variant(config.variant),
        )
        boot_mode = read_boot_mode(_key)
        dest = artifact_dir(_key)
    except Exception:
        boot_mode = BOOT_MODE_GRUB_CHAIN
        dest = None

    script = generate_script(config)
    tftp_server.write_boot_script(script, f"config-{config.id}.ipxe")
    tftp_server.write_boot_script(script, "boot.ipxe")
    logger.info("Updated TFTP boot.ipxe → config %s (%s)", config.id, config.name)

    # Patch grub.cfg only when activating (not on preview)
    if boot_mode == BOOT_MODE_GRUB_CHAIN and dest is not None and dest.exists():
        try:
            patch_grub_cfg(dest, build_grub_vars(config))
        except Exception as exc:
            logger.warning("Could not patch grub.cfg: %s", exc)

    settings = get_settings()
    return settings.tftp_root / "boot.ipxe"
