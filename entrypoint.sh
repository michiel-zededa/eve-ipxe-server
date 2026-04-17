#!/bin/sh
exec python -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8080 \
    --log-level "${LOG_LEVEL:-info}" \
    --no-access-log
