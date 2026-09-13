import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CallTreeNodeComponent } from './call-tree-node.component';
import { CallRecord } from '../../core/models/call.model';
import { buildCallTree } from '../../shared/utils/call-tree';
import { CallsStateService } from '../../core/state/calls-state.service';
import { BULK_SELECTION_STATE, CALL_LIST_CONTROLS_STATE, CALL_SELECTION_STATE } from '../../core/state/call-selection.tokens';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');

function call(id: string, startMs: number, durationMs: number, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id,
    original_url: `http://localhost/${id}`,
    url: `http://host/${id}`,
    method: 'POST',
    timestamp: new Date(T0 + startMs).toISOString(),
    duration_ms: durationMs,
    response: { status: 200 },
    source: 'internal',
    state: 'COMPLETED',
    ...overrides,
  };
}

describe('CallTreeNodeComponent', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    };
    await TestBed.configureTestingModule({
      imports: [CallTreeNodeComponent],
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
    httpMock.match(() => true).forEach((req) => req.flush({ calls: [], total: 0 }));
    httpMock.verify();
  });

  function createNode(calls: CallRecord[]) {
    const fixture = TestBed.createComponent(CallTreeNodeComponent);
    fixture.componentRef.setInput('node', buildCallTree(calls)[0]);
    fixture.detectChanges();
    return fixture;
  }

  it('renders a child card physically inside its parent, three levels deep', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
      call('sabre', 2500, 1000, { source: 'external', service_name: 'core-service' }),
    ]).nativeElement;

    // Each level nests inside the previous one's children container, rather than sitting beside it.
    const level1 = host.querySelector('.tree-children')!;
    expect(level1).toBeTruthy();
    const level2 = level1.querySelector('.tree-children')!;
    expect(level2).toBeTruthy();
    expect(host.querySelectorAll('app-call-card').length).toBe(3);
    expect(level2.querySelectorAll('app-call-card').length).toBe(1);
  });

  it('renders no children container for a call with nothing nested inside it', () => {
    const host: HTMLElement = createNode([call('solo', 0, 100, { service_name: 'odeysys' })]).nativeElement;

    expect(host.querySelector('.tree-children')).toBeNull();
    expect(host.querySelectorAll('app-call-card').length).toBe(1);
  });

  it('sandwiches a parent: request band, then its children, then the response band', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]).nativeElement;

    const card = host.querySelector('.call.sandwich')!;
    const parts = Array.from(card.children).map((el) => el.className.split(' ')[0]);

    expect(parts).toEqual(['call-band', 'call-nested', 'call-band']);
    expect(card.querySelector('.call-band-request')).toBeTruthy();
    expect(card.querySelector('.call-band-response')).toBeTruthy();
    expect(card.querySelector('.call-nested .tree-children')).toBeTruthy();
  });

  it('puts the status and duration in the closing band, below the children the call waited on', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]).nativeElement;

    const requestBand = host.querySelector('.call-band-request')!;
    const responseBand = host.querySelector('.call-band-response')!;

    expect(requestBand.querySelector('.status-sent')).toBeTruthy();
    expect(requestBand.textContent).toContain('request');
    expect(requestBand.querySelector('.duration')).toBeNull();

    expect(responseBand.querySelector('.duration')?.textContent).toContain('10000');
    expect(responseBand.textContent).toContain('response');
    expect(responseBand.querySelector('.status-2xx')).toBeTruthy();
  });

  it('lists each band\'s own two blocks, collapsed, with nothing fetched up front', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]).nativeElement;

    const chipsIn = (selector: string) =>
      Array.from(host.querySelectorAll(selector + ' .block-chip')).map((c) => (c.textContent ?? '').trim());

    expect(chipsIn('.call-band-request')).toEqual(['▸ Headers', '▸ Body']);
    expect(chipsIn('.call-band-response')).toEqual(['▸ Headers', '▸ Body']);
    // Nothing open, so no panel exists and nothing has been fetched.
    expect(host.querySelector('.block-panel')).toBeNull();
    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  it('fetches only the block that was opened, and nothing else', () => {
    const fixture = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]);
    const host: HTMLElement = fixture.nativeElement;
    const responseBody = host.querySelectorAll('.call-band-response .block-chip')[1] as HTMLButtonElement;

    responseBody.click();
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url.includes('/odeysys/detail') && r.params.get('part') === 'response-body');
    req.flush({ response: { status: 200, body: 'resp-body' } });
    fixture.detectChanges();

    expect(host.querySelector('.call-band-response')!.textContent).toContain('resp-body');
    // The other three blocks were never asked for.
    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  it('leaves a childless call as a plain, unsandwiched card that still lists all four blocks', () => {
    const host: HTMLElement = createNode([call('solo', 0, 100, { service_name: 'odeysys' })]).nativeElement;

    expect(host.querySelector('.call.sandwich')).toBeNull();
    expect(host.querySelector('.call-band')).toBeNull();
    expect(host.querySelectorAll('.block-chip').length).toBe(4);
    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  /** odeysys > core-service > sabre - two levels of parent, so "does this bubble" is answerable. */
  function threeDeep(): CallRecord[] {
    return [
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
      call('sabre', 2500, 1000, { source: 'external', service_name: 'core-service' }),
    ];
  }

  it('a press on a nested card selects THAT call, not every card it happens to sit inside', () => {
    const fixture = createNode(threeDeep());
    const host: HTMLElement = fixture.nativeElement;
    const selection = TestBed.inject(CALL_SELECTION_STATE);
    const spy = spyOn(selection, 'startDragSelect').and.callThrough();

    // Measured before this was fixed: mousedown bubbles, and every ancestor card ran the same
    // handler, so pressing one supplier call at depth 2 selected it, its parent AND its grandparent.
    const deepest = host.querySelectorAll('app-call-card')[2];
    deepest.querySelector('.call-top')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(spy.calls.count()).toBe(1);
    expect(spy.calls.mostRecent().args[0].id).toBe('sabre');
    // ...and it asks for subtree painting, which is what the nested view's checkbox means too.
    expect(spy.calls.mostRecent().args[1]).toBe(true);
  });

  it('a parent\'s checkbox takes its whole subtree, not just the parent', () => {
    const fixture = createNode(threeDeep());
    const host: HTMLElement = fixture.nativeElement;
    const selection = TestBed.inject(CALL_SELECTION_STATE);
    const spy = spyOn(selection, 'setSubtreeSelected').and.callThrough();

    (host.querySelector('.call-select') as HTMLInputElement).click();

    expect(spy.calls.mostRecent().args[0].id).toBe('odeysys');
    expect(spy.calls.mostRecent().args[1]).toBe(true);
  });

  it('folding a parent hides its children behind a count, and unfolds again from that same chip', () => {
    const fixture = createNode(threeDeep());
    const host: HTMLElement = fixture.nativeElement;

    expect(host.querySelector('.tree-children')).toBeTruthy();

    (host.querySelector('.fold-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.querySelector('.tree-children')).toBeNull();
    // Both descendants counted, not just the direct child - the chip stands in for the whole subtree.
    expect(host.querySelector('.tree-fold-summary')!.textContent).toContain('2 calls folded');
    expect(host.querySelectorAll('app-call-card').length).toBe(1);

    (host.querySelector('.tree-fold-summary') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(host.querySelector('.tree-children')).toBeTruthy();
  });

  it('folding a parent folds the parents inside it too, so reopening gives back one level', () => {
    const fixture = createNode(threeDeep());
    const host: HTMLElement = fixture.nativeElement;

    (host.querySelector('.fold-toggle') as HTMLButtonElement).click();
    fixture.detectChanges();
    (host.querySelector('.tree-fold-summary') as HTMLButtonElement).click();
    fixture.detectChanges();

    // core-service came back folded, so one click undid one level rather than the whole subtree.
    expect(host.querySelectorAll('app-call-card').length).toBe(2);
    expect(host.querySelector('.tree-children .tree-fold-summary')!.textContent).toContain('1 call folded');
  });

  it('offers diagnose on a parent card only, and shows the panel on top of the card when pressed', () => {
    const fixture = createNode(threeDeep());
    const host: HTMLElement = fixture.nativeElement;

    // Two parents, so two buttons - and nothing analysed until one is asked.
    expect(host.querySelectorAll('.diag-btn').length).toBe(2);
    expect(host.querySelector('app-call-diagnostics')).toBeNull();

    (host.querySelector('.diag-btn') as HTMLButtonElement).click();
    fixture.detectChanges();

    const card = host.querySelector('.call.sandwich')!;
    // First child of the card: above the request band, inside the card it describes.
    expect(Array.from(card.children).map((el) => el.className.split(' ')[0])).toEqual([
      'call-diag',
      'call-band',
      'call-nested',
      'call-band',
    ]);
  });

  it('a leaf card offers no diagnose button, having made no calls to account for', () => {
    const host: HTMLElement = createNode([call('solo', 0, 100, { service_name: 'odeysys' })]).nativeElement;

    expect(host.querySelector('.diag-btn')).toBeNull();
  });

  it('a leaf card offers no fold control, having nothing to fold', () => {
    const host: HTMLElement = createNode([call('solo', 0, 100, { service_name: 'odeysys' })]).nativeElement;

    expect(host.querySelector('.fold-toggle')).toBeNull();
  });

  it('carries no depth badge or span bar - the nesting itself is the statement', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]).nativeElement;

    expect(host.querySelector('.depth-badge')).toBeNull();
    expect(host.querySelector('.span-bar')).toBeNull();
  });
});
