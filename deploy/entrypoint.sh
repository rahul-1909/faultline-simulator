#!/bin/sh
set -e

echo "========================================================="
echo "  FAULTLINE: Unified Distributed Systems Simulation Suite"
echo "========================================================="

export ORCHESTRATOR_URL="http://127.0.0.1:${PORT:-8080}"
export ANALYTICS_URL="http://127.0.0.1:8000"

# Start Python FastAPI Analytics Engine in background on localhost:8000
echo "[INIT] Starting Python FastAPI Analytics on 127.0.0.1:8000 (Targeting Orchestrator at $ORCHESTRATOR_URL)..."
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
ANALYTICS_PID=$!

# Wait for FastAPI to be ready
for i in $(seq 1 30); do
  if python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" >/dev/null 2>&1; then
    echo "[INIT] FastAPI Analytics is READY."
    break
  fi
  sleep 0.5
done

# Start Go Orchestrator on Render's public $PORT
echo "[INIT] Starting Go Orchestrator on port ${PORT:-8080}..."
exec /app/faultline_orchestrator
