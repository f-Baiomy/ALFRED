import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DbCaptureStateService } from '../../core/state/db-capture-state.service';
import { EXTERNAL_SOURCE_KEY } from '../../shared/utils/call-utils';
import { SourcesBarComponent } from './sources-bar.component';

describe('SourcesBarComponent', () => {
  const db = {
    switchError: signal<string | null>(null),
    isOn: (_p: string, inbound: boolean) => inbound,
    logsOn: () => false,
    redisOn: () => false,
    switchTitle: () => 'SQL',
    logsTitle: () => 'Logs',
    redisTitle: () => 'Redis',
    toggle: jasmine.createSpy('toggle'),
    toggleLogs: jasmine.createSpy('toggleLogs'),
    toggleRedis: jasmine.createSpy('toggleRedis'),
  };

  beforeEach(() => {
    db.toggle.calls.reset();
    db.toggleLogs.calls.reset();
    db.toggleRedis.calls.reset();
  });

  function render(selected: string[]) {
    TestBed.configureTestingModule({ providers: [{ provide: DbCaptureStateService, useValue: db }] });
    const fixture = TestBed.createComponent(SourcesBarComponent);
    fixture.componentRef.setInput('selected', new Set(selected));
    fixture.componentRef.setInput('featureEnabled', true);
    fixture.componentRef.setInput('internalServices', [
      { name: 'odeysys', listenPort: 3001, upstreamPort: 8080, enabled: true },
      { name: 'unknown', listenPort: null, upstreamPort: null, enabled: false },
    ]);
    fixture.detectChanges();
    return fixture;
  }

  it('shows each source as a checkbox chip with read-only capture tags, and clicking it only filters', () => {
    const fixture = render([EXTERNAL_SOURCE_KEY, 'odeysys']);
    const el = fixture.nativeElement as HTMLElement;
    const chips = Array.from(el.querySelectorAll<HTMLButtonElement>('.source-chip'));
    expect(chips.map((c) => c.classList.contains('on'))).toEqual([true, true, false]);
    expect(Array.from(chips[1].querySelectorAll('.source-cap')).map((t) => [t.textContent, t.classList.contains('on')]))
      .toEqual([['IN', true], ['SQL', true], ['LOG', false], ['RDS', false]]);
    expect(chips[2].querySelectorAll('.source-cap').length).toBe(1); // "unknown" only has inbound

    const toggled: string[] = [];
    fixture.componentInstance.toggleSource.subscribe((k) => toggled.push(k));
    chips[2].click();
    expect(toggled).toEqual(['unknown']);
    expect(db.toggle).not.toHaveBeenCalled();
  });

  it('opens the Capture table, whose switches change capture, and closes it on a click outside', () => {
    const fixture = render([EXTERNAL_SOURCE_KEY]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.capture-pop')).toBeNull();
    el.querySelector<HTMLButtonElement>('.capture-btn')!.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('.capture-table tbody tr').length).toBe(2);

    const logging: unknown[] = [];
    fixture.componentInstance.toggleLogging.subscribe((e) => logging.push(e));
    el.querySelector<HTMLButtonElement>('.capture-sw.in')!.click();
    el.querySelector<HTMLButtonElement>('.capture-sw.sql')!.click();
    expect(logging).toEqual([{ name: 'odeysys', enabled: false }]);
    expect(db.toggle).toHaveBeenCalledWith('odeysys', true);

    document.body.click();
    fixture.detectChanges();
    expect(el.querySelector('.capture-pop')).toBeNull();
  });
});
