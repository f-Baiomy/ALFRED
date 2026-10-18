import { TestBed, discardPeriodicTasks, fakeAsync, flush, tick } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { LiveStripComponent, RUNNER_EXPIRY_MS } from './live-strip.component';

describe('LiveStripComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LiveStripComponent], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  });

  function render(lastSeen: string) {
    const f = TestBed.createComponent(LiveStripComponent);
    f.componentRef.setInput('project', 'odeysys');
    f.detectChanges();
    const http = TestBed.inject(HttpTestingController);
    http.match((r) => r.url.endsWith('/live-runner')).forEach((r) =>
      r.flush({ project: 'odeysys', host: 'LAPTOP', model: null, kind: 'live', startedAt: lastSeen, lastSeen }));
    f.detectChanges();
    return f;
  }

  it('stops saying "Answering you" once the runner has not beaten for the backend\'s expiry - a killed runner sends no last beat', fakeAsync(() => {
    const f = render(new Date().toISOString());
    expect(f.nativeElement.textContent).toContain('Answering you');

    tick(RUNNER_EXPIRY_MS + 10);
    f.detectChanges();
    expect(f.nativeElement.textContent).not.toContain('Answering you');
    f.destroy();
    discardPeriodicTasks();
    flush();
  }));

  it('never shows a runner whose last beat is already too old', fakeAsync(() => {
    const f = render(new Date(Date.now() - RUNNER_EXPIRY_MS - 1000).toISOString());
    expect(f.nativeElement.textContent).not.toContain('Answering you');
    f.destroy();
    discardPeriodicTasks();
    flush();
  }));
});
