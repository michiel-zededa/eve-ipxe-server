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
  # Linux / macOS with iproute2
  if command -v ip &>/dev/null; then
    local ip
    ip=$(ip -4 route get 1.1.1.1 2>/dev/null \
         | awk '/src/{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')
    [[ -n "$ip" ]] && echo "$ip" && return
  fi
  # macOS: route + ipconfig
  if command -v route &>/dev/null && command -v ipconfig &>/dev/null; then
    local iface ip
    iface=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')
    if [[ -n "$iface" ]]; then
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
      [[ -n "$ip" ]] && echo "$ip" && return
    fi
  fi
  # Last resort: hostname -I (Linux)
  if command -v hostname &>/dev/null; then
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [[ -n "$ip" ]] && echo "$ip" && return
  fi
  echo ""
}

# Write SERVER_HOST to .env if it is not already set to a non-empty value
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

  if grep -q "^SERVER_HOST=" "$env_file" 2>/dev/null; then
    # Replace the existing (empty) SERVER_HOST= line
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^SERVER_HOST=.*|SERVER_HOST=${detected}|" "$env_file"
    else
      sed -i "s|^SERVER_HOST=.*|SERVER_HOST=${detected}|" "$env_file"
    fi
  else
    echo "SERVER_HOST=${detected}" >> "$env_file"
  fi
  echo "Written SERVER_HOST=${detected} to .env"
  export SERVER_HOST="${detected}"
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
