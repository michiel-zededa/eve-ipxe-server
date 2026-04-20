#!/usr/bin/env bash
# server.sh — manage the EVE-OS iPXE Boot Server stack
#
# Usage:
#   ./server.sh start           Start all containers (detached)
#   ./server.sh stop            Stop and remove all containers
#   ./server.sh restart         Restart all containers
#   ./server.sh status          Show container status and health
#   ./server.sh logs [service]  Tail logs (optionally for one service)
#   ./server.sh build           Rebuild container images
#   ./server.sh clean           Stop containers and delete ALL persistent data (volumes)
#
# The dnsmasq DHCP service is optional and not started by default.
# To include it: PROFILES=dnsmasq ./server.sh start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

# Optional compose profiles (e.g. "dnsmasq")
PROFILES="${PROFILES:-}"

# Build the base compose command
_compose() {
  local cmd="docker compose -f ${COMPOSE_FILE}"
  if [[ -n "${PROFILES}" ]]; then
    cmd="${cmd} --profile ${PROFILES}"
  fi
  ${cmd} "$@"
}

# Detect the host's outbound LAN IP (runs on the host, not inside Docker)
_detect_host_ip() {
  if command -v ip &>/dev/null; then
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null \
         | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
    [[ -n "$ip" ]] && echo "$ip" && return
  fi
  if command -v route &>/dev/null && command -v ipconfig &>/dev/null; then
    local iface ip
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    if [[ -n "$iface" ]]; then
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
      [[ -n "$ip" ]] && echo "$ip" && return
    fi
  fi
  if command -v hostname &>/dev/null; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ -n "$ip" ]] && echo "$ip" && return
  fi
  echo ""
}

# Detect the host's default gateway and the CIDR prefix of the outbound interface.
# Outputs two lines: GATEWAY=<ip>  PREFIX_LENGTH=<n>
_detect_network_info() {
  local server_ip="${1:-}"
  local gateway="" prefix_length="" iface=""

  if command -v ip &>/dev/null; then
    # Linux
    iface=$(ip -4 route get 1.1.1.1 2>/dev/null \
            | awk '/dev/{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1);exit}}')
    gateway=$(ip route show default 2>/dev/null | awk 'NR==1{print $3}')
    if [[ -n "$iface" && -n "$server_ip" ]]; then
      prefix_length=$(ip -4 addr show dev "$iface" 2>/dev/null \
        | awk -v ip="$server_ip" '/inet /{split($2,a,"/"); if(a[1]==ip) print a[2]}')
    fi
  elif command -v route &>/dev/null; then
    # macOS
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    gateway=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
    if [[ -n "$iface" && -n "$server_ip" ]]; then
      local nm_hex
      nm_hex=$(ifconfig "$iface" 2>/dev/null \
        | awk -v ip="$server_ip" '/inet /{if($2==ip) print $4}' | head -1)
      if [[ -n "$nm_hex" ]] && command -v python3 &>/dev/null; then
        prefix_length=$(python3 -c \
          "n=int('$nm_hex',16)&0xffffffff; print(bin(n).count('1'))" 2>/dev/null)
      fi
    fi
  fi

  echo "GATEWAY=${gateway:-}"
  echo "PREFIX_LENGTH=${prefix_length:-24}"
}

