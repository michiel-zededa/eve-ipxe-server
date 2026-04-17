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

  help|--help|-h)
    echo "Usage: $0 {start|stop|restart|status|logs [service]|build}"
    echo ""
    echo "  start     Start all containers (detached)"
    echo "  stop      Stop and remove all containers"
    echo "  restart   Restart all containers"
    echo "  status    Show container status and health"
    echo "  logs      Tail logs (./server.sh logs webui)"
    echo "  build     Rebuild container images"
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
