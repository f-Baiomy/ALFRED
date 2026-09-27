import { ApplicationRef, ComponentRef, EnvironmentInjector, Injectable, computed, createComponent, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CallRecord } from '../models/call.model';
import { isPreflight } from '../../shared/utils/call-utils';
import { CallFocusService } from './call-focus.service';

interface DocumentPictureInPicture {
  requestWindow(options?: {
    width?: number;
    height?: number;
    /** Chrome 124+: hides the "back to tab" button in Chrome's bar. */
    disallowReturnToOpener?: boolean;
    /** Chrome 130+: open at the requested size and place, not wherever the last PiP window was left. */
    preferInitialWindowPlacement?: boolean;
  }): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export type CycleWidgetWindowMode = 'pip' | 'popup';

/** One width for both states, so expanding only grows the window downward - a width change re-lays out
 * the whole header mid-resize, which is jarring to watch. */
const WIDGET_WIDTH = 420;
const EXPANDED_SIZE = { width: WIDGET_WIDTH, height: 600 };
/** The controls row (48) plus the status line under it (30) and its divider. */
const COLLAPSED_SIZE = { width: WIDGET_WIDTH, height: 79 };

/**
 * Owns the floating session-cycle widget's window. Two kinds, switched by the widget's pin button:
 *
 * - 'pip' (pinned): a Document Picture-in-Picture window - the only way a web page gets a window
 *   that stays above every other app. Chrome/Edge 116+ only, and it can only be opened from a click.
 * - 'popup' (unpinned, and the only kind where Document PiP is missing, e.g. Firefox/Safari): an
 *   ordinary `window.open` popup that other apps can cover.
 *
 * Either way the widget is the SAME Angular app rendered into another window: createComponent
 * with this app's injector, attached to ApplicationRef so change detection covers it, its host
 * element moved into the other document. So it shares every root service (state, sockets, HTTP)
 * with the tab that opened it, and closes when that tab does.
 *
 * Nothing about the widget's state lives here - CycleWidgetComponent starts and stops
 * CycleWidgetStateService itself - so the main bundle carries only this service and the launcher
 * button, and everything else arrives with the lazily imported component.
 *
 * Styling: the window starts blank, so every stylesheet in this document is cloned into it, and
 * `data-theme` on <html> is mirrored live so a theme change applies to the widget too.
 */
@Injectable({ providedIn: 'root' })
export class CycleWidgetWindowService {
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private readonly router = inject(Router);
  private readonly callFocus = inject(CallFocusService);

  readonly pipSupported = typeof window !== 'undefined' && !!window.documentPictureInPicture;

  readonly isOpen = signal(false);
  readonly mode = signal<CycleWidgetWindowMode | null>(null);
  /** Whether the widget is in the always-on-top window right now. Unpinning lasts only for that window - the launcher always opens pinned. */
  readonly pinned = computed(() => this.mode() === 'pip');
  readonly collapsed = signal(false);
  /**
   * Set when pinning was asked for from the normal window and Chrome refused it. Chrome only lets a
   * PiP window open from a click in the page that owns it (this tab) - a click in the popup doesn't
   * count - so the launcher in this tab turns into "Pin on top" to take that click.
   */
  readonly repinRequested = signal(false);
  /** Whether the widget's selected cycle is recording - reported by the widget, shown as the side tab's dot. */
  readonly recording = signal(false);
  /** A one-line explanation when the window couldn't do what was asked (popup blocked, pinning refused). */
  readonly notice = signal<string | null>(null);

  private win: Window | null = null;
  private ref: ComponentRef<unknown> | null = null;
  private themeObserver: MutationObserver | null = null;
  private readonly onWindowClosed = () => this.teardown(true);

  /**
   * Opens the widget - pinned on top and minimized to the pill - or, when it's already open, brings it
   * forward (or finishes a pending re-pin, see repinRequested). Must run from a click in this tab.
   */
  async open(): Promise<void> {
    if (this.win && !this.win.closed) {
      if (this.repinRequested() && this.mode() === 'popup') {
        await this.openIn('pip');
        return;
      }
      this.win.focus();
      return;
    }
    this.collapsed.set(true);
    if (!this.pipSupported) {
      await this.openIn('popup');
      return;
    }
    // A browser can advertise Document PiP and still refuse it (embedded Chromium, policy) - the
    // widget then opens as a normal window rather than not at all.
    if (!(await this.openIn('pip')) && (await this.openIn('popup'))) {
      this.notice.set("Couldn't keep the widget on top in this browser, so it opened as a normal window.");
    }
  }

  close(): void {
    this.win?.close();
    this.teardown(true);
  }

  /**
   * Moves the widget between the always-on-top PiP window and a normal popup. The new window is
   * opened BEFORE the old one closes, so a browser that refuses the switch leaves the widget
   * where it was rather than gone.
   */
  async setPinned(pinned: boolean): Promise<void> {
    if (!this.pipSupported || !this.win) return;
    const target: CycleWidgetWindowMode = pinned ? 'pip' : 'popup';
    if (this.mode() === target) return;
    if (await this.openIn(target)) return;
    if (pinned) {
      // Refused because the click was in the popup - hand it to the launcher in the Alfred tab.
      this.repinRequested.set(true);
      this.notice.set('Click "Pin on top" in the Alfred tab to pin the widget.');
      window.focus();
    }
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    const size = collapsed ? COLLAPSED_SIZE : EXPANDED_SIZE;
    this.resizeInner(size.width, size.height);
  }

