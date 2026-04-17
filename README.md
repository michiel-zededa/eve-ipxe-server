# EVE-OS iPXE Boot Server

> **Web-based iPXE network boot service for deploying EVE-OS onto bare-metal nodes, virtual machines, and edge devices.**

Built by [ZEDEDA](https://www.zededa.com) — deploy EVE-OS at scale with a single `docker compose up`.

---

## Overview

This stack provides a fully self-contained PXE/iPXE boot environment that:

1. Fetches available EVE-OS releases from the [LF Edge GitHub repository](https://github.com/lf-edge/eve)
2. Guides you through a browser-based configuration wizard (version, architecture, HV mode, boot parameters)
3. Downloads and caches the EVE installer artifacts (`installer-net.tar`)
4. Generates a customised iPXE boot script injecting all installation parameters
5. Serves bootstrap iPXE binaries via **TFTP** (port 69) and artifact files via **HTTP nginx** (port 8081)
6. Optionally runs a lightweight **dnsmasq DHCP** service that points PXE clients to this server

### Supported targets

| Target | Architecture | HV mode | Variant |
|--------|-------------|---------|---------|
| amd64 bare metal or hypervisor | amd64 | k ¹ | generic |
| amd64 bare metal or hypervisor (with VM acceleration) | amd64 | kvm | generic |
| ARM64 bare metal or hypervisor | arm64 | kvm | generic |
| Raspberry Pi 4/5 (UEFI) | arm64 | kvm | generic |
| NVIDIA Jetson (JetPack 5) | arm64 | kvm | nvidia-jp5 |
| NVIDIA Jetson (JetPack 6) | arm64 | kvm | nvidia-jp6 |

> ¹ The `k` (no-KVM) HV mode was introduced in **EVE 16.x**. It is not available in older releases.

> **Note:** NVIDIA JetPack variants do **not** ship a network installer (`installer-net.tar`). Use the raw installer image and flash it via USB/SD card for initial provisioning.

---

## Prerequisites

- Docker Engine ≥ 24 and Docker Compose plugin v2
- Outbound internet access (to download EVE releases from GitHub)
- Host port **69/udp** (TFTP), **8080/tcp** (Web UI), **8081/tcp** (nginx artifacts) available
- For the optional DHCP service: the host must be on the same L2 segment as the nodes being booted

> **Note:** The webui container runs as root (`user: "0"` in `docker-compose.yml`) so it can access the Docker socket and power the **Stop Server** button. Remove the `user: "0"` line and the socket mount if you prefer a non-root container — the Stop button will then show a 503 and you can use `./server.sh stop` instead.

---

## Quick Start

```bash
git clone https://github.com/your-org/eve-ipxe-server
cd eve-ipxe-server

# 1. Configure environment
cp .env.example .env
# Edit .env — at minimum set SERVER_HOST to this machine's LAN IP:
#   SERVER_HOST=192.168.1.10

# 2. Start the stack
./server.sh start          # or: docker compose up -d

# 3. Open the wizard in your browser
open http://localhost:8080
```

The included `server.sh` script manages the stack:

```bash
./server.sh start           # start all containers (detached)
./server.sh stop            # stop and remove all containers
./server.sh restart         # restart containers
./server.sh status          # show container status + health checks
./server.sh logs [service]  # tail logs (e.g. ./server.sh logs webui)
./server.sh build           # rebuild images after a code change

PROFILES=dnsmasq ./server.sh start   # also start the optional DHCP service
```

Follow the 4-step wizard:
1. **Select EVE-OS version** — fetched live from GitHub
2. **Choose target platform** — architecture, hypervisor mode, scenario
3. **Configure boot parameters** — install disk, controller URL, etc.
4. **Download & activate** — artifacts are downloaded in the background; progress is streamed live

Once complete, the generated `boot.ipxe` is available at:
- HTTP: `http://SERVER_HOST:8080/ipxe/boot.ipxe`
- TFTP: `tftp://SERVER_HOST/boot.ipxe`

---

## EVE-OS iPXE Boot Process

### v12+ (current — grub-chain mode)

`installer-net.tar` contains a GRUB EFI binary and the full `installer.iso`.
The boot chain is:

```
DHCP (option 66/67)
  → TFTP: undionly.kpxe / ipxe.efi
  → HTTP: boot.ipxe  (sets ${url}, chains to GRUB)
  → HTTP: EFI/BOOT/BOOTX64.EFI  (GRUB EFI)
  → HTTP: EFI/BOOT/grub.cfg     (pre-patched with install params)
  → HTTP: installer.iso          (loop-mounted by GRUB)
  → kernel + initrd              (loaded from ISO by GRUB)
  → EVE-OS installer runs
```

Install parameters (`eve_install_disk`, `eve_install_server`, etc.) are injected
into `EFI/BOOT/grub.cfg` via `dom0_extra_args`. GRUB reads this patched config
on startup, sets `timeout=0`, and auto-installs without user interaction.

### Pre-v12 (direct mode)

Older EVE releases shipped bare `kernel` + `initrd.img` in the installer-net tarball.
iPXE loads them directly:

```
DHCP → TFTP → iPXE → kernel <cmdline> → EVE installer
```

The server auto-detects which mode applies based on what's inside the downloaded tarball.

---

## Network Configuration

### Option A — Bundled dnsmasq (recommended for lab environments)

```bash
# Edit .env:
INTERFACE=eth0
DHCP_RANGE=192.168.1.100,192.168.1.200,12h
DHCP_ROUTER=192.168.1.1
DHCP_DNS=8.8.8.8
SERVER_HOST=192.168.1.10

docker compose --profile dnsmasq up -d
```

The dnsmasq container requires `network_mode: host` so it can receive DHCP broadcast packets.
It handles BIOS PXE (DHCP options 66/67), UEFI amd64 (arch 7), and UEFI ARM64 (arch 11).

### Option B — Configure your existing DHCP server

#### ISC DHCP (`dhcpd.conf`)

```conf
next-server 192.168.1.10;    # TFTP server = this host

# BIOS PXE clients
filename "undionly.kpxe";

# UEFI clients override the filename
class "UEFI-x86_64" {
  match if substring(option vendor-class-identifier, 0, 20) = "PXEClient:Arch:00007";
  filename "ipxe.efi";
}
class "UEFI-arm64" {
  match if substring(option vendor-class-identifier, 0, 20) = "PXEClient:Arch:00011";
  filename "ipxe-arm64.efi";
}

# Once iPXE is running, send it to the HTTP boot script
class "iPXE" {
  match if exists user-class and option user-class = "iPXE";
  filename "http://192.168.1.10:8080/ipxe/boot.ipxe";
}
```

#### dnsmasq (`dnsmasq.conf`)

```conf
interface=eth0
dhcp-range=192.168.1.100,192.168.1.200,12h

# TFTP server
dhcp-option=66,192.168.1.10

# BIOS
dhcp-boot=undionly.kpxe,192.168.1.10,192.168.1.10

# UEFI x86_64
dhcp-match=set:efi-x86_64,option:client-arch,7
dhcp-boot=tag:efi-x86_64,ipxe.efi,192.168.1.10,192.168.1.10

# UEFI arm64
dhcp-match=set:efi-arm64,option:client-arch,11
dhcp-boot=tag:efi-arm64,ipxe-arm64.efi,192.168.1.10,192.168.1.10

# iPXE userclass → HTTP boot script
dhcp-userclass=set:ipxe,iPXE
dhcp-boot=tag:ipxe,http://192.168.1.10:8080/ipxe/boot.ipxe
```

---

## Architecture-Specific Notes

### ARM64 — Raspberry Pi 4/5

Raspberry Pi requires UEFI firmware for network boot:

1. Install [RPi4 UEFI firmware](https://github.com/pftf/RPi4) onto an SD card
2. Configure the firmware to enable network boot (PXE)
3. Plug in an ethernet cable
4. Set `architecture=arm64`, `hv_mode=kvm`, `variant=generic`
5. Set `install_disk=/dev/mmcblk0` (eMMC) or `/dev/sda` (USB drive)
6. The `console` field should include `ttyAMA0,115200n8` for the Pi's serial console

### ARM64 — NVIDIA Jetson

Jetson Orin with JetPack 5/6 supports UEFI PXE boot:

1. Flash JetPack onto the Jetson (required for UEFI firmware)
2. Enter the UEFI setup and enable network boot
3. For **network installation**, use `variant=generic` — the nvidia-jp5/jp6 variants
   do not have a network installer, only raw images
4. Set `install_disk=/dev/nvme0n1` (internal NVMe) or appropriate device

### amd64 — HV mode comparison

Both modes run on bare metal and inside a hypervisor. The difference is what EVE offers to its own workloads:

| HV mode | EVE workload support | Artifact prefix | Min EVE version |
|---------|----------------------|-----------------|-----------------|
| `k`     | Containers and VMs without hardware acceleration | `amd64.k.generic` | 16.x |
| `kvm`   | Containers and hardware-accelerated VMs | `amd64.kvm.generic` | any |

Choose **`kvm`** when EVE needs to run hardware-accelerated VMs as workloads.
Choose **`k`** when only containers are needed, or when hardware VM acceleration is unavailable.
The wizard automatically disables the `k` option when a pre-16.x release is selected.

---

## QEMU Testing

Test the full PXE boot flow locally without physical hardware:

```bash
# Create a test disk
qemu-img create -f raw /tmp/eve-test.img 64G

# Boot via PXE (no DHCP needed — we use QEMU's built-in TFTP)
qemu-system-x86_64 \
  -m 4G -smp 2 \
  -enable-kvm \
  -drive format=raw,file=/tmp/eve-test.img,if=virtio \
  -netdev user,id=net0,\
    tftp=$(docker volume inspect eve-ipxe-tftp --format '{{.Mountpoint}}'),\
    bootfile=/boot.ipxe \
  -device virtio-net,netdev=net0 \
  -nographic
```

Or point QEMU to the HTTP boot script directly:

```bash
qemu-system-x86_64 \
  -m 4G -enable-kvm \
  -drive format=raw,file=/tmp/eve-test.img,if=virtio \
  -netdev user,id=net0 \
  -device virtio-net,netdev=net0 \
  -kernel /path/to/ipxe.lkrn \
  -append "dhcp && chain http://192.168.1.10:8080/ipxe/boot.ipxe" \
  -nographic
```

---

## EVE-OS Kernel Parameters Reference

Parameters injected into the grub.cfg (v12+) or kernel cmdline (pre-v12):

| Parameter | Description | Example |
|-----------|-------------|---------|
| `eve_install_disk` | Target installation disk | `/dev/sda` |
| `eve_persist_disk` | Persist data partition disk | `/dev/sdb` |
| `eve_install_server` | ZedCloud controller URL | `https://zedcloud.company.com` |
| `eve_onboarding_key` | Device onboarding key | `xxxxxxxx-xxxx-…` |
| `eve_soft_serial` | Device serial override | `server-rack1-u14` |
| `eve_reboot_after_install` | Auto-reboot after install | `1` |
| `eve_nuke_disk` | Forcibly wipe disk | `/dev/sda` |
| `eve_pause_before_install` | Drop to shell before install | `1` |
| `eve_pause_after_install` | Drop to shell after install | `1` |
| `eve_install_debug` | Enable installer debug output | `true` |

---

## Data Persistence

All state survives container restarts via named Docker volumes:

| Volume | Contents |
|--------|----------|
| `eve-ipxe-artifacts` | Downloaded EVE installer tarballs (extracted) |
| `eve-ipxe-config` | SQLite database (`eve-ipxe.db`), GRUB config patches |
| `eve-ipxe-tftp` | TFTP root: iPXE binaries, `boot.ipxe` |

To reset all state:
```bash
docker compose down -v
```

---

## API

FastAPI auto-generates interactive documentation at:
- Swagger UI: `http://localhost:8080/api/docs`
- ReDoc: `http://localhost:8080/api/redoc`

Key endpoints:

**Releases**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/releases` | List EVE-OS releases from GitHub |
| `GET` | `/api/releases/{tag}` | Get a specific release |
| `GET` | `/api/releases/{tag}/assets` | List installer assets for a release (filter: `?arch=amd64&hv=kvm`) |

**Boot configurations**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/configs` | List all boot configurations |
| `POST` | `/api/configs` | Create a boot configuration |
| `GET` | `/api/configs/{id}` | Get a single configuration |
| `PUT` | `/api/configs/{id}` | Update a configuration |
| `DELETE` | `/api/configs/{id}` | Delete a configuration |
| `POST` | `/api/configs/{id}/activate` | Activate a config (writes boot.ipxe to TFTP) |
| `GET` | `/api/configs/{id}/script` | Preview the generated iPXE script (no file write) |

**Artifacts**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/artifacts/download` | Trigger artifact download |
| `GET` | `/api/artifacts/stream/{ver}/{arch}/{hv}/{variant}` | SSE stream of download progress |
| `GET` | `/api/artifacts/status/{ver}/{arch}/{hv}/{variant}` | Poll download status |
| `GET` | `/api/artifacts/list` | List cached artifacts |
| `DELETE` | `/api/artifacts/{ver}/{arch}/{hv}/{variant}` | Delete cached artifacts |

**Boot scripts & info**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/server-info` | Server IP / port information |
| `GET` | `/ipxe/boot.ipxe` | Serve the active boot script (TFTP chainload target) |
| `GET` | `/ipxe/config/{id}/script` | Config-specific boot script |

**Admin**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/admin/shutdown` | Stop all stack containers gracefully (requires Docker socket mount) |

---

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_HOST` | auto | LAN IP of this server (auto-detected if unset) |
| `BIND_ADDRESS` | `0.0.0.0` | Host interface to bind ports to |
| `WEBUI_PORT` | `8080` | Web UI and API port |
| `HTTP_PORT` | `8081` | nginx artifact HTTP port |
| `GITHUB_TOKEN` | — | GitHub PAT to raise API rate limit |
| `INTERFACE` | `eth0` | Network interface for dnsmasq DHCP |
| `DHCP_RANGE` | `…` | DHCP pool range and lease time |
| `LOG_LEVEL` | `info` | Uvicorn log level |

---

## Troubleshooting

**TFTP not working / nodes can't download iPXE binary**
- Ensure port 69/udp is not blocked by your firewall
- Check `docker compose logs webui` for TFTP server startup messages
- On Linux: `ss -ulnp | grep :69`

**GitHub API rate limit**
- Without a token you get 60 requests/hour (usually sufficient)
- Set `GITHUB_TOKEN=<your PAT>` in `.env` for 5000 req/hour

**Download fails with "No installer-net asset found"**
- The selected version/arch/hv/variant combination may not ship an `installer-net.tar`
- NVIDIA jp5/jp6 variants never have a network installer
- Check the assets list at: `http://localhost:8080/api/releases/<tag>/assets`

**boot.ipxe loads but EVE installer panics / wrong disk**
- Verify the `install_disk` path — it varies by hardware (`/dev/sda`, `/dev/nvme0n1`, `/dev/mmcblk0`)
- Check EVE console output on the node (serial or video)
- Set `pause_before_install=true` to get a debug shell before install starts

**ARM64 node not PXE booting**
- Ensure UEFI is enabled on the device (Pi: RPi4 UEFI firmware; Jetson: JetPack)
- The `ipxe-arm64.efi` binary must be present in the TFTP root — check the Artifact Cache view
- Verify your DHCP server sends `filename "ipxe-arm64.efi"` for arch=11 clients

**Stop Server button shows "Docker socket not mounted" error**
- The stack must be fully restarted after the docker socket mount was added to `docker-compose.yml`:
  ```bash
  ./server.sh stop && ./server.sh start
  ```
- If the error persists, verify `/var/run/docker.sock` exists on the host (`ls -la /var/run/docker.sock`)
- As a fallback, always use `./server.sh stop` on the host

---

## Project Structure

```
eve-ipxe-server/
├── docker-compose.yml          # Service definitions (includes Docker socket mount)
├── Dockerfile                  # webui image (FastAPI + TFTP)
├── server.sh                   # Stack management: start / stop / restart / status / logs
├── requirements.txt
├── .env.example
├── nginx/
│   └── nginx.conf              # Artifact HTTP server config
├── dnsmasq/
│   ├── Dockerfile
│   └── entrypoint.sh           # Auto-generates dnsmasq.conf from env
└── app/
    ├── main.py                 # FastAPI app + startup logic
    ├── config.py               # Settings (pydantic-settings)
    ├── models.py               # ORM + Pydantic schemas
    ├── database.py             # Async SQLite
    ├── routers/
    │   ├── releases.py         # GitHub API proxy
    │   ├── configuration.py    # Boot config CRUD
    │   ├── artifacts.py        # Download mgmt + SSE progress
    │   ├── ipxe.py             # iPXE script serving
    │   └── admin.py            # Shutdown endpoint (POST /api/admin/shutdown)
    ├── services/
    │   ├── github_client.py    # GitHub releases API client
    │   ├── artifact_manager.py # Download, extract, grub.cfg patch
    │   ├── tftp_server.py      # Embedded tftpy TFTP server
    │   └── ipxe_generator.py   # iPXE script generation (grub-chain + direct)
    ├── templates/
    │   ├── boot_grub_chain.ipxe.j2   # v12+ UEFI grub-chain boot script
    │   ├── boot_direct.ipxe.j2       # pre-v12 direct kernel boot script
    │   └── menu.ipxe.j2              # Multi-config selection menu
    └── static/
        ├── index.html              # Single-page wizard UI
        ├── css/
        │   └── style.css           # ZEDEDA design system (2026 glassmorphism)
        └── js/
            └── app.js              # Wizard logic, API calls, SSE progress
```

---

## License

Apache 2.0 — see LICENSE file.

EVE-OS is a [LF Edge](https://lfedge.org/) project, licensed separately under Apache 2.0.
