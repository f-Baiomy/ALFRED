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
    const picker = fixture.nativeElement.querySelector('.db-proj .db-level') as HTMLElement;
    const button = picker.querySelector('button') as HTMLButtonElement;
    expect(button.textContent!.trim()).toBe('ERROR and above');
    button.click();
    fixture.detectChanges();
    const items = Array.from(picker.querySelectorAll('.filter-option-item')) as HTMLButtonElement[];
    expect(items.map((i) => i.textContent!.trim())).toEqual(['ERROR and above', 'WARN and above', 'INFO and above', 'DEBUG and above',
      'TRACE (everything)', "App's level - whatever the app writes"]);
    items[5].click();
    expect(saved.map((s) => s.logLevel)).toEqual(['APP']);
  });

  it('names a level in words', () => {
    expect(logLevelWords(undefined)).toBe('ERROR and above');
    expect(logLevelWords('WARN')).toBe('WARN and above');
    expect(logLevelWords('APP')).toBe("the app's own level");
  });
});
