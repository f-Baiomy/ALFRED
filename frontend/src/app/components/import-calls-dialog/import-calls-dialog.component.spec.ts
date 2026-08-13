import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ImportCallsDialogComponent } from './import-calls-dialog.component';
import { ImportCallsDialogService } from '../../core/services/import-calls-dialog.service';
import { SessionCyclesApiService } from '../../core/services/session-cycles-api.service';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';
import { CallRecord, SessionCycle } from '../../core/models/call.model';

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

  it('parses a full bulk-export payload, ignoring metadata/comments', async () => {
    const json = JSON.stringify({
      metadata: { supplierName: 'FlyNas' },
      exportedAt: 't',
      summary: { callCount: 1, succeeded: 1, failed: 0, totalDurationMs: 1 },
      calls: [{ ...makeCall('call-1'), comments: [{ id: 'comment-1' }] }],
    });
    (component as any).readFile(fileFrom(json));
    await waitUntil(() => component.parsedCalls() !== null || component.parseError() !== null);

    expect(component.parsedCalls()).toEqual([jasmine.objectContaining({ id: 'call-1' })]);
    expect((component.parsedCalls()![0] as any).comments).toBeUndefined();
  });

  it('rejects a file with no calls array', async () => {
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
