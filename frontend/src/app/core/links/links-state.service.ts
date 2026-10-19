import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Observable, auditTime, Subject, tap } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LinksApiService } from './links-api.service';
import { LinksSocketService } from './links-socket.service';
import { AlfredSelf, LinkInfo, LinkProblem, LinkRequest, Offer, Pairing, Presence, SendRequest, Stream } from './links.models';
import { originOf, setKnownSlugs } from './remote-ref';

/** A request the owner could not take now (offline): kept in this browser only and sent when the owner is back (D14). */
export interface LinkDraft {
  readonly id: string;
  readonly request: SendRequest;
  readonly createdAt: string;
  readonly lastError: string | null;
}

const DRAFTS_KEY = 'alfred.links.drafts';

function readDrafts(): LinkDraft[] {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    const v = raw ? (JSON.parse(raw) as LinkDraft[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function writeDrafts(drafts: readonly LinkDraft[]): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // a private window keeps nothing: the drafts live as long as this page
  }
}

export function problemOf(e: unknown): LinkProblem {
  if (e instanceof HttpErrorResponse) {
    const b = e.error as Partial<LinkProblem> | null;
    if (b && typeof b === 'object' && b.error) return { error: b.error, message: b.message ?? '', slug: b.slug };
    if (e.status === 0) return { error: 'OFFLINE', message: 'This Alfred is not answering' };
    return { error: String(e.status), message: e.message };
  }
  // already a problem (LinksStateService.send passes them on as they are)
  if (e && typeof e === 'object' && 'error' in e && 'message' in e) return e as LinkProblem;
  return { error: 'FAILED', message: e instanceof Error ? e.message : String(e) };
}

/**
 * Links, streams and requests for every page (specs/035): fetched once, then again on each /ws/links signal - no
 * polling. The tab title carries ⇄n while requests wait for an answer here (D11). Drafts kept while an owner was offline
 * go out when it comes back (D14).
 */
@Injectable({ providedIn: 'root' })
export class LinksStateService {
  private readonly api = inject(LinksApiService);
  readonly socket = inject(LinksSocketService);
  private readonly refresh$ = new Subject<'links' | 'streams' | 'requests' | 'offers' | 'pairings' | 'presence' | 'self' | 'all'>();

  readonly self = signal<AlfredSelf | null>(null);
  readonly links = signal<readonly LinkInfo[]>([]);
  readonly streams = signal<readonly Stream[]>([]);
  readonly requests = signal<readonly LinkRequest[]>([]);
  readonly offers = signal<readonly Offer[]>([]);
  readonly pairings = signal<readonly Pairing[]>([]);
  readonly presence = signal<readonly Presence[]>([]);
  readonly drafts = signal<readonly LinkDraft[]>(readDrafts());
  /** An auto-accepted request, shown with Undo for a while (D12). */
  readonly autoAccepted = signal<readonly LinkRequest[]>([]);
  readonly loaded = signal(false);
  readonly unavailable = signal(false);

  readonly slugs = computed(() => new Set(this.links().map((l) => l.slug)));
  readonly linkBySlug = computed(() => new Map(this.links().map((l) => [l.slug, l])));
  readonly linkById = computed(() => new Map(this.links().map((l) => [l.id, l])));
  readonly given = computed(() => this.streams().filter((s) => !s.mine));
  readonly offered = computed(() => this.streams().filter((s) => s.mine));
  readonly waiting = computed(() => this.requests().filter((r) => r.incoming && r.state === 'WAITING'));
  readonly mineWaiting = computed(() => this.requests().filter((r) => !r.incoming && r.state === 'WAITING'));

  private readonly baseTitle = typeof document === 'undefined' ? 'Alfred' : document.title.replace(/^⇄\d+ /, '');
  private started = false;

  constructor() {
    const destroyRef = inject(DestroyRef);
    this.refresh$.pipe(auditTime(150), takeUntilDestroyed(destroyRef)).subscribe((what) => this.load(what));
    this.socket.events$.pipe(takeUntilDestroyed(destroyRef)).subscribe((e) => {
      switch (e.type) {
        case 'links-changed':
          this.refresh$.next('links');
          if ((e.data as { online?: boolean } | undefined)?.online) this.flushDrafts();
          break;
        case 'streams-changed': this.refresh$.next('streams'); break;
        case 'requests-changed': this.onRequestChanged(e.data as { id?: string; state?: string; incoming?: boolean } | undefined); break;
        case 'offers-changed': this.refresh$.next('offers'); break;
        case 'pairings-changed': this.refresh$.next('pairings'); this.refresh$.next('links'); break;
        case 'presence-changed': this.refresh$.next('presence'); break;
        case 'self-changed': this.refresh$.next('self'); break;
        case 'signal':
          if (e.channel === 'resync') this.flushDrafts(e.slug);
          break;
        default: break;
      }
    });
    this.socket.reconnected$.pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.refresh$.next('all'));
    effect(() => {
      const n = this.waiting().length;
      if (typeof document !== 'undefined') document.title = n > 0 ? `⇄${n} ${this.baseTitle}` : this.baseTitle;
    });
  }

  /** Loads everything once (pages call this; repeated calls are free). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.load('all');
  }

  reload(): void {
    this.load('all');
  }

  private load(what: string): void {
    const all = what === 'all';
    if (all || what === 'self') this.api.self().subscribe({ next: (s) => this.self.set(s), error: () => undefined });
    if (all || what === 'links') {
      this.api.links().subscribe({
        next: (l) => {
          this.links.set(l);
          setKnownSlugs(new Set(l.map((x) => x.slug)));
          this.loaded.set(true);
          this.unavailable.set(false);
        },
        error: (e) => {
          this.unavailable.set(true);
          // refused for good (through the tunnel, or a backend without links): stop knocking; a backend that is only
          // down for a moment (status 0, 502) is tried again by the socket
          if (e instanceof HttpErrorResponse && (e.status === 403 || e.status === 404)) this.socket.stop();
        },
      });
    }
    if (all || what === 'streams') this.api.streams({ ended: true }).subscribe({ next: (s) => this.streams.set(s), error: () => undefined });
    if (all || what === 'requests') this.api.requests({ limit: 200 }).subscribe({ next: (r) => this.requests.set(r), error: () => undefined });
    if (all || what === 'offers') this.api.offers().subscribe({ next: (o) => this.offers.set(o), error: () => undefined });
    if (all || what === 'pairings') this.api.pairings().subscribe({ next: (p) => this.pairings.set(p), error: () => undefined });
    if (all || what === 'presence') this.api.presence().subscribe({ next: (p) => this.presence.set(p), error: () => undefined });
  }

  private onRequestChanged(data: { id?: string; state?: string; incoming?: boolean } | undefined): void {
    this.api.requests({ limit: 200 }).subscribe({
      next: (r) => {
        this.requests.set(r);
        const changed = data?.id ? r.find((x) => x.id === data.id) : undefined;
        if (changed && changed.incoming && changed.state === 'ACCEPTED' && changed.auto) {
          this.autoAccepted.update((list) => [changed, ...list.filter((x) => x.id !== changed.id)].slice(0, 5));
        }
      },
      error: () => undefined,
    });
  }

  dismissAuto(id: string): void {
    this.autoAccepted.update((list) => list.filter((x) => x.id !== id));
  }

  // ---------------------------------------------------------------------------------------------- what pages ask

  linkOf(slug: string | null | undefined): LinkInfo | undefined {
    return slug ? this.linkBySlug().get(slug) : undefined;
  }

  /** The link a ref is reached through, if the ref names another Alfred's thing. */
  originLink(ref: string | null | undefined): LinkInfo | undefined {
    const slug = originOf(ref, this.slugs());
    return slug ? this.linkBySlug().get(slug) : undefined;
  }

  nameOf(slug: string | null | undefined): string {
    return this.linkOf(slug)?.name ?? slug ?? '';
  }

  /** The stream this Alfred was given for a target of a link, active first. */
  givenStream(linkId: string, kind: 'CYCLE' | 'BOARD', target: string): Stream | undefined {
    const list = this.given().filter((s) => s.linkId === linkId && s.kind === kind && s.target === target);
    return list.find((s) => !s.endedAt) ?? list[0];
  }

  streamsOf(kind: 'CYCLE' | 'BOARD', target: string): Stream[] {
    return this.offered().filter((s) => s.kind === kind && s.target === target && !s.endedAt);
  }

  // ---------------------------------------------------------------------------------------- requests and drafts

  /**
   * Sends a request to the owner. When the owner is offline the request is kept here as a draft (D14) and goes out when
   * it is back; the observable then completes with null.
   */
  send(r: SendRequest): Observable<LinkRequest | null> {
    return new Observable<LinkRequest | null>((sub) => {
      this.api.send(r).subscribe({
        next: (req) => {
          this.requests.update((list) => [req, ...list.filter((x) => x.id !== req.id)]);
          sub.next(req);
          sub.complete();
        },
        error: (e) => {
          const p = problemOf(e);
          if (p.error === 'OFFLINE' || p.error === 'TIMEOUT' || p.error === '503' || p.error === '502') {
            this.keepDraft(r, p.message);
            sub.next(null);
            sub.complete();
          } else {
            sub.error(p);
          }
        },
      });
    });
  }

  private keepDraft(r: SendRequest, why: string): void {
    const d: LinkDraft = { id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, request: r, createdAt: new Date().toISOString(), lastError: why };
    this.drafts.update((list) => [...list, d]);
    writeDrafts(this.drafts());
  }

  discardDraft(id: string): void {
    this.drafts.update((list) => list.filter((d) => d.id !== id));
    writeDrafts(this.drafts());
  }

  /** Sends the drafts kept for one link (or all) now; one that is refused for good is dropped with its reason kept on screen. */
  flushDrafts(slug?: string): void {
    const pending = this.drafts().filter((d) => !slug || d.request.via === slug);
    for (const d of pending) {
      this.api.send(d.request).subscribe({
        next: (req) => {
          this.discardDraft(d.id);
          this.requests.update((list) => [req, ...list.filter((x) => x.id !== req.id)]);
        },
        error: (e) => {
          const p = problemOf(e);
          if (p.error === 'OFFLINE' || p.error === 'TIMEOUT' || p.error === '503') return; // still away: kept
          this.drafts.update((list) => list.map((x) => (x.id === d.id ? { ...x, lastError: `${p.error}: ${p.message}` } : x)));
          writeDrafts(this.drafts());
        },
      });
    }
  }

  accept(id: string): Observable<LinkRequest> {
    return this.api.accept(id).pipe(tap(() => this.refresh$.next('requests')));
  }

  reject(id: string, note: string | null): Observable<LinkRequest> {
    return this.api.reject(id, note).pipe(tap(() => this.refresh$.next('requests')));
  }

  undo(id: string): Observable<LinkRequest> {
    return this.api.undo(id).pipe(tap(() => {
      this.dismissAuto(id);
      this.refresh$.next('requests');
    }));
  }

  withdraw(id: string): Observable<LinkRequest> {
    return this.api.withdraw(id).pipe(tap(() => this.refresh$.next('requests')));
  }
}
