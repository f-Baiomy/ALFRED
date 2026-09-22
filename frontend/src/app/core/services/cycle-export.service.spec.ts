import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CycleExportService } from './cycle-export.service';
import { ExportDialogService } from './export-dialog.service';
import { AppConfigService } from './app-config.service';
import { SessionCycle } from '../models/call.model';

const CYCLE: SessionCycle = {
  id: 'cycle-1',
  name: 'Repro flight bug',
  createdAt: '2026-01-01T00:00:00.000Z',
  assignedTo: 'profile-7',
  status: 'PAUSED',
};

function summaryDto(id: string) {
  return {
    id,
    original_url: `https://example.com/${id}`,
    url: `https://example.com/${id}`,
    method: 'GET',
    timestamp: '2026-01-01T00:00:00.000Z',
    duration_ms: 5,
    status: 200,
  };
}

function pageDto(ids: readonly string[], total: number) {
  return {
    calls: ids.map((id) => ({ id: `captured-${id}`, capturedAt: '2026-01-01T00:00:00.000Z', call: summaryDto(id) })),
    total,
  };
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

/** Whatever any of the export's follow-up requests asks for - detail/comments/overlaps/metadata. */
function bodyFor(url: string): object | null {
  if (url.endsWith('/detail')) return { request: { headers: {}, body: 'req' }, response: { status: 200, headers: {}, body: 'res' } };
  if (url.endsWith('/comments')) return [];
  if (url.endsWith('/call-overlaps')) return [];
  if (url.endsWith('/export-metadata')) return null;
  if (url.endsWith('/spacers')) return [];
  return pageDto([], 0);
}

/** Flushes every request the export makes until it settles - each flush can start the next batch. */
function drain(httpMock: HttpTestingController): void {
  for (let round = 0; round < 1000; round++) {
    const pending = httpMock.match(() => true);
    if (pending.length === 0) return;
    for (const req of pending) req.flush(bodyFor(req.request.url));
  }
  throw new Error('export requests never settled');
}

describe('CycleExportService', () => {
  let service: CycleExportService;
  let exportDialog: ExportDialogService;
  let httpMock: HttpTestingController;
  let backendUrl: string;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CycleExportService);
    exportDialog = TestBed.inject(ExportDialogService);
    httpMock = TestBed.inject(HttpTestingController);
    backendUrl = TestBed.inject(AppConfigService).backendUrl;
    exportDialog.close();
  });

  afterEach(() => httpMock.verify());

  function listRequest(source: 'calls' | 'internal-calls', offset: string) {
    return httpMock.expectOne(
      (r) => r.url === `${backendUrl}/session-cycles/cycle-1/${source}` && r.params.get('offset') === offset
    );
  }

  it('pages past the first page until the whole cycle is loaded', () => {
    service.exportCycle(CYCLE, 'markdown');

    listRequest('calls', '0').flush(pageDto(ids('a', 200), 250));
    listRequest('calls', '200').flush(pageDto(ids('b', 50), 250));
    listRequest('internal-calls', '0').flush(pageDto([], 0));
    drain(httpMock);

    expect(exportDialog.state()?.calls.length).toBe(250);
  });

  it('queries both the external and the internal source and concatenates them', () => {
    service.exportCycle(CYCLE, 'json');

    listRequest('calls', '0').flush(pageDto(['ext-1'], 1));
    listRequest('internal-calls', '0').flush(pageDto(['int-1'], 1));
    drain(httpMock);

    const calls = exportDialog.state()?.calls ?? [];
    expect(calls.map((c) => c.id)).toEqual(['ext-1', 'int-1']);
    expect(calls.map((c) => c.source)).toEqual(['external', 'internal']);
  });

  it('sends no search/supplier/session filter - the export is the whole cycle', () => {
    service.exportCycle(CYCLE, 'markdown');

    const req = listRequest('calls', '0');
    expect(req.request.params.get('search')).toBe('');
    expect(req.request.params.get('supplier')).toBe('');
    expect(req.request.params.get('sessionId')).toBe('');
    expect(req.request.params.get('operationId')).toBe('');
    expect(req.request.params.get('requestId')).toBe('');
    expect(req.request.params.get('serviceNames')).toBeNull();
    expect(req.request.params.get('sort')).toBe('oldest');
    expect(req.request.params.get('limit')).toBe('200');
    req.flush(pageDto([], 0));

    listRequest('internal-calls', '0').flush(pageDto([], 0));
    drain(httpMock);
  });

  it('hydrates each call over the network, at most six requests at a time', () => {
    service.exportCycle(CYCLE, 'markdown');

    listRequest('calls', '0').flush(pageDto(ids('a', 20), 20));
    listRequest('internal-calls', '0').flush(pageDto([], 0));

    const firstBatch = httpMock.match((r) => r.url.endsWith('/detail'));
    expect(firstBatch.length).toBe(6);
    for (const req of firstBatch) req.flush(bodyFor(req.request.url));

    const secondBatch = httpMock.match((r) => r.url.endsWith('/detail'));
    expect(secondBatch.length).toBe(6);
    for (const req of secondBatch) req.flush(bodyFor(req.request.url));

    drain(httpMock);
    expect(exportDialog.state()?.calls.every((c) => c.request?.body === 'req')).toBe(true);
  });

  it('opens the export dialog with the cycle set and no status filter applied', () => {
    service.exportCycle(CYCLE, 'json');

    listRequest('calls', '0').flush(pageDto(['ext-1'], 1));
    listRequest('internal-calls', '0').flush(pageDto([], 0));
    drain(httpMock);

    const state = exportDialog.state();
    expect(state?.format).toBe('json');
    expect(state?.statusFilter).toBe('all');
    expect(state?.cycle).toEqual({
      id: 'cycle-1',
      name: 'Repro flight bug',
      assignedTo: 'profile-7',
      status: 'PAUSED',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(service.exportingCycleId()).toBeNull();
    expect(service.progress()).toBeNull();
  });

  /** fetchSpacers only fires once hydrateAll's own /detail request(s) have resolved (see exportCycle's forkJoin) - so the /spacers request doesn't exist until that /detail request is flushed first. */
  function flushThroughDetailThenSpacers(spacerDtos: readonly object[]): void {
    listRequest('calls', '0').flush(pageDto(['ext-1'], 1));
    listRequest('internal-calls', '0').flush(pageDto([], 0));
    for (const req of httpMock.match((r) => r.url.endsWith('/detail'))) req.flush(bodyFor(req.request.url));
    httpMock.expectOne(`${backendUrl}/session-cycles/cycle-1/spacers`).flush(spacerDtos);
    drain(httpMock);
  }

  it('passes a spacer straight through, keyed on the underlying call id it already anchors to', () => {
    service.exportCycle(CYCLE, 'markdown');

    flushThroughDetailThenSpacers([{ id: 's1', cycleId: 'cycle-1', label: 'Retry attempt', beforeCallId: 'ext-1' }]);

    expect(exportDialog.state()?.spacers).toEqual([{ label: 'Retry attempt', beforeCallId: 'ext-1' }]);
  });

  it('passes through a spacer anchored to a call that never made it into the export - the builders drop it themselves', () => {
    service.exportCycle(CYCLE, 'markdown');

    flushThroughDetailThenSpacers([{ id: 's1', cycleId: 'cycle-1', label: 'Orphaned', beforeCallId: 'does-not-exist' }]);

    expect(exportDialog.state()?.spacers).toEqual([{ label: 'Orphaned', beforeCallId: 'does-not-exist' }]);
  });

  it('keeps a trailing spacer (beforeCallId null) as-is', () => {
    service.exportCycle(CYCLE, 'markdown');

    flushThroughDetailThenSpacers([{ id: 's1', cycleId: 'cycle-1', label: 'End of repro', beforeCallId: null }]);

    expect(exportDialog.state()?.spacers).toEqual([{ label: 'End of repro', beforeCallId: null }]);
  });

  it('an empty cycle sets a message instead of opening the dialog', () => {
    service.exportCycle(CYCLE, 'markdown');

    listRequest('calls', '0').flush(pageDto([], 0));
    listRequest('internal-calls', '0').flush(pageDto([], 0));

    expect(exportDialog.state()).toBeNull();
    expect(service.message()).toBe('"Repro flight bug" has no captured calls to export.');
    expect(service.exportingCycleId()).toBeNull();
  });
});
