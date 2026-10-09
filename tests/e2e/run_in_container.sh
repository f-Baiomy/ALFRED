#!/bin/sh
# Usage (repo root): docker run --rm --network none -v "$PWD/dist:/dist:ro" -v "$PWD/tests/e2e:/e2e:ro" debian:bookworm-slim sh /e2e/run_in_container.sh
# Inside a clean debian container, no network: install, start, run the E2E script.
set -e
T0=$(date +%s)
sh "$(ls -t /dist/*linux-x64.run | head -1)" --unattended --ui-port 3000 > /tmp/install.log 2>&1 || { cat /tmp/install.log; exit 1; }
tail -5 /tmp/install.log
alfred start
i=0; until /opt/alfred/runtime/python/bin/python3 -c "import urllib.request as u;u.urlopen('http://127.0.0.1:3000/health',timeout=3)" 2>/dev/null; do i=$((i+1)); [ $i -gt 120 ] && { echo "no health"; alfred logs backend | tail -30; exit 1; }; sleep 1; done
echo "TIME install_to_healthy_s $(( $(date +%s) - T0 ))"
echo "--- config CLI"
alfred config get ALFRED_UI_PORT
alfred config set INTERNAL_CALLS_RETENTION_ROWS 2000 || true
alfred config history | head -5
echo "--- e2e"
/opt/alfred/runtime/python/bin/python3 /e2e/native_install_e2e.py
echo "--- restart and update (terminal and web UI)"
/opt/alfred/runtime/python/bin/python3 /e2e/restart_update_e2e.py --home /opt/alfred