  /**
   * Grows or shrinks the collapsed window to `contentHeight` - the pill plus whatever is open under
   * it (cycle list, new-cycle form). By the difference from the current inner height rather than
   * with resizeTo, which sets the OUTER size and so would have to guess the browser's title bar.
   */
  fitCollapsedHeight(contentHeight: number): void {
    if (this.collapsed()) this.resizeInner(COLLAPSED_SIZE.width, Math.ceil(contentHeight));
  }

  /**
   * Sizes the window's CONTENT area, by the difference from its current inner size. resizeTo sets
   * the OUTER size, which would mean guessing the height of Chrome's own bar - and doing it this way
   * also corrects a window Chrome reopened at whatever size the last one was left at.
   */
  private resizeInner(width: number, height: number): void {
    const target = this.win;
    if (!target) return;
    const dw = Math.round(width - target.innerWidth);
    const dh = Math.round(height - target.innerHeight);
    if (dw === 0 && dh === 0) return;
    try {
      target.resizeBy(dw, dh);
    } catch {
      // Some browsers refuse script resizes - the layout still applies inside whatever room there is.
    }
  }

  /** Brings the Alfred tab forward on this cycle's page, every call listed and this one pointed at. */
  showCallInCycle(cycleId: string, call: CallRecord): void {
    window.focus();
    const inbound = call.source === 'internal';
    this.callFocus.revealIn({
      callId: call.id,
      cycleId,
      direction: inbound ? 'inbound' : 'outbound',
      serviceName: inbound ? (call.service_name ?? 'unknown') : null,
      preflight: isPreflight(call),
    });
  }

  /** Brings the Alfred tab forward on this cycle's page. */
  showInAlfred(cycleId: string): void {
    window.focus();
    void this.router.navigate(['/cycles', cycleId]);
  }

  private async openIn(mode: CycleWidgetWindowMode): Promise<boolean> {
    this.notice.set(null);
    const size = this.collapsed() ? COLLAPSED_SIZE : EXPANDED_SIZE;
    let next: Window | null = null;
    try {
      next =
        mode === 'pip'
          ? await window.documentPictureInPicture!.requestWindow({ ...size, disallowReturnToOpener: true, preferInitialWindowPlacement: true })
          : window.open('', 'alfred-cycle-widget', `popup,width=${size.width},height=${size.height}`);
    } catch (err) {
      console.warn(`Cycle widget: couldn't open the ${mode} window`, err);
      next = null;
    }
    if (!next) {
      this.notice.set(
        mode === 'pip'
          ? 'Your browser only allows pinning from a click in the Alfred tab. Use the widget button there.'
          : 'Your browser blocked the widget window. Allow pop-ups for this site and try again.'
      );
      return false;
    }

    // The old window goes only now that the new one exists - see setPinned.
    this.teardown(false);
    this.repinRequested.set(false);
    this.win = next;
    this.mode.set(mode);
    this.prepareDocument(next);
    await this.mount(next);
    next.addEventListener('pagehide', this.onWindowClosed);
    this.isOpen.set(true);
    return true;
  }

  private prepareDocument(target: Window): void {
    const doc = target.document;
    doc.title = 'Alfred · Session cycles';
    doc.head.replaceChildren();
    doc.body.replaceChildren();
    document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      if (node instanceof HTMLLinkElement) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = node.href;
        doc.head.appendChild(link);
      } else {
        const style = doc.createElement('style');
        style.textContent = node.textContent;
        doc.head.appendChild(style);
      }
    });
    doc.body.classList.add('cw-window');

    const syncTheme = () => {
      const theme = document.documentElement.getAttribute('data-theme');
      if (theme) doc.documentElement.setAttribute('data-theme', theme);
      else doc.documentElement.removeAttribute('data-theme');
    };
    syncTheme();
    this.themeObserver?.disconnect();
    this.themeObserver = new MutationObserver(syncTheme);
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  private async mount(target: Window): Promise<void> {
    // Imported lazily: the widget component injects this service, so a static import would be circular.
    const { CycleWidgetComponent } = await import('../../components/cycle-widget/cycle-widget.component');
    const ref = createComponent(CycleWidgetComponent, { environmentInjector: this.injector });
    this.appRef.attachView(ref.hostView);
    target.document.body.appendChild(ref.location.nativeElement);
    ref.changeDetectorRef.detectChanges();
    this.ref = ref;
  }

  /** `final` = the widget is going away entirely (not just moving to the other kind of window). */
  private teardown(final: boolean): void {
    const old = this.win;
    this.win = null;
    if (old) {
      old.removeEventListener('pagehide', this.onWindowClosed);
      if (!old.closed) old.close();
    }
    if (this.ref) {
      this.appRef.detachView(this.ref.hostView);
      this.ref.destroy();
      this.ref = null;
    }
    if (final) {
      this.themeObserver?.disconnect();
      this.themeObserver = null;
      this.mode.set(null);
      this.isOpen.set(false);
      this.repinRequested.set(false);
      this.recording.set(false);
    }
  }
}

