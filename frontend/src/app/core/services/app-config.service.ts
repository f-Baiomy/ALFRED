import { Injectable } from '@angular/core';

declare global {
  interface Window {
    BACKEND_URL?: string;
  }
}

/**
 * Reads a build/deploy-time override of the backend URL (`window.BACKEND_URL`, never actually set
 * anywhere today - nothing injects it). Without an override, the backend host is derived from the
 * page's own hostname rather than hardcoded to "localhost" - "localhost" in a browser always means
 * the viewer's own machine, not whatever host actually served the page, so a dashboard opened from
 * a different machine than the one it's deployed on would otherwise silently talk to a backend on
 * the viewer's machine (if one happens to be running there) instead of the real one - confirmed
 * live: viewing the dashboard at 192.168.1.210:3000 from a dev machine that still had a local
 * backend on port 5000 showed that machine's calls, not the server's. docker-compose.yml always
 * publishes the backend on host port 5000, so this only needs the hostname to match.
 */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  readonly backendUrl: string = window.BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:5000`;
}
