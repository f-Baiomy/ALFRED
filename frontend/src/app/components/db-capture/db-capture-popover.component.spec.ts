import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { Router } from '@angular/router';
import { DbCapturePopoverComponent } from './db-capture-popover.component';
import { DbCaptureApiService } from '../../core/services/db-capture-api.service';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { DbWindowService } from './db-window.service';
import { ServerSettingsService } from '../../core/services/server-settings.service';
import { DbCaptureSettings } from '../../core/models/db-capture.model';
import { AgentAttach } from '../../core/models/server-settings.model';

describe('DbCapturePopoverComponent - ▤ Log lines', () => {
  const settings: DbCaptureSettings = {
    rowsPerResult: 50000, beforeImageTables: [], outsideCallCapture: true,
    thresholds: { slowMs: 500, hugeRows: 1000, repeatCount: 10, largeDeleteRows: 100 },
    expectedFingerprints: [], ignorePatterns: ['SELECT 1'],
  };

  function create(logsOn: boolean, agentFeatures?: string, attached = true, agents: AgentAttach[] = [], agentVersion?: string) {
    const saved: DbCaptureSettings[] = [];
    const asked: { project: string; features: readonly string[] }[] = [];
    const agent = agentFeatures === undefined ? undefined : { agentId: 'a1', project: 'odeysys', droppedSinceStart: 0, queuedStatements: 0, features: agentFeatures, agentVersion };
    TestBed.configureTestingModule({
      imports: [DbCapturePopoverComponent],
      providers: [
        { provide: DbCaptureApiService, useValue: {
          settings: () => of(settings),
          saveSettings: (_p: string, s: DbCaptureSettings) => { saved.push(s); return of(s); },
        } },
        { provide: DbCaptureStateService, useValue: {
          projectStatus: () => ({ project: 'odeysys', enabled: true, inboundLogging: true, attached, logsOn, agent }),
          switchTitle: () => '', toggle: () => undefined, showChips: signal(true), setShowChips: () => undefined,
          logsOn: () => logsOn,
        } },
        { provide: DbWindowService, useValue: { openOutside: () => undefined } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
        { provide: ServerSettingsService, useValue: {
          status: () => of({ agents }),
          attachAgent: (project: string, features: readonly string[]) => { asked.push({ project, features }); return of({ accepted: true }); },
        } },
      ],
    });
    const fixture = TestBed.createComponent(DbCapturePopoverComponent);
    fixture.componentRef.setInput('project', 'odeysys');
    fixture.detectChanges();
    return { fixture, saved, asked };
  }

  it('shows the Log level - ERROR unless set - and saves the one picked', () => {
    const { fixture, saved } = create(true);
    const picker = fixture.nativeElement.querySelector('.db-pop .db-level') as HTMLElement;
    const button = picker.querySelector('button') as HTMLButtonElement;
    expect(button.textContent!.trim()).toBe('ERROR and above');
    button.click();
    fixture.detectChanges();
    (picker.querySelectorAll('.filter-option-item')[1] as HTMLButtonElement).click();
    expect(saved.map((s) => s.logLevel)).toEqual(['WARN']);
  });

  it('offers the attach mode - When asked unless set - and picking Automatic saves it and asks the supervisor with every feature', () => {
    const { fixture, saved, asked } = create(true);
    const picker = fixture.nativeElement.querySelector('.db-pop .db-attach-mode') as HTMLElement;
    const button = picker.querySelector('button') as HTMLButtonElement;
    expect(button.textContent!.trim()).toContain('When asked');
    button.click();
    fixture.detectChanges();
    const items = Array.from(picker.querySelectorAll('.filter-option-item')) as HTMLButtonElement[];
    expect(items.map((i) => i.textContent!.trim().split(' - ')[0])).toEqual(['When asked', 'Automatic', 'Off']);
    items[1].click();
    expect(saved.map((s) => s.attachMode)).toEqual(['AUTOMATIC']);
    expect(asked).toEqual([{ project: 'odeysys', features: ['proxy', 'db', 'logs', 'redis'] }]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.db-attach-note')!.textContent).toContain('asked');
  });

  it('turning the proxy feature off saves attachProxy=false and re-asks without proxy', () => {
    const { fixture, saved, asked } = create(true);
    const proxy = (fixture.nativeElement as HTMLElement).querySelector('.db-pop .pr input[type=checkbox]') as HTMLInputElement;
    expect(proxy.checked).toBeTrue();
    proxy.dispatchEvent(new Event('change'));
    expect(saved.map((s) => s.attachProxy)).toEqual([false]);
    expect(asked[0].features).toEqual(['db', 'logs', 'redis']);
  });

  it('says when the agent runs without a capture that is switched on here (a proxy-only attach)', () => {
    const { fixture } = create(true, 'proxy');
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('runs proxy');
    expect(text).toContain('◆ database and ▤ log capture is switched on, but the agent');
    expect(text).toContain('start.py --db-capture on');
  });

  it('says nothing about features when the agent runs them all', () => {
    const { fixture } = create(true, 'proxy,db,logs,redis');
    expect((fixture.nativeElement as HTMLElement).querySelector('.db-lacking')).toBeNull();
  });

  it('says nothing about features when the agent is too old to report them', () => {
    const { fixture } = create(true);
    expect((fixture.nativeElement as HTMLElement).querySelector('.db-lacking')).toBeNull();
  });

  it('says why the supervisor could not attach - the app runs as another user than Alfred', () => {
    const why = 'pid 53628 on port 9001 runs as PC\\work, Alfred as PC\\bob: run Alfred as PC\\work or as a service';
    const { fixture } = create(true, undefined, false, [
      { project: 'core-service', port: 9003, pid: 0, state: 'NO_JVM', detail: 'nothing listens on port 9003', at: null, features: '' },
      { project: 'odeysys', port: 9001, pid: 53628, state: 'NOT_A_JVM', detail: why, at: null, features: '' },
    ]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.db-why')!.textContent).toContain(why);
  });

  it('says when the app runs an older agent build than Alfred attaches now - capture works, the new one comes with the next start', () => {
    TestBed.resetTestingModule();
    const { fixture } = create(true, 'proxy,db,logs,redis', true, [
      { project: 'odeysys', port: 9001, pid: 1, state: 'ATTACHED', detail: '', at: null, features: '', jar: 'bbbbbbbbbbbbbbbb' },
    ]);
    expect(fixture.componentInstance.olderAgent()).toBeFalse(); // no digest in its version: an agent from before copies
    TestBed.resetTestingModule();
    const older = create(true, 'proxy,db,logs,redis', true, [
      { project: 'odeysys', port: 9001, pid: 1, state: 'ATTACHED', detail: '', at: null, features: '', jar: 'bbbbbbbbbbbbbbbb' },
    ], '1.0.0+aaaaaaaaaaaaaaaa').fixture;
    older.detectChanges();
    expect((older.nativeElement as HTMLElement).querySelector('.db-older')!.textContent).toContain('older build');
    TestBed.resetTestingModule();
    const same = create(true, 'proxy,db,logs,redis', true, [
      { project: 'odeysys', port: 9001, pid: 1, state: 'ATTACHED', detail: '', at: null, features: '', jar: 'bbbbbbbbbbbbbbbb' },
    ], '1.0.0+bbbbbbbbbbbbbbbb').fixture;
    expect(same.componentInstance.olderAgent()).toBeFalse();
  });

  it('says nothing about the last attempt once the agent is attached', () => {
    const { fixture } = create(true, undefined, true, [
      { project: 'odeysys', port: 9001, pid: 1, state: 'FAILED', detail: 'old failure', at: null, features: '' },
    ]);
    expect((fixture.nativeElement as HTMLElement).querySelector('.db-why')).toBeNull();
  });

  it('dims the row while ▤ is off', () => {
    const { fixture } = create(false);
    const row = (fixture.nativeElement.querySelector('.db-pop .db-level') as HTMLElement).closest('.pr')!;
    expect(row.classList).toContain('dim');
  });
});
