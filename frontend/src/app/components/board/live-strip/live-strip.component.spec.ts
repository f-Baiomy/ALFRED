import { TestBed, discardPeriodicTasks, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AgentStatus, SkillRun } from '../../../core/models/board.models';
import { SkillRunsStateService } from '../../../core/state/skill-runs-state.service';
import { LiveStripComponent, RUNNER_EXPIRY_MS } from './live-strip.component';

const RUN = { id: 'r1', project: 'odeysys', cycleId: 'b1', cardNumber: 72, command: '/alfred-fix 72', state: 'RUNNING',
  createdAt: new Date().toISOString(), takenAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as unknown as SkillRun;

describe('LiveStripComponent (specs/032 D12)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LiveStripComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  });

  function render(lastSeen: string, opts: { runs?: SkillRun[]; status?: AgentStatus | null } = {}) {
    spyOn(TestBed.inject(SkillRunsStateService), 'active').and.returnValue(opts.runs ?? []);
    const f = TestBed.createComponent(LiveStripComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.componentRef.setInput('cycleId', 'b1');
    f.componentRef.setInput('status', opts.status ?? null);
    f.detectChanges();
    TestBed.inject(HttpTestingController).match((r) => r.url.endsWith('/live-runner')).forEach((r) =>
      r.flush({ project: 'odeysys', host: 'LAPTOP', model: null, kind: 'live', startedAt: lastSeen, lastSeen }));
    f.detectChanges();
    return f;
  }

  it('shows nothing on an idle board - no "No chat handles", no "Claude stopped", no answerer line', fakeAsync(() => {
    const stopped = { state: 'STOPPED', callsChecked: 0, cardsAdded: 0, updatedAt: new Date().toISOString(), lastCheckAt: null } as unknown as AgentStatus;
    const f = render(new Date().toISOString(), { status: stopped });
    expect((f.nativeElement as HTMLElement).querySelectorAll('.board-live').length).toBe(0);
    expect(f.nativeElement.textContent.trim()).toBe('');
    f.destroy();
    discardPeriodicTasks();
    flush();
  }));

  it('shows one row with where Claude runs while a run works, with Stop', fakeAsync(() => {
    const f = render(new Date().toISOString(), { runs: [RUN] });
    const rows = (f.nativeElement as HTMLElement).querySelectorAll('.board-live');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Claude on LAPTOP');
    expect(rows[0].textContent).toContain('#72 fix');
    expect(Array.from(rows[0].querySelectorAll('button')).map((b) => b.textContent?.trim())).toContain('Stop');
    f.destroy();
    discardPeriodicTasks();
    flush();
  }));

  it('forgets the runner once it has not beaten for the backend\'s expiry - a killed runner sends no last beat', fakeAsync(() => {
    const f = render(new Date().toISOString(), { runs: [{ ...RUN, state: 'QUEUED' } as SkillRun] });
    expect(f.nativeElement.textContent).toContain('on LAPTOP');
    tick(RUNNER_EXPIRY_MS + 10);
    f.detectChanges();
    expect(f.nativeElement.textContent).not.toContain('on LAPTOP');
    f.destroy();
    discardPeriodicTasks();
    flush();
  }));
});
