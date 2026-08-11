import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallCardComponent } from './call-card.component';
import { CallRecord } from '../../core/models/call.model';
import { CallsStateService } from '../../core/state/calls-state.service';
import { BULK_SELECTION_STATE, CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';

function makeCall(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1',
    original_url: 'https://example.com-proxy/api/x',
    url: 'https://example.com/api/x',
    method: 'GET',
    timestamp: '2026-01-01T00:00:00.000000+00:00',
    duration_ms: 100,
    response: { status: 200 },
    ...overrides,
  };
}

describe('CallCardComponent', () => {
  let httpMock: HttpTestingController;
  /** Captures every IntersectionObserver callback CallCardComponent registers, in creation order, so a test can simulate "this card scrolled into view" without a real layout/viewport. */
  let intersectionCallbacks: IntersectionObserverCallback[] = [];
  let realIntersectionObserver: typeof IntersectionObserver;

  beforeEach(async () => {
    intersectionCallbacks = [];
    realIntersectionObserver = window.IntersectionObserver;
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };

    await TestBed.configureTestingModule({
      imports: [CallCardComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: CALL_SELECTION_STATE, useExisting: CallsStateService },
        { provide: BULK_SELECTION_STATE, useExisting: CallsStateService },
        { provide: CALL_LIST_CONTROLS_STATE, useExisting: CallsStateService },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    window.IntersectionObserver = realIntersectionObserver;
  });

  /** Simulates the most-recently-created card's host element scrolling into view. */
  function simulateIntersection(): void {
    const callback = intersectionCallbacks[intersectionCallbacks.length - 1];
    callback([{ isIntersecting: true } as IntersectionObserverEntry], null as unknown as IntersectionObserver);
  }

  afterEach(() => {
    // The initial GET /calls fetch (from CallsStateService's constructor) is irrelevant to these
    // tests - flush it away rather than asserting on it.
    httpMock.match(() => true).forEach((req) => req.flush({ calls: [], total: 0 }));
    httpMock.verify();
  });

  function createCard(call: CallRecord = makeCall()) {
    const fixture = TestBed.createComponent(CallCardComponent);
    fixture.componentRef.setInput('call', call);
    fixture.detectChanges();
    return fixture;
  }

  it('starts collapsed - no request/response fetch, just the expand prompt', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('.expand-toggle')).toBeTruthy();
    expect(host.querySelector('.panels')).toBeFalsy();
    httpMock.expectNone((req) => req.url.includes('/detail'));
  });

  it('fetches detail only once the expand button is clicked', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelector('.expand-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.includes('/calls/call-1/detail'));
    req.flush({ request: { headers: { Accept: 'application/json' }, body: 'req-body' }, response: { status: 200, headers: {}, body: 'resp-body' } });
    fixture.detectChanges();

    expect(host.querySelector('.expand-toggle')).toBeFalsy();
    expect(host.textContent).toContain('req-body');
    expect(host.textContent).toContain('resp-body');
  });

  it('does not re-fetch on a second card for the same call id - shares the cache', () => {
    const first = createCard();
    (first.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.expand-toggle')!.click();
    first.detectChanges();
    httpMock.expectOne((r) => r.url.includes('/calls/call-1/detail')).flush({
      request: { headers: {}, body: 'req-body' },
      response: { status: 200, headers: {}, body: 'resp-body' },
    });
    first.detectChanges();

    // A second card instance for the same call id should find it already cached.
    const second = createCard();
    const secondHost: HTMLElement = second.nativeElement;
    (secondHost.querySelector('.expand-toggle') as HTMLButtonElement).click();
    second.detectChanges();

    httpMock.expectNone((r) => r.url.includes('/calls/call-1/detail'));
    expect(secondHost.textContent).toContain('req-body');
  });

  it('does not fetch detail just because the card scrolls into view while still collapsed', () => {
    // Regression test: a card becoming visible must never by itself promote it out of
    // 'collapsed' - only an explicit expand (individual click or bulk "Expand all") does that.
    // Confirmed live: before this was fixed, every visible card silently fetched its detail on
    // page load with no click at all, since the visibility check alone was enough to pass.
    createCard();

    simulateIntersection();

    httpMock.expectNone((req) => req.url.includes('/detail'));
  });

  it('fetches immediately on click even if the intersection callback has not fired yet', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelector('.expand-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url.includes('/calls/call-1/detail')).flush({
      request: { headers: {}, body: 'req-body' },
      response: { status: 200, headers: {}, body: 'resp-body' },
    });
  });

  it('shows a retry option when the detail fetch fails', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelector('.expand-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    httpMock.expectOne((r) => r.url.includes('/calls/call-1/detail')).flush('error', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(host.querySelector('.error-banner')).toBeTruthy();
  });
});
