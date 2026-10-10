import { ComponentFixture, TestBed, fakeAsync, flush, tick } from '@angular/core/testing';
import { of } from 'rxjs';
import { StorageSettingsComponent } from './storage-settings.component';
import { StorageApiService } from '../../../core/services/storage-api.service';
import { StorageExportService } from '../../../core/services/storage-export.service';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { DEFAULT_RULES, StorageInsights, StorageOverview, StorageStore } from '../../../core/models/storage.model';
import { GB } from '../../../shared/utils/storage-budget';

function store(id: string, share: StorageStore['share'], sizeBytes: number, extra: Partial<StorageStore> = {}): StorageStore {
  return {
    id, name: id, group: 'traffic', share, files: id + '.db', items: 10, unit: 'calls', sizeBytes, freeBytes: 0, walBytes: 0,
    oldest: '2026-10-09T12:00:00Z', limitBytes: null, limitCalls: null, cleanable: true, ...extra,
  };
}

function overview(extra: Partial<StorageOverview> = {}): StorageOverview {
  const stores = [
    store('inbound', 'inbound', 1 * GB),
    store('outbound', 'outbound', 0.2 * GB),
    store('logs', 'logs', 1.5 * GB, { freeBytes: 1.49 * GB, group: 'capture' }),
  ];
  return {
    usedBytes: 2.7 * GB, freeInsideBytes: 1.49 * GB, disk: { path: '/data', freeBytes: 38 * GB, totalBytes: 476 * GB },
    budget: { bytes: null, split: 'recommended', ratios: {}, inboundMaxCalls: 0, outboundMaxCalls: 0, reliveKeepRuns: 0, maxAgeDays: {}, rules: DEFAULT_RULES },
    shareBytes: { inbound: 0, capture: 0, outbound: 0, logs: 0, reliveRuns: 0, work: 0 },
    shareUsed: { inbound: 1 * GB, capture: 0, outbound: 0.2 * GB, logs: 0.01 * GB, reliveRuns: 0, work: 0 },
    maxBudgetBytes: 35 * GB, stores, relive: [
      { id: 'cyc', name: 'Checkout replay', steps: 4, lastRun: '2026-10-10T10:00:00Z',
        runs: Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, status: i === 3 ? 'FAILED' : 'COMPLETED', startedAt: null, starred: i === 11 })) },
    ],
    history: [], lowDisk: false, ...extra,
  };
}

const INSIGHTS: StorageInsights = {
  endpoints: [{ direction: 'inbound', method: 'GET', path: '/hb', project: 'odeysys', calls: 2, bytes: 2000, note: 'called about every 2 s', ids: ['a', 'b'] }],
  largest: [{ direction: 'outbound', id: 'big', method: 'POST', url: 'https://s.com/pdf', status: 200, project: 's.com', bytes: 9e6, at: null }],
  projects: [{ direction: 'inbound', method: null, path: null, project: 'odeysys', calls: 2, bytes: 2000, note: null, ids: [] }],
  repeats: [{ direction: 'inbound', method: 'GET', path: '/hb', project: 'odeysys', calls: 1, bytes: 1000, note: null, ids: ['a'] }],
  repeatBytes: 1000, repeatCalls: 1,
  days: Array.from({ length: 30 }, (_, i) => ({ day: '2026-09-' + String(i + 1).padStart(2, '0'), inboundBytes: 1000, outboundBytes: 500, inboundCalls: 1, outboundCalls: 1 })),
  perDayBytes: 1500,
};

