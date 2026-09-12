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

  /** Clicks one of the four block chips - req headers, req body, res headers, res body. */
  function openBlock(fixture: ReturnType<typeof createCard>, index: number): void {
    ((fixture.nativeElement as HTMLElement).querySelectorAll('.block-chip')[index] as HTMLButtonElement).click();
    fixture.detectChanges();
  }

  it('lists all four blocks collapsed, fetching none of them', () => {
    const fixture = createCard();
    const host: HTMLElement = fixture.nativeElement;

    const chips = Array.from(host.querySelectorAll('.block-chip'));
    expect(chips.map((c) => c.textContent?.trim())).toEqual(['▸ Headers', '▸ Body', '▸ Headers', '▸ Body']);
    // Grouped once each, rather than repeating the word on every chip.
    expect(Array.from(host.querySelectorAll('.blocks-group')).map((g) => g.textContent?.trim())).toEqual(['REQ', 'RES']);
    // Nothing is open, so no panel is rendered and nothing has been fetched.
    expect(host.querySelector('.block-panel')).toBeNull();
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

    openBlock(fixture, 0); // close
    openBlock(fixture, 0); // and reopen

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

    expect(host.textContent).toContain('Failed to load response headers');
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
      expect(Array.from(requestRow.querySelectorAll('.blocks-group')).map((g) => g.textContent?.trim())).toEqual(['REQ']);
      expect(requestRow.querySelectorAll('.block-chip').length).toBe(2);

      const responseRow: HTMLElement = createCard(makeCall(), 'response').nativeElement;
      expect(Array.from(responseRow.querySelectorAll('.blocks-group')).map((g) => g.textContent?.trim())).toEqual(['RES']);
      expect(responseRow.querySelectorAll('.block-chip').length).toBe(2);
    });

    it('stacks open blocks vertically, each spanning the card', () => {
      const fixture = createCard();
      const host: HTMLElement = fixture.nativeElement;

      openBlock(fixture, 0);
      httpMock.expectOne((r) => r.params.get('part') === 'request-headers').flush({ request: { headers: {} } });
      fixture.detectChanges();
      expect(host.querySelectorAll('.block-panel').length).toBe(1);

      openBlock(fixture, 2);
      httpMock.expectOne((r) => r.params.get('part') === 'response-headers').flush({ response: { status: 200, headers: {} } });
      fixture.detectChanges();

      // One per row, in the chips' own fixed order - never side by side, where each panel gets half
      // the width and its toolbar wraps onto three rows.
      const open = host.querySelector('.blocks-open') as HTMLElement;
      expect(open.classList.contains('panels')).toBe(false);
      expect(host.querySelectorAll('.block-panel').length).toBe(2);
      expect(Array.from(host.querySelectorAll('.block-panel-title span')).map((t) => t.textContent?.trim())).toEqual([
        'Request headers',
        'Response headers',
      ]);
    });

    it('closes one open block from its own title bar, and all of them from the strip', () => {
      const fixture = createCard();
      const host: HTMLElement = fixture.nativeElement;

      openBlock(fixture, 0);
      httpMock.expectOne((r) => r.params.get('part') === 'request-headers').flush({ request: { headers: {} } });
      openBlock(fixture, 1);
      httpMock.expectOne((r) => r.params.get('part') === 'request-body').flush({ request: { body: 'b' } });
      fixture.detectChanges();
      const collapseAll = host.querySelector('.blocks-collapse') as HTMLButtonElement;
      expect(collapseAll.textContent).toContain('collapse all');
      // The count lives in the title rather than the label, to keep the button small.
      expect(collapseAll.getAttribute('title')).toBe('Collapse all 2 open blocks');

      (host.querySelector('.block-panel-close') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(host.querySelectorAll('.block-panel').length).toBe(1);

      (host.querySelector('.blocks-collapse') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(host.querySelector('.block-panel')).toBeNull();
      // Closing doesn't discard what was fetched - reopening costs no request.
      openBlock(fixture, 0);
      httpMock.expectNone((r) => r.url.includes('/detail'));
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

  describe('url line', () => {
    function urlRow(call: CallRecord): HTMLElement {
      return (createCard(call).nativeElement as HTMLElement).querySelector('.call-urls') as HTMLElement;
    }

    it('folds an external call to one line carrying the whole url, host included', () => {
      // The forward proxy never rewrites, so from and to are byte-identical on every external call.
      const row = urlRow(makeCall({ original_url: 'https://sup.example.com/api/x', url: 'https://sup.example.com/api/x' }));

      expect(row.querySelectorAll('.uri-row').length).toBe(1);
      expect(row.querySelector('.uri-label')?.textContent?.trim()).toBe('URL');
      expect(row.querySelector('.uri-value')?.textContent?.trim()).toBe('https://sup.example.com/api/x');
      // Nothing is tucked away, so there is nothing to reveal.
      expect(row.querySelector('.uri-hosts-toggle')).toBeNull();
    });

    it('folds an internal call to its shared path, with the host hop behind a toggle', () => {
      const row = urlRow(
        makeCall({
          source: 'internal',
          original_url: 'http://localhost:9001/odeysysadmin/downloadPortalFile?url=/fstore/EK.jpg',
          url: 'http://host.docker.internal:8080/odeysysadmin/downloadPortalFile?url=/fstore/EK.jpg',
        })
      );

      expect(row.querySelectorAll('.uri-row').length).toBe(1);
      expect(row.querySelector('.uri-value')?.textContent?.trim()).toBe('/odeysysadmin/downloadPortalFile?url=/fstore/EK.jpg');
      expect(row.querySelector('.uri-hosts-toggle')).toBeTruthy();
      // Collapsed by default - the hosts are identical on every card, so they aren't what you read.
      expect(row.querySelector('.uri-hosts')).toBeNull();
    });

    it('reveals both full urls on click, and hides them again', () => {
      const fixture = createCard(
        makeCall({
          source: 'internal',
          original_url: 'http://localhost:9001/a',
          url: 'http://host.docker.internal:8080/a',
        })
      );
      const host: HTMLElement = fixture.nativeElement;
      const toggle = host.querySelector('.uri-hosts-toggle') as HTMLButtonElement;

      toggle.click();
      fixture.detectChanges();
      const revealed = host.querySelector('.uri-hosts') as HTMLElement;
      expect(revealed.textContent).toContain('http://localhost:9001/a');
      expect(revealed.textContent).toContain('http://host.docker.internal:8080/a');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      toggle.click();
      fixture.detectChanges();
      expect(host.querySelector('.uri-hosts')).toBeNull();
    });

    it('keeps both lines when more than the host differs - a rewrite is never folded away', () => {
      const row = urlRow(
        makeCall({
          source: 'internal',
          original_url: 'http://localhost:9001/legacy/search',
          url: 'http://host.docker.internal:8080/v2/search',
        })
      );

      expect(row.querySelectorAll('.uri-row').length).toBe(2);
      expect(Array.from(row.querySelectorAll('.uri-label')).map((l) => l.textContent?.trim())).toEqual(['From', 'To']);
      expect(row.querySelector('.uri-hosts-toggle')).toBeNull();
    });

    it('keeps both lines when a url cannot be parsed, rather than dropping one', () => {
      const row = urlRow(makeCall({ original_url: 'not a url', url: 'http://host/x' }));

      expect(row.querySelectorAll('.uri-row').length).toBe(2);
    });
  });

  describe('blocks with no content to show', () => {
    it('keeps the response chips in place while the call is running, marked pending', () => {
      const host: HTMLElement = createCard(makeCall({ state: 'IN_PROGRESS', response: undefined })).nativeElement;
      const chips = Array.from(host.querySelectorAll('.block-chip'));

      // All four slots stay, so nothing reflows when the response lands.
      expect(chips.length).toBe(4);
      expect(chips.slice(2).every((c) => c.classList.contains('pending'))).toBe(true);
      expect(chips.slice(0, 2).some((c) => c.classList.contains('pending'))).toBe(false);
      expect(chips[2].textContent?.trim()).toBe('⏳ Headers');
    });

    it('arms a pending chip instead of opening it, then opens it by itself once the call resolves', () => {
      const fixture = createCard(makeCall({ state: 'IN_PROGRESS', response: undefined }));
      const host: HTMLElement = fixture.nativeElement;

      (host.querySelectorAll('.block-chip')[3] as HTMLButtonElement).click();
      fixture.detectChanges();

      // Armed, not open - there is nothing to fetch yet.
      expect(host.querySelectorAll('.block-chip')[3].classList.contains('armed')).toBe(true);
      expect(host.querySelector('.block-panel')).toBeNull();
      httpMock.expectNone((r) => r.url.includes('/detail'));

      // The WebSocket push that completes the call replaces the record.
      fixture.componentRef.setInput('call', makeCall({ state: 'COMPLETED', response: { status: 200 } }));
      fixture.detectChanges();

      httpMock.expectOne((r) => r.params.get('part') === 'response-body').flush({ response: { status: 200, body: 'landed' } });
      fixture.detectChanges();

      expect(host.querySelector('.block-panel-title span')?.textContent?.trim()).toBe('Response body');
      expect(host.textContent).toContain('landed');
    });

    it('marks the response as never-coming on a failed call, and refuses to open it', () => {
      const fixture = createCard(makeCall({ error: 'boom', response: undefined }));
      const host: HTMLElement = fixture.nativeElement;
      const chips = Array.from(host.querySelectorAll('.block-chip')) as HTMLButtonElement[];

      // The two response blocks collapse to a single inert chip - twice the noise otherwise, for a
      // response that genuinely does not exist (?part=response-body returns nulls for these).
      expect(chips.map((c) => c.textContent?.trim())).toEqual(['▸ Headers', '▸ Body', '— none']);
      expect(chips[2].disabled).toBe(true);

      chips[2].click();
      fixture.detectChanges();
      expect(host.querySelector('.block-panel')).toBeNull();
      httpMock.expectNone((r) => r.url.includes('/detail'));
    });
  });
});
