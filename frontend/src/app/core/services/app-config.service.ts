import { Injectable } from '@angular/core';

declare global {
  interface Window {
    BACKEND_URL?: string;
  }
}

/** Reads a build/deploy-time override of the backend URL, same convention as before (`window.BACKEND_URL`). */
@Injectable({ providedIn: 'root' })
export class AppConfigService {
  readonly backendUrl: string = window.BACKEND_URL || 'http://localhost:5000';
}