# Write SERVER_HOST, GATEWAY, PREFIX_LENGTH to .env if not already set.
_ensure_server_host() {
  local env_file="${SCRIPT_DIR}/.env"

  # Respect an explicit value already in the environment or .env
  local current=""
  if [[ -f "$env_file" ]]; then
    current=$(grep "^SERVER_HOST=" "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]"'"'" || true)
  fi
  [[ -z "$current" ]] && current="${SERVER_HOST:-}"
  if [[ -n "$current" ]]; then
    echo "Server IP: ${current} (from .env / environment)"
    # Still update gateway/prefix even if SERVER_HOST was already set
    _write_network_info "$current" "$env_file"
    return
  fi

  local detected
  detected=$(_detect_host_ip)
  if [[ -z "$detected" ]]; then
    echo "Warning: could not auto-detect host IP. Set SERVER_HOST in .env manually."
    return
  fi

  echo "Auto-detected host IP: ${detected}"

  if [[ ! -f "$env_file" ]]; then
    cp "${SCRIPT_DIR}/.env.example" "$env_file" 2>/dev/null || touch "$env_file"
  fi

  _upsert_env "SERVER_HOST" "${detected}" "$env_file"
  echo "Written SERVER_HOST=${detected} to .env"
  export SERVER_HOST="${detected}"

  _write_network_info "${detected}" "$env_file"
}

# Write GATEWAY and PREFIX_LENGTH to the env file based on detected network info.
_write_network_info() {
  local server_ip="${1}" env_file="${2}"
  local net_info gateway prefix_length

  net_info=$(_detect_network_info "$server_ip")
  gateway=$(echo "$net_info" | awk -F= '/^GATEWAY=/{print $2}')
  prefix_length=$(echo "$net_info" | awk -F= '/^PREFIX_LENGTH=/{print $2}')

  [[ -n "$gateway" ]]       && _upsert_env "GATEWAY"       "${gateway}"       "$env_file"
  [[ -n "$prefix_length" ]] && _upsert_env "PREFIX_LENGTH" "${prefix_length}" "$env_file"

  [[ -n "$gateway" ]]       && echo "Detected gateway: ${gateway}"
  [[ -n "$prefix_length" ]] && echo "Detected subnet prefix: /${prefix_length}"
}

# Insert or replace a KEY=VALUE line in an env file.
_upsert_env() {
  local key="${1}" value="${2}" file="${3}"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
    else
      sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    fi
  else
    echo "${key}=${value}" >> "$file"
  fi
}

_check_docker() {
  if ! command -v docker &>/dev/null; then
    echo "Error: docker is not installed or not in PATH." >&2
    exit 1
  fi
  if ! docker info &>/dev/null; then
    echo "Error: Docker daemon is not running (or permission denied)." >&2
    exit 1
  fi
}

_health() {
  local host="${SERVER_HOST:-localhost}"
  local webui_port="${WEBUI_PORT:-8080}"
  local http_port="${HTTP_PORT:-8081}"

  echo ""
  echo "── Health ──────────────────────────────────────────"
  if curl -fs "http://${host}:${webui_port}/health" >/dev/null 2>&1; then
    echo "  WebUI  ✓  http://${host}:${webui_port}"
  else
    echo "  WebUI  ✗  not responding on port ${webui_port}"
  fi
  if curl -fs "http://${host}:${http_port}/health" >/dev/null 2>&1; then
    echo "  Nginx  ✓  http://${host}:${http_port}"
  else
    echo "  Nginx  ✗  not responding on port ${http_port}"
  fi
  echo ""
}

CMD="${1:-help}"
shift || true

case "${CMD}" in
  start)
    _check_docker
    _ensure_server_host
    echo "Starting EVE-OS iPXE Boot Server…"
    _compose up -d "$@"
    echo ""
    echo "Web UI → http://${SERVER_HOST:-localhost}:${WEBUI_PORT:-8080}"
    echo "API    → http://${SERVER_HOST:-localhost}:${WEBUI_PORT:-8080}/api/docs"
    ;;

  stop)
    _check_docker
    echo "Stopping EVE-OS iPXE Boot Server…"
    _compose down "$@"
    echo "All containers stopped."
    ;;

  restart)
    _check_docker
    echo "Restarting EVE-OS iPXE Boot Server…"
    _compose restart "$@"
    _health
    ;;

  status)
    _check_docker
    echo "── Containers ──────────────────────────────────────"
    _compose ps
    _health
    ;;

  logs)
    _check_docker
    _compose logs -f --tail=100 "$@"
    ;;

  build)
    _check_docker
    echo "Rebuilding images…"
    _compose build "$@"
    echo "Build complete. Run './server.sh start' to apply."
    ;;

  clean)
    _check_docker
    echo "WARNING: This will stop all containers and permanently delete all"
    echo "         persistent data (downloaded artifacts, configs, TFTP files)."
    read -r -p "Are you sure? [y/N] " confirm
    if [[ "${confirm}" =~ ^[Yy]$ ]]; then
      echo "Stopping containers and removing volumes…"
      _compose down -v
      echo "All data wiped. Run './server.sh start' for a clean slate."
    else
      echo "Aborted."
    fi
    ;;

  help|--help|-h)
    echo "Usage: $0 {start|stop|restart|status|logs [service]|build|clean}"
    echo ""
    echo "  start     Start all containers (detached)"
    echo "  stop      Stop and remove all containers"
    echo "  restart   Restart all containers"
    echo "  status    Show container status and health"
    echo "  logs      Tail logs (./server.sh logs webui)"
    echo "  build     Rebuild container images"
    echo "  clean     Stop containers and wipe ALL persistent data (volumes)"
    echo ""
    echo "Environment variables:"
    echo "  PROFILES=dnsmasq    Also start the optional DHCP service"
    echo "  SERVER_HOST         Override the server IP for status output"
    echo "  WEBUI_PORT          Web UI port (default 8080)"
    echo "  HTTP_PORT           Nginx artifact port (default 8081)"
    ;;

  *)
    echo "Unknown command: ${CMD}" >&2
    echo "Run '$0 help' for usage." >&2
    exit 1
    ;;
esac
