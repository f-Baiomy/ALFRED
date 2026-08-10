#!/bin/sh
set -eu

# Overwrites the checked-in placeholder public/env.js (copied verbatim into the image at
# /usr/share/nginx/html/env.js by the build stage) with this deployment's real backend port -
# BACKEND_PORT comes from docker-compose.yml, which also uses it for the backend service's own
# host port mapping, so both stay in sync from one place. Lets a server whose port 5000 is
# already taken by something else (confirmed live: gunicorn on stg-app-210) just set
# BACKEND_PORT in a .env file next to docker-compose.yml, with zero code changes.
: "${BACKEND_PORT:=5000}"

cat > /usr/share/nginx/html/env.js <<EOF
window.BACKEND_URL = window.location.protocol + '//' + window.location.hostname + ':${BACKEND_PORT}';
EOF
