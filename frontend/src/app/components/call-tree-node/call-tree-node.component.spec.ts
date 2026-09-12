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

    const summariesIn = (selector: string) =>
      Array.from(host.querySelectorAll(selector + ' .panel details.block summary')).map((s) => (s.textContent ?? '').trim().split(/\s+/)[0]);

    expect(summariesIn('.call-band-request')).toEqual(['Headers', 'Body']);
    expect(summariesIn('.call-band-response')).toEqual(['Headers', 'Body']);
    // Every block starts closed and unfetched - listing them costs no requests at all.
    expect(Array.from(host.querySelectorAll('details.block')).every((d) => !(d as HTMLDetailsElement).open)).toBe(true);
    httpMock.expectNone((r) => r.url.includes('/detail'));
  });

  it('fetches only the block that was opened, and nothing else', () => {
    const fixture = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]);
    const host: HTMLElement = fixture.nativeElement;
    const responseBody = host.querySelectorAll('.call-band-response details.block')[1] as HTMLDetailsElement;

    responseBody.open = true;
    responseBody.dispatchEvent(new Event('toggle'));
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
    expect(host.querySelectorAll('details.block').length).toBe(4);
    httpMock.expectNone((r) => r.url.includes('/detail'));
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
