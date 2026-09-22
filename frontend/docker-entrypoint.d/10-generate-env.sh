#!/bin/sh
set -eu

# Overwrites the checked-in placeholder public/env.js (copied verbatim into the image at
# /usr/share/nginx/html/env.js by the build stage). The browser now always talks to the backend
# on the SAME origin it loaded the page from (empty string - AppConfigService's own fallback
# already derives protocol+host the same way when this is unset). That origin is app-gateway's,
# not this container's own: app-gateway (docker-compose.yml) is the one public entrypoint,
# reverse-proxying both `/` to this frontend and every backend path prefix to backend:5000 -
# see gateway/nginx.conf. Same-origin is what lets a single Cloudflare Tunnel URL (or any other
# single host:port) serve the whole app: no second backend URL, no localhost, no CORS, since
# REST calls and the WebSocket pushes all resolve relative to wherever the page itself was
# loaded from, whatever that host/port/tunnel happens to be for a given deployment.
cat > /usr/share/nginx/html/env.js <<'EOF'
window.BACKEND_URL = window.location.origin;
EOF
