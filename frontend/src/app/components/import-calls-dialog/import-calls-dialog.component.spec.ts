import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ImportCallsDialogComponent } from './import-calls-dialog.component';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { CallRecord, SessionCycle } from '../../core/models/call.model';
import { buildBulkExportPayload } from '../../shared/utils/bulk-json-builder';

function makeCall(id: string): CallRecord {
  return {
    id,
    original_url: `https://a.com-proxy/${id}`,
    url: `https://a.com/${id}`,
    method: 'GET',
    timestamp: 't',
    duration_ms: 1,
    response: { status: 200, headers: {}, body: '' },
  };
}

function makeCycle(id: string): SessionCycle {
  return { id, name: `Cycle ${id}`, createdAt: 't', assignedTo: null, status: 'PAUSED' };
}

function fileFrom(content: string, name = 'export.json'): File {
  return new File([content], name, { type: 'application/json' });
}

/** FileReader's onload fires on a real browser IO callback, not a zone-tracked macrotask - a fixed setTimeout(0) races it. Poll instead. */
function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timed out waiting for condition'));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('ImportCallsDialogComponent', () => {
  let component: ImportCallsDialogComponent;
  let copyCallsInto: jasmine.Spy;

  beforeEach(() => {
    copyCallsInto = jasmine.createSpy('copyCallsInto').and.returnValue(of({ added: 1, skipped: 0 }));
    const apiStub: Pick<SessionCyclesApiService, 'copyCallsInto'> = { copyCallsInto };
    const stateStub: Pick<SessionCyclesStateService, 'cycles' | 'create'> = {
      cycles: (() => [makeCycle('c1')]) as any,
      create: jasmine.createSpy('create') as any,
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: SessionCyclesApiService, useValue: apiStub },
        { provide: SessionCyclesStateService, useValue: stateStub },
      ],
    });

    component = TestBed.createComponent(ImportCallsDialogComponent).componentInstance;
  });

  it('parses a bare array of calls', async () => {
    const json = JSON.stringify([makeCall('call-1'), makeCall('call-2')]);
    (component as any).readFile(fileFrom(json));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()).toEqual([
      jasmine.objectContaining({ id: 'call-1' }),
      jasmine.objectContaining({ id: 'call-2' }),
    ]);
    expect(component.parseError()).toBeNull();
  });

  /**
   * Built by the REAL exporter, not by hand. The test this replaced was named "parses a full
   * bulk-export payload" and asserted against a `{ calls: [...] }` object that buildBulkExportPayload
   * has never produced - so it passed while the dialog could not read a single actual export file.
   */
  it('parses a real "Export as JSON" payload, merging a split call and ignoring comments', async () => {
    const parent: CallRecord = {
      ...makeCall('call-1'),
      timestamp: '2026-01-01T00:00:00.000Z',
      duration_ms: 5000,
      source: 'internal',
      service_name: 'odeysys',
      state: 'COMPLETED',
    };
    const child: CallRecord = {
      ...makeCall('call-2'),
      timestamp: '2026-01-01T00:00:01.000Z',
      duration_ms: 1000,
      source: 'external',
      service_name: null,
      state: 'COMPLETED',
    };
    const overlaps = [parent, child].map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      durationMs: c.duration_ms ?? 0,
      source: c.source ?? 'external',
      serviceName: c.service_name ?? null,
      status: c.response?.status,
    }));
    const payload = buildBulkExportPayload(
      [parent, child],
      { supplierName: 'FlyNas' } as never,
      new Map([['call-1', [{ id: 'comment-1' } as never]]]),
      't',
      overlaps as never
    );

    (component as any).readFile(fileFrom(JSON.stringify(payload)));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parseError()).toBeNull();
    expect(component.parsedCalls()!.map((c) => c.id).sort()).toEqual(['call-1', 'call-2']);
    // The split parent came back whole - both halves, and its direction intact so it re-imports
    // into the internal-calls store rather than being filed as outbound.
    const imported = component.parsedCalls()!.find((c) => c.id === 'call-1')!;
    expect(imported.source).toBe('internal');
    expect(imported.response?.status).toBe(200);
    expect(imported.duration_ms).toBe(5000);
    expect((imported as any).comments).toBeUndefined();
    expect(component.parseWarning()).toBeNull();
  });

  it('warns, but still imports, when the file predates direction being exported', async () => {
    const payload = buildBulkExportPayload(
      [{ ...makeCall('call-1'), timestamp: '2026-01-01T00:00:00.000Z', source: 'external', service_name: null }],
      {} as never,
      new Map(),
      't'
    );
    const events = payload.events.map((e) => {
      const copy = { ...e } as Record<string, unknown>;
      delete copy['source'];
      return copy;
    });

    (component as any).readFile(fileFrom(JSON.stringify({ ...payload, events })));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()!.length).toBe(1);
    expect(component.parseError()).toBeNull();
    expect(component.parseWarning()).toContain('inferred from the service name');
  });

  it('rejects a file that is not an export at all', async () => {
    (component as any).readFile(fileFrom(JSON.stringify({ hello: 'world' })));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()).toBeNull();
    expect(component.parseError()).toContain('No calls found');
  });

  it('rejects malformed JSON without throwing', async () => {
    (component as any).readFile(fileFrom('not json at all'));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()).toBeNull();
    expect(component.parseError()).toContain('not valid JSON');
  });

  it('rejects a non-.json file before even reading it', () => {
    (component as any).readFile(fileFrom('[]', 'export.txt'));

    expect(component.parseError()).toContain('Only .json files');
    expect(component.parsedCalls()).toBeNull();
  });

  it('skips malformed entries (missing id/url) instead of failing the whole import', async () => {
    const json = JSON.stringify([makeCall('call-1'), { method: 'GET' }, null]);
    (component as any).readFile(fileFrom(json));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()).toEqual([jasmine.objectContaining({ id: 'call-1' })]);
  });

  it('import() sends the parsed calls to every selected cycle', () => {
    component.parsedCalls.set([makeCall('call-1')]);
    component.selectedCycleIds.set(new Set(['c1', 'c2']));

    component.import();

    expect(copyCallsInto).toHaveBeenCalledWith('c1', [jasmine.objectContaining({ id: 'call-1' })]);
    expect(copyCallsInto).toHaveBeenCalledWith('c2', [jasmine.objectContaining({ id: 'call-1' })]);
    expect(component.resultMessage()).toContain('Imported 2 calls into 2 cycles');
  });
});
