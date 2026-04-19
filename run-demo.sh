#!/usr/bin/env bash
# pinna demo launcher
#
# Usage:
#   sudo ./run-demo.sh              # live mic capture (requires sudo for pyusb)
#   sudo ./run-demo.sh --no-whisper # DOA only, skip transcription
#
# Ctrl-C shuts the server down cleanly.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

VENV_PY="$SCRIPT_DIR/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  echo "ERROR: venv Python not found at $VENV_PY"
  echo "Create it with: python3.12 -m venv .venv && .venv/bin/pip install sounddevice numpy mlx-whisper pyusb websockets"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run-demo.sh must be run with sudo -- pyusb needs root to reach the XVF3800 on macOS."
  echo "       sudo ./run-demo.sh"
  exit 1
fi

# Open the browser after a short delay (background)
(
  sleep 2
  open "http://localhost:8080/"
) &
OPEN_PID=$!

# Trap Ctrl-C to clean up
cleanup() {
  echo ""
  echo "[launcher] shutting down..."
  kill $OPEN_PID 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "[launcher] starting pinna server (live mic)"
echo "[launcher] HTTP:       http://localhost:8080"
echo "[launcher] WebSocket:  ws://localhost:8765"
echo ""

exec "$VENV_PY" "$SCRIPT_DIR/server.py" "$@"
