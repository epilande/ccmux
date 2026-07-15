#!/usr/bin/env bash
# Linux D-Bus e2e for ccmux's DbusNotifier, in an ephemeral Docker container
# (for devs on macOS / non-Linux hosts; CI runs the same harness natively).
#
# Real dbus-daemon + an independent python-dbus notification server + the real
# ccmux client (repo mounted read-only). No host state is mutated. The pulled
# image (oven/bun:1-debian, ~550MB) is removable afterward with
# `docker rmi oven/bun:1-debian` or `docker system prune`.
set -euo pipefail

# Repo root, derived from this script's own location (works from any cwd).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"

# Host output dir (bind-mounted to /out); cleaned up on exit.
OUT="$(mktemp -d "${TMPDIR:-/tmp}/ccmux-dbus-e2e.XXXXXX")"
cleanup() { rm -rf "$OUT"; }
trap cleanup EXIT

docker run --rm \
	-v "$REPO":/work:ro \
	-v "$OUT":/out \
	-e CCMUX_DBUS_E2E_OUT=/out \
	oven/bun:1-debian \
	bash -c '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null
    apt-get install -y -qq dbus dbus-x11 python3-dbus python3-gi >/dev/null
    echo "=== deps installed; launching session bus ==="
    dbus-run-session -- bash -c "
      python3 /work/test/linux-dbus-e2e/stub_server.py &
      SERVER_PID=\$!
      for i in \$(seq 1 50); do [ -f /out/server-ready ] && break; sleep 0.1; done
      if [ ! -f /out/server-ready ]; then echo \"stub server failed to start\"; exit 1; fi
      echo \"=== stub notification server ready; running harness ===\"
      bun /work/test/linux-dbus-e2e/harness.ts
      RC=\$?
      kill \$SERVER_PID 2>/dev/null || true
      exit \$RC
    "
  '

# Fail the script if the harness did not pass every assertion.
if [ "$(jq -r '.allPass' "$OUT/RESULT.json" 2>/dev/null)" != "true" ]; then
	echo "D-Bus e2e FAILED (see output above)"
	exit 1
fi
