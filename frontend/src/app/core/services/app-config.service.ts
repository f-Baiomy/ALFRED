import { Injectable } from '@angular/core';

declare global {
  interface Window {
    BACKEND_URL?: string;
  }
}

/**
 * Reads a deploy-time override of the backend URL (`window.BACKEND_URL`) - in the Docker image,
 * `docker-entrypoint.d/10-generate-env.sh` sets this at container start from `BACKEND_PORT`
 * (docker-compose.yml), so a deployment whose default port 5000 is already taken by something
 * else (confirmed live: gunicorn already listening on stg-app-210) just needs a `.env` file, no
 * code change. For local `ng serve` (no Docker involved, so nothing sets window.BACKEND_URL), the
 * fallback derives the backend host from the page's own hostname rather than hardcoding
 * "localhost" - "localhost" in a browser always means the viewer's own machine, not whatever host
 * actually served the page, so a dashboard opened from a different machine than the one it's
 * deployed on would otherwise silently talk to a backend on the viewer's machine (if one happens
 * to be running there) instead of the real one - confirmed live: viewing the dashboard at
 * 192.168.1.210:3000 from a dev machine that still had a local backend on port 5000 showed that
 * machine's calls, not the server's.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  readonly backendUrl: string = window.BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:5000`;
}
