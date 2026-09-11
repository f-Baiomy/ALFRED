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

  it('never splits a parent into request/response halves - the card already encloses its children', () => {
    const host: HTMLElement = createNode([
      call('odeysys', 0, 10000, { service_name: 'odeysys' }),
      call('core', 2000, 4000, { service_name: 'core-service' }),
    ]).nativeElement;

    expect(host.textContent).not.toContain('· request');
    expect(host.textContent).not.toContain('· response');
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
