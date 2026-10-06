import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { DbCaptureSettingsComponent } from './db-capture-settings.component';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { RedactionsStore } from '../../core/state/redactions-store.service';
import { DbCaptureSettings, ProjectCaptureStatus } from '../../core/models/db-capture.model';
import { logLevelWords } from '../../shared/utils/call-log-rows';

describe('DbCaptureSettingsComponent - Log level', () => {
  const settings: DbCaptureSettings = {
    rowsPerResult: 50000, beforeImageTables: [], outsideCallCapture: true,
    thresholds: { slowMs: 500, hugeRows: 1000, repeatCount: 10, largeDeleteRows: 100 },
    expectedFingerprints: [], ignorePatterns: ['SELECT 1'],
  };
  let saved: DbCaptureSettings[];

  function create() {
    saved = [];
    const project: ProjectCaptureStatus = { project: 'wallet-app', enabled: true, inboundLogging: true, attached: true, logsOn: true };
    TestBed.configureTestingModule({
      imports: [DbCaptureSettingsComponent],
      providers: [
        { provide: DbCaptureApiService, useValue: {
          settings: () => of(settings),
          saveSettings: (_p: string, s: DbCaptureSettings) => { saved.push(s); return of(s); },
        } },
        { provide: DbCaptureStateService, useValue: {
          projects: signal([project]), refreshProjects: () => undefined, switchError: signal(null),
          isOn: () => true, switchTitle: () => '', toggle: () => undefined, logsOn: () => true, logsTitle: () => '', toggleLogs: () => undefined,
        } },
        { provide: RedactionsStore, useValue: { all: signal([]) } },
      ],
    });
    const fixture = TestBed.createComponent(DbCaptureSettingsComponent);
    fixture.detectChanges();
    fixture.detectChanges(); // the settings load from the projects effect
    return fixture;
  }

  it('shows ERROR by default and saves the level picked', () => {
    const fixture = create();
    const select = fixture.nativeElement.querySelector('.db-proj select') as HTMLSelectElement;
    expect(select.value).toBe('ERROR');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'APP']);

    select.value = 'APP';
    select.dispatchEvent(new Event('change'));
    expect(saved.map((s) => s.logLevel)).toEqual(['APP']);
  });

  it('names a level in words', () => {
    expect(logLevelWords(undefined)).toBe('ERROR and above');
    expect(logLevelWords('WARN')).toBe('WARN and above');
    expect(logLevelWords('APP')).toBe("the app's own level");
  });
});
