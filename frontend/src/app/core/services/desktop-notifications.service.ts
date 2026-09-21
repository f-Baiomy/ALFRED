import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'alfred-desktop-notifications';

/**
 * OS-level "toast" notifications via the browser's `Notification` API - not a custom in-page
 * toast, the real thing the operating system shows even when Alfred's tab isn't focused, since the
 * whole point is being told a caller is being held open while you're looking at something else.
 *
 * Persisted in localStorage the same way ThemeService is - this app has no login, so "the user's
 * preference" really means "this browser's preference."
 *
 * The stored preference and the browser's actual permission are two different things that can
 * drift apart (a user can revoke notification permission for this site from their OS/browser
 * settings at any time, outside the app entirely), so `enabled()` is never just the stored flag -
 * it is the flag AND the browser still actually granting it. Turning it back on then re-asks
 * rather than trusting a permission that may no longer be there.
 */
@Injectable({ providedIn: 'root' })
export class DesktopNotificationsService {
  /** False in a browser (or an embedded webview) with no Notification API at all. */
  readonly supported = typeof Notification !== 'undefined';

  private readonly permissionState = signal<NotificationPermission>(
    this.supported ? Notification.permission : 'denied'
  );
  readonly permission = this.permissionState.asReadonly();

  private readonly wantedState = signal(this.supported && localStorage.getItem(STORAGE_KEY) === 'true');

  /** What actually happens: the user asked for this AND the browser is still actually allowing it. */
  readonly enabled = signal(this.wantedState() && this.permissionState() === 'granted');

  constructor() {
    this.enabled.set(this.wantedState() && this.permissionState() === 'granted');
  }

  /**
   * Turns notifications on, asking the browser for permission first if it hasn't already answered.
   * A user who already denied permission has to change that in their browser's own site settings -
   * asking again just re-resolves 'denied' with no prompt, so this reports that rather than
   * pretending the click did something.
   */
  async enable(): Promise<void> {
    if (!this.supported) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      // Only ever called from a click handler (the toggle button), which is what lets this
      // actually prompt - most browsers silently refuse to ask outside a user gesture.
      permission = await Notification.requestPermission();
    }
    this.permissionState.set(permission);
    this.wantedState.set(true);
    localStorage.setItem(STORAGE_KEY, 'true');
    this.enabled.set(permission === 'granted');
  }

  disable(): void {
    this.wantedState.set(false);
    localStorage.setItem(STORAGE_KEY, 'false');
    this.enabled.set(false);
  }

  toggle(): void {
    if (this.enabled()) {
      this.disable();
    } else {
      void this.enable();
    }
  }

  /**
   * No-ops quietly when unsupported/disabled/not granted - callers never need to check first.
   *
   * Reads `enabled()` alone rather than also re-checking the live `Notification.permission` a
   * second time: `enable()` already folds a fresh permission result into `enabled()` the moment
   * it resolves, so re-reading the browser's own copy here would just be trusting the same fact
   * twice through two different paths that could, in principle, disagree.
   */
  notify(title: string, options?: NotificationOptions): void {
    if (!this.supported || !this.enabled()) return;
    new Notification(title, options);
  }
}