describe('StorageSettingsComponent', () => {
  let fixture: ComponentFixture<StorageSettingsComponent>;
  let api: jasmine.SpyObj<StorageApiService>;
  let exporter: jasmine.SpyObj<StorageExportService>;

  function setUp(o: StorageOverview): void {
    api = jasmine.createSpyObj<StorageApiService>('StorageApiService',
      ['overview', 'saveBudget', 'compact', 'cleanup', 'clearOutbound', 'clearInbound', 'clearCycles', 'insights', 'deleteCalls',
        'star', 'files', 'checkpoint', 'backups', 'backUp', 'backupUrl', 'deleteBackup', 'restore', 'cancelRestore', 'uploadChunk']);
    exporter = jasmine.createSpyObj<StorageExportService>('StorageExportService', ['exportCalls']);
    exporter.exportCalls.and.returnValue(of(2));
    api.restore.and.returnValue(of({ files: ['comments.db'], from: 'x.zip' }));
    api.insights.and.returnValue(of(INSIGHTS));
    api.deleteCalls.and.returnValue(of({ count: 2, kept: 0 }));
    api.star.and.returnValue(of({ starred: true }));
    api.files.and.returnValue(of([{ name: 'calls.db', fileBytes: 100, walBytes: 0, freeBytes: 0, check: 'ok' }]));
    api.backups.and.returnValue(of({ dataDir: '/data', backups: [], pending: null }));
    api.backUp.and.returnValue(of({ name: 'alfred-backup-20261010-120000.zip', bytes: 10, at: '', files: ['comments.db'], nightly: false }));
    api.backupUrl.and.callFake((n) => '/database/storage/backups/' + n);
    api.overview.and.returnValue(of(o));
    api.saveBudget.and.callFake((b) => of(overview({ budget: b, shareBytes: { inbound: 0.55 * (b.bytes ?? 0), capture: 0, outbound: 0, logs: 0, reliveRuns: 0, work: 0 } })));
    api.compact.and.returnValue(of({ freedBytes: 1.49 * GB, files: ['logs.db'], running: false }));
    api.cleanup.and.returnValue(of({ kind: 'outbound', count: 3, bytes: 3000, kept: 1, sample: [], applied: false }));
    TestBed.configureTestingModule({
      imports: [StorageSettingsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: StorageApiService, useValue: api },
        { provide: StorageExportService, useValue: exporter }],
    });
    fixture = TestBed.createComponent(StorageSettingsComponent);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function button(text: string): HTMLButtonElement {
    return Array.from(el().querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as HTMLButtonElement;
  }

  it('says no budget is set and offers the recommended one', () => {
    setUp(overview());
    expect(el().textContent).toContain('No storage budget');
    expect(el().textContent).toContain('recommended');
  });

  it('applies a budget that deletes nothing at once, as a ratio of the one number', () => {
    setUp(overview());
    button('10 GB').click();

    expect(api.saveBudget).toHaveBeenCalledTimes(1);
    const sent = api.saveBudget.calls.mostRecent().args[0];
    expect(sent.bytes).toBe(10 * GB);
    expect(sent.split).toBe('recommended');
  });

  it('asks right there before a budget smaller than what is stored deletes data', fakeAsync(() => {
    setUp(overview());
    button('1 GB').click();
    fixture.detectChanges();

    expect(api.saveBudget).not.toHaveBeenCalled();
    expect(el().textContent).toContain('1 GB is less than Alfred holds now');

    button('Set 1 GB and delete').click();
    fixture.detectChanges();
    expect(el().textContent).toContain('Undo');
    tick(8000);
    expect(api.saveBudget).toHaveBeenCalledTimes(1);
    flush();
  }));

  it('Undo cancels a delete before anything reaches the backend', fakeAsync(() => {
    setUp(overview());
    button('1 GB').click();
    fixture.detectChanges();
    button('Set 1 GB and delete').click();
    fixture.detectChanges();
    button('Undo').click();
    tick(10_000);
    expect(api.saveBudget).not.toHaveBeenCalled();
    flush();
  }));

  it('frees the empty space inside the files with one button, deleting nothing', () => {
    setUp(overview());
    const free = button('Free 1.49 GB');
    expect(free).toBeTruthy();
    free.click();
    expect(api.compact).toHaveBeenCalledWith();
  });

  it('previews a clean-up as filters change and deletes only after the Undo window', fakeAsync(() => {
    setUp(overview());
    fixture.componentInstance.openCleanup('outbound', 7);
    tick(300);
    fixture.detectChanges();
    expect(api.cleanup).toHaveBeenCalledWith(jasmine.objectContaining({ kind: 'outbound', olderThanDays: 7, keepCommented: true }), false);
    expect(el().textContent).toContain('Delete 3 outbound calls');

    button('Delete 3 outbound calls').click();
    tick(8000);
    expect(api.cleanup).toHaveBeenCalledWith(jasmine.objectContaining({ kind: 'outbound' }), true);
    flush();
  }));

  it('lists Relive runs apart from session cycles and marks those beyond the last N', () => {
    setUp(overview({ budget: { bytes: 5 * GB, split: 'recommended', ratios: {}, inboundMaxCalls: 0, outboundMaxCalls: 0, reliveKeepRuns: 10, maxAgeDays: {}, rules: DEFAULT_RULES } }));
    fixture.componentInstance.tab.set('relive');
    fixture.detectChanges();

    expect(el().textContent).toContain('Checkout replay');
    expect(el().querySelectorAll('.st-run.goes').length).toBe(1);
    expect(el().querySelectorAll('.st-run.starred').length).toBe(1);
    expect(el().querySelectorAll('.st-run.bad').length).toBe(1);
  });

  it('a typed word guards the danger zone', fakeAsync(() => {
    setUp(overview());
    fixture.componentInstance.openDanger('inbound');
    fixture.detectChanges();
    const del = Array.from(el().querySelectorAll('.st-dialog button')).find((b) => b.textContent?.trim() === 'Delete') as HTMLButtonElement;
    expect(del.disabled).toBeTrue();

    fixture.componentInstance.dangerText.set('delete inbound');
    fixture.detectChanges();
    expect(del.disabled).toBeFalse();
    api.clearInbound.and.returnValue(of({ deleted: 5 }));
    del.click();
    tick(8000);
    expect(api.clearInbound).toHaveBeenCalled();
    flush();
  }));

  it('shows where the space goes and deletes the calls of an endpoint after the Undo window', fakeAsync(() => {
    setUp(overview());
    fixture.componentInstance.setTab('biggest');
    fixture.detectChanges();
    expect(el().textContent).toContain('/hb');
    expect(el().textContent).toContain('called about every 2 s');

    button('Delete these').click();
    fixture.detectChanges();
    expect(el().querySelector('tr.st-gone')).toBeTruthy();
    tick(8000);
    expect(api.deleteCalls).toHaveBeenCalledWith(['a', 'b'], [], 'GET /hb');
    flush();
  }));

  it('draws what each day added and forecasts at the recent rate', () => {
    setUp(overview());
    fixture.componentInstance.setTab('history');
    fixture.detectChanges();
    expect(el().querySelectorAll('.st-col:not(.fc)').length).toBe(14);
    expect(el().querySelectorAll('.st-col.fc').length).toBeGreaterThan(0);
    expect(el().textContent).toContain('a day');
  });

  it('stars a run so no rule deletes it', () => {
    setUp(overview());
    fixture.componentInstance.tab.set('relive');
    fixture.detectChanges();
    (el().querySelector('.st-run:not(.starred)') as HTMLButtonElement).click();
    expect(api.star).toHaveBeenCalledWith('r0', true);
  });

  it('dragging a divider moves ratio between the two shares beside it and keeps the budget', () => {
    setUp(overview());
    const c = fixture.componentInstance;
    const bar = document.createElement('div');
    spyOn(bar, 'getBoundingClientRect').and.returnValue({ left: 0, width: 1000 } as DOMRect);
    c.startDrag(new PointerEvent('pointerdown'), 0, bar);
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 }));
    window.dispatchEvent(new PointerEvent('pointerup'));

    expect(c.draftSplit()).toBe('custom');
    const r = c.draftEffectiveRatios();
    expect(r.inbound).toBeCloseTo(0.4, 3);
    expect(r.capture).toBeCloseTo(0.35, 3);
    expect(r.outbound).toBeCloseTo(0.1, 3);
  });

  it('backs up the chosen groups and lists the file health', () => {
    setUp(overview());
    fixture.componentInstance.setTab('backup');
    fixture.detectChanges();
    expect(el().textContent).toContain('calls.db');
    button('Back up now').click();
    expect(api.backUp).toHaveBeenCalledWith(['work', 'config']);
  });

  it('saves the automatic rules even without a budget', () => {
    setUp(overview());
    const c = fixture.componentInstance;
    c.setRule('dropPreflights', true);
    c.saveAutoRules();
    const sent = api.saveBudget.calls.mostRecent().args[0];
    expect(sent.bytes).toBeNull();
    expect(sent.rules.dropPreflights).toBeTrue();
  });

  it('warns on the page when the disk is low', () => {
    setUp(overview({ lowDisk: true }));
    expect(el().textContent).toContain('The disk is almost full');
  });

  it('stops recording an endpoint by saving it in the rules, and can record it again', () => {
    setUp(overview());
    const c = fixture.componentInstance;
    c.setTab('biggest');
    fixture.detectChanges();
    button('Stop recording').click();

    let sent = api.saveBudget.calls.mostRecent().args[0];
    expect(sent.rules.stopRecording).toEqual(['inbound GET /hb']);
    c.recordAgain('inbound GET /hb');
    sent = api.saveBudget.calls.mostRecent().args[0];
    expect(sent.rules.stopRecording).toEqual([]);
  });

  it('exports an endpoint, a store and what a clean-up would delete as Alfred .json', fakeAsync(() => {
    setUp(overview());
    const c = fixture.componentInstance;
    c.setTab('biggest');
    fixture.detectChanges();
    button('Export').click();
    expect(exporter.exportCalls).toHaveBeenCalledWith('inbound', ['a', 'b']);

    api.cleanup.and.returnValue(of({ kind: 'outbound', count: 2, bytes: 10, kept: 0, sample: [], applied: false, ids: ['x', 'y'] }));
    c.exportStore('outbound');
    expect(exporter.exportCalls).toHaveBeenCalledWith('outbound', ['x', 'y']);

    c.openCleanup('outbound', 7);
    tick(300);
    c.exportCleanup();
    expect(exporter.exportCalls.calls.mostRecent().args).toEqual(['outbound', ['x', 'y']]);
    flush();
  }));

  it('uploads a backup in chunks, then prepares the restore', () => {
    setUp(overview());
    const c = fixture.componentInstance;
    const answers = [of({ received: true as const }), of({ name: 'alfred-backup-1.zip', bytes: 9, at: '', files: ['comments.db'], nightly: false })];
    api.uploadChunk.and.callFake(() => answers.shift()!);
    const big = new File([new Uint8Array(StorageSettingsComponent.CHUNK + 5)], 'b.zip');

    c.uploadAndRestore(big);

    expect(api.uploadChunk).toHaveBeenCalledTimes(2);
    expect(api.uploadChunk.calls.argsFor(1)[1]).toBe(StorageSettingsComponent.CHUNK);
    expect(api.restore).toHaveBeenCalledWith('alfred-backup-1.zip');
  });

  it('keeps commented calls out of every limit by default and can turn that off', () => {
    setUp(overview());
    const c = fixture.componentInstance;
    expect(c.draftRules().keepCommented).toBeTrue();
    c.setRule('keepCommented', false);
    c.saveAutoRules();
    expect(api.saveBudget.calls.mostRecent().args[0].rules.keepCommented).toBeFalse();
  });

  it('adds its own stylesheet once', () => {
    setUp(overview());
    TestBed.createComponent(StorageSettingsComponent).detectChanges();
    expect(document.querySelectorAll('#alfred-storage-page-css').length).toBe(1);
  });
});
