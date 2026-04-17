FROM python:3.12-slim AS base

LABEL org.opencontainers.image.title="EVE-OS iPXE Boot Server"
LABEL org.opencontainers.image.description="Web-based iPXE network boot server for EVE-OS deployment"
LABEL org.opencontainers.image.vendor="ZEDEDA"

# ── System dependencies ────────────────────────────────────────────────────────
# xorriso / isoinfo: extract kernel/initrd from installer ISOs
# tar: extract installer-net tarballs
# curl: health-check + iPXE binary bootstrap
# iproute2: get local IP for SERVER_HOST auto-detection
RUN apt-get update && apt-get install -y --no-install-recommends \
        xorriso \
        genisoimage \
        tar \
        curl \
        iproute2 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Python dependencies ────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ── Application source ─────────────────────────────────────────────────────────
COPY app/ ./app/

# ── Runtime directories (overridden by volume mounts in compose) ───────────────
RUN mkdir -p /data/artifacts /data/config /data/tftp \
 && chmod 755 /data/artifacts /data/config /data/tftp

# ── Non-root user ──────────────────────────────────────────────────────────────
RUN useradd -r -u 1001 -d /app -s /sbin/nologin appuser \
 && chown -R appuser:appuser /app /data

USER appuser

EXPOSE 8080 6969/udp

# Uvicorn with a single worker is correct here: the TFTP server thread and
# in-memory download-progress state must be co-located in one process.
# Shell form so ${LOG_LEVEL} env var expansion works at runtime.
CMD python -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8080 \
    --log-level ${LOG_LEVEL:-info} \
    --no-access-log
