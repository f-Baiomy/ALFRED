import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Router } from '@angular/router';
import { DbCapturePopoverComponent } from './db-capture-popover.component';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbWindowService } from './db-window.service';
import { DbCaptureSettings } from '../../core/models/db-capture.model';

describe('DbCapturePopoverComponent - ▤ Log lines', () => {
  const settings: DbCaptureSettings = {
    rowsPerResult: 50000, beforeImageTables: [], outsideCallCapture: true,
    thresholds: { slowMs: 500, hugeRows: 1000, repeatCount: 10, largeDeleteRows: 100 },
    expectedFingerprints: [], ignorePatterns: ['SELECT 1'],
  };

  function create(logsOn: boolean) {
    const saved: DbCaptureSettings[] = [];
    TestBed.configureTestingModule({
      imports: [DbCapturePopoverComponent],
      providers: [
        { provide: DbCaptureApiService, useValue: {
          settings: () => of(settings),
          saveSettings: (_p: string, s: DbCaptureSettings) => { saved.push(s); return of(s); },
        } },
        { provide: DbCaptureStateService, useValue: {
          projectStatus: () => ({ project: 'odeysys', enabled: true, inboundLogging: true, attached: true, logsOn }),
          switchTitle: () => '', toggle: () => undefined, showChips: signal(true), setShowChips: () => undefined,
          logsOn: () => logsOn,
        } },
        { provide: DbWindowService, useValue: { openOutside: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    });
    const fixture = TestBed.createComponent(DbCapturePopoverComponent);
    fixture.componentRef.setInput('project', 'odeysys');
    fixture.detectChanges();
    return { fixture, saved };
  }

  it('shows the Log level - ERROR unless set - and saves the one picked', () => {
    const { fixture, saved } = create(true);
    const select = fixture.nativeElement.querySelector('.db-pop select') as HTMLSelectElement;
    expect(select.value).toBe('ERROR');
    select.value = 'WARN';
    select.dispatchEvent(new Event('change'));
    expect(saved.map((s) => s.logLevel)).toEqual(['WARN']);
  });

  it('dims the row while ▤ is off', () => {
    const { fixture } = create(false);
    const row = (fixture.nativeElement.querySelector('.db-pop select') as HTMLElement).closest('.pr')!;
    expect(row.classList).toContain('dim');
  });
});
