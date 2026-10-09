#!/bin/sh
# Inbound E2E suite (specs/013-inbound-calls-store, research R9) on an isolated Docker stack.
#   sh tests/e2e/run_inbound_e2e.sh            # every scenario
#   sh tests/e2e/run_inbound_e2e.sh E2 E6      # just these
# Repo root is the working directory. The stack (project alfred-e2e, its own names, ports and data under
# tests/e2e/.work/) is always removed at the end; the owner's running Alfred is never touched.
set -e
cd "$(dirname "$0")/../.."

for port in 15000 18080; do
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -v '^alfred-e2e-' | grep -q ":$port->"; then
    echo "port $port is already published by another container - refusing to start the E2E stack"; exit 2
  fi
done

PY=python
command -v python >/dev/null 2>&1 || PY=python3
export E2E_COMPOSE="docker compose -p alfred-e2e --env-file tests/e2e/e2e.env -f docker-compose.yml -f tests/e2e/compose.e2e.yml"
trap '$E2E_COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

$E2E_COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
$E2E_COMPOSE build backend
set +e
$PY tests/e2e/inbound_store_e2e.py "$@"
status=$?
set -e
exit $status
