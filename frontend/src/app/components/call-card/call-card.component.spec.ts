import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallCardComponent } from './call-card.component';
import { CallRecord } from '../../core/models/call.model';
import { CallDepthInfo } from '../../shared/utils/call-tree';
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

  function createCard(call: CallRecord = makeCall(), variant?: 'request' | 'response' | 'full') {
    const fixture = TestBed.createComponent(CallCardComponent);
    fixture.componentRef.setInput('call', call);
    if (variant) fixture.componentRef.setInput('variant', variant);
    fixture.detectChanges();
    return fixture;
  }

  /** Opens one of the four blocks the way a user does - <details> fires `toggle` on open. */
  function openBlock(fixture: ReturnType<typeof createCard>, index: number): void {
    const block = (fixture.nativeElement as HTMLElement).querySelectorAll('details.block')[index] as HTMLDetailsElement;
    block.open = true;
    block.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
  }

  it('lists all four blocks collapsed, fetching none of them', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    const blocks = Array.from(host.querySelectorAll('details.block'));
    expect(blocks.length).toBe(4);
    expect(blocks.every((b) => !(b as HTMLDetailsElement).open)).toBe(true);
    expect(host.textContent).toContain('not loaded');
    httpMock.expectNone((req) => req.url.includes('/detail'));
  });

  it('fetches one block, by name, the first time it is opened', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    openBlock(fixture, 3); // response body

    const req = httpMock.expectOne((r) => r.url.includes('/calls/call-1/detail'));
    expect(req.request.params.get('part')).toBe('response-body');
    req.flush({ response: { status: 200, body: 'resp-body' } });
    fixture.detectChanges();

    expect(host.textContent).toContain('resp-body');
    // Opening one block leaves the other three untouched - that's the whole point.
    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  it('does not refetch a block that is closed and reopened', () => {
    const fixture = createCard();
    openBlock(fixture, 0);
    httpMock.expectOne((r) => r.params.get('part') === 'request-headers').flush({ request: { headers: { accept: 'x' } } });
    fixture.detectChanges();

    const block = (fixture.nativeElement as HTMLElement).querySelector('details.block') as HTMLDetailsElement;
    block.open = false;
    block.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
    block.open = true;
    block.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();

    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  it('re-fetches for a second card of the same call id - detail is never cached client-side', () => {
    const first = createCard();
    openBlock(first, 1);
    httpMock.expectOne((r) => r.params.get('part') === 'request-body').flush({ request: { body: 'req-body' } });
    first.detectChanges();
    expect((first.nativeElement as HTMLElement).textContent).toContain('req-body');

    const second = createCard();
    openBlock(second, 1);
    httpMock.expectOne((r) => r.params.get('part') === 'request-body').flush({ request: { body: 'req-body-2' } });
    second.detectChanges();

    expect((second.nativeElement as HTMLElement).textContent).toContain('req-body-2');
  });

  it('offers a retry on just the block that failed', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    openBlock(fixture, 2);
    httpMock.expectOne((r) => r.params.get('part') === 'response-headers').flush('nope', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    expect(host.textContent).toContain('Failed to load headers');
    (host.querySelector('.error-banner .action-btn') as HTMLButtonElement).click();
    fixture.detectChanges();

    httpMock.expectOne((r) => r.params.get('part') === 'response-headers').flush({ response: { status: 200, headers: { a: 'b' } } });
  });

  it('does not fetch anything just because the card scrolls into view', () => {
    // Regression guard, carried over from when one toggle fetched the whole detail: visibility
    // alone must never fetch. It only decides WHEN an already-requested block actually goes out.
    createCard();

    simulateIntersection();

    httpMock.expectNone((req) => req.url.includes('/detail'));
  });

  it('expands headers only on a bulk expand, and defers them while the card is off-screen', () => {
    const state = TestBed.inject(CallsStateService);
    const fixture = TestBed.createComponent(CallCardComponent);
    fixture.componentRef.setInput('call', makeCall());
    fixture.detectChanges();

    // Two toggles: collapse all, then expand all - the second is the event under test.
    state.toggleExpanded();
    fixture.detectChanges();
    state.toggleExpanded();
    fixture.detectChanges();

    // Nothing yet: this card has never been reported visible, and a bulk expand mustn't fire
    // requests for cards nobody has scrolled to.
    httpMock.expectNone((r) => r.url.includes('/detail'));

    simulateIntersection();
    fixture.detectChanges();

    const requests = httpMock.match((r) => r.url.includes('/detail'));
    // Headers only - expanding every body on a full page would be a burst of large fetches.
    expect(requests.map((r) => r.request.params.get('part')).sort()).toEqual(['request-headers', 'response-headers']);
    requests.forEach((r) => r.flush({ request: { headers: {} }, response: { status: 200, headers: {} } }));
  });

  it('shows the supplier name badge when the summary carries one', () => {
    const fixture = createCard(makeCall({ supplierName: 'FlyNas' }));
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('.supplier-badge')?.textContent).toContain('FlyNas');
  });

  it('renders no supplier badge when the summary has none', () => {
    const fixture = createCard(makeCall({ supplierName: null }));
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('.supplier-badge')).toBeFalsy();
  });

  describe('variant', () => {
  it('shows a plain "Sent" badge, never a status/duration, for a resolved request row', () => {
      const fixture = createCard(makeCall({ response: { status: 500 } }), 'request');
      const host: HTMLElement = fixture.nativeElement;

      expect(host.querySelector('.status-sent')?.textContent).toContain('Sent');
      expect(host.querySelector('.status-5xx')).toBeFalsy();
      expect(host.querySelector('.duration')).toBeFalsy();
    });

    it('shows "In progress" on a request row while the call is unresolved', () => {
      const fixture = createCard(makeCall({ state: 'IN_PROGRESS', response: undefined }), 'request');
      const host: HTMLElement = fixture.nativeElement;

      expect(host.querySelector('.status-pending')?.textContent).toContain('In progress');
    });

    it('never applies error/warning styling to a request row, even for a failed call', () => {
      const fixture = createCard(makeCall({ response: { status: 500 } }), 'request');
      const host: HTMLElement = fixture.nativeElement;

      expect(host.querySelector('.call')?.classList.contains('has-error')).toBe(false);
      expect(host.querySelector('.call')?.classList.contains('has-warning')).toBe(false);
    });

    it('shows the real status code and duration on a response row, exactly like a full row', () => {
      const fixture = createCard(makeCall({ response: { status: 500 }, duration_ms: 42 }), 'response');
      const host: HTMLElement = fixture.nativeElement;

      expect(host.querySelector('.status-5xx')).toBeTruthy();
      expect(host.querySelector('.call')?.classList.contains('has-error')).toBe(true);
      expect(host.querySelector('.duration')?.textContent).toContain('42');
    });

    it('appends " · request" / " · response" to the source label for split rows', () => {
      const requestFixture = createCard(makeCall(), 'request');
      expect((requestFixture.nativeElement as HTMLElement).textContent).toContain('· request');

      const responseFixture = createCard(makeCall(), 'response');
      expect((responseFixture.nativeElement as HTMLElement).textContent).toContain('· response');
    });

    it('lists only the request blocks on a request row, and only the response blocks on a response row', () => {
      const requestRow: HTMLElement = createCard(makeCall(), 'request').nativeElement;
      expect(Array.from(requestRow.querySelectorAll('.panel-title')).map((t) => t.textContent?.trim())).toEqual(['Request']);
      expect(requestRow.querySelectorAll('details.block').length).toBe(2);

      const responseRow: HTMLElement = createCard(makeCall(), 'response').nativeElement;
      expect(Array.from(responseRow.querySelectorAll('.panel-title')).map((t) => t.textContent?.trim())).toEqual(['Response']);
      expect(responseRow.querySelectorAll('details.block').length).toBe(2);
    });

    it("gives a split row's lone panel the card's full width, while a full row keeps the 2-up grid", () => {
      const panelsOf = (variant?: 'request' | 'response' | 'full') =>
        (createCard(makeCall(), variant).nativeElement as HTMLElement).querySelector('.panels') as HTMLElement;

      // Only one panel renders on either half, so the 2-up grid would strand it beside an empty
      // column - .single collapses the grid to one full-width track (see styles.scss's .panels).
      expect(panelsOf('request').classList.contains('single')).toBe(true);
      expect(panelsOf('response').classList.contains('single')).toBe(true);
      // A full row still lists both panels side by side, unchanged.
      expect(panelsOf().classList.contains('single')).toBe(false);
    });

    it("gives a full row's request panel the whole width while the call is still in progress, with no response panel to sit beside", () => {
      const host: HTMLElement = createCard(makeCall({ state: 'IN_PROGRESS', response: undefined })).nativeElement;

      // There is no response to open yet, so no Response panel is listed at all.
      expect(host.querySelector('.panels')?.classList.contains('single')).toBe(true);
      expect(Array.from(host.querySelectorAll('.panel-title')).map((t) => t.textContent?.trim())).toEqual(['Request']);
    });
  });

  describe('depth badge and span bar (flat-depth view)', () => {
    function depthInfo(overrides: Partial<CallDepthInfo> = {}): CallDepthInfo {
      return {
        depth: 1,
        parentLabel: 'Odeysys',
        parentId: 'parent-call',
        childCount: 0,
        descendantCount: 0,
        spanStart: 0.25,
        spanWidth: 0.4,
        offsetMs: 2500,
        rootDurationMs: 10000,
        ambiguous: false,
        ...overrides,
      };
    }

    function createWithDepth(info: CallDepthInfo | null, variant?: 'request' | 'response' | 'full') {
      const fixture = TestBed.createComponent(CallCardComponent);
      fixture.componentRef.setInput('call', makeCall());
      fixture.componentRef.setInput('depth', info);
      if (variant) fixture.componentRef.setInput('variant', variant);
      fixture.detectChanges();
      return fixture;
    }

    it('names the parent on a nested call, and offers it as a button that reveals it', () => {
      const fixture = createWithDepth(depthInfo());
      const badge = (fixture.nativeElement as HTMLElement).querySelector('.depth-badge') as HTMLButtonElement;

      expect(badge.textContent).toContain('L2 · in Odeysys');
      expect(badge.tagName).toBe('BUTTON');

      let revealed: string | undefined;
      fixture.componentInstance.revealParent.subscribe((id: string) => (revealed = id));
      badge.click();
      expect(revealed).toBe('parent-call');
    });

    it('counts what is underneath a root call instead of naming a parent it does not have', () => {
      const fixture = createWithDepth(depthInfo({ depth: 0, parentLabel: null, parentId: null, childCount: 1, descendantCount: 4 }));
      const badge = (fixture.nativeElement as HTMLElement).querySelector('.depth-badge')!;

      expect(badge.textContent).toContain('root · 4 below');
      expect(badge.tagName).not.toBe('BUTTON');
    });

    it('shows no badge at all for a call with no proven relations', () => {
      const isolated = createWithDepth(depthInfo({ depth: 0, parentLabel: null, parentId: null, descendantCount: 0 }));
      expect((isolated.nativeElement as HTMLElement).querySelector('.depth-badge')).toBeNull();

      const noInfo = createWithDepth(null);
      expect((noInfo.nativeElement as HTMLElement).querySelector('.depth-badge')).toBeNull();
    });

    it('flags a call two parents could equally claim as plain text, never a parent link, and gives it no span bar', () => {
      // parentId is deliberately still set here: an ambiguous call is parentless by construction,
      // so this asserts the card refuses to offer a jump target even on contradictory input.
      const fixture = createWithDepth(depthInfo({ ambiguous: true }));
      const host: HTMLElement = fixture.nativeElement;

      expect(host.querySelector('.depth-badge-orphan')?.textContent).toContain('unattributed');
      expect(host.querySelector('.span-bar')).toBeNull();
    });

    it('positions the span bar at the call\'s own slice of its root window', () => {
      const fixture = createWithDepth(depthInfo({ spanStart: 0.25, spanWidth: 0.4 }));
      const fill = (fixture.nativeElement as HTMLElement).querySelector('.span-bar-fill') as HTMLElement;

      // Compared numerically - the browser normalises '25.00%' back to '25%' on the way in.
      expect(parseFloat(fill.style.marginLeft)).toBeCloseTo(25, 5);
      expect(parseFloat(fill.style.width)).toBeCloseTo(40, 5);
    });

    it('keeps a sub-hairline slice visible rather than rendering nothing', () => {
      const fixture = createWithDepth(depthInfo({ spanWidth: 0.0001 }));
      const fill = (fixture.nativeElement as HTMLElement).querySelector('.span-bar-fill') as HTMLElement;

      expect(parseFloat(fill.style.width)).toBeGreaterThan(0.5);
    });

    it('leaves the badge off a response row - the request row opening the pair already carries it', () => {
      const fixture = createWithDepth(depthInfo(), 'response');
      expect((fixture.nativeElement as HTMLElement).querySelector('.depth-badge')).toBeNull();
    });

    it('anchors every row except a response half, so scroll-to-parent lands on the opening row', () => {
      expect((createWithDepth(depthInfo()).nativeElement as HTMLElement).querySelector('#call-row-call-1')).toBeTruthy();
      expect((createWithDepth(depthInfo(), 'request').nativeElement as HTMLElement).querySelector('#call-row-call-1')).toBeTruthy();
      expect((createWithDepth(depthInfo(), 'response').nativeElement as HTMLElement).querySelector('#call-row-call-1')).toBeNull();
    });
  });
});
