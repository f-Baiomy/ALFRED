import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { ScenarioToolbarComponent } from './scenario-toolbar.component';
import { BulkResendDialogService } from '../../core/services/bulk-resend-dialog.service';

describe('ScenarioToolbarComponent', () => {
  let fixture: ComponentFixture<ScenarioToolbarComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScenarioToolbarComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ScenarioToolbarComponent);
    fixture.detectChanges();
    http.expectNone('http://backend/scenarios'); // scenario-library isn't shown yet, so nothing should have fetched
  });

  it('renders the core actions', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Save as scenario');
    expect(text).toContain('Open…');
  });

  it('does not show a bare Save button until a scenario is loaded', () => {
    const buttons: HTMLButtonElement[] = Array.from(fixture.nativeElement.querySelectorAll('button'));
    expect(buttons.some((b) => b.textContent?.trim() === 'Save')).toBeFalse();
  });

  it('openSaveAs shows the Save-as dialog', () => {
    fixture.componentInstance.openSaveAs();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.dialog-card')).toBeTruthy();
  });

  it('saves the current resend settings and clears the loaded scenario for a new selection', () => {
    const dialog = TestBed.inject(BulkResendDialogService);
    dialog.start([]);
    dialog.delayMs.set(250);
    dialog.stopOnFailure.set(false);
    fixture.componentInstance.saveAsName.set('Checkout');
    fixture.componentInstance.confirmSaveAs();
    const create = http.expectOne('http://backend/scenarios');
    expect(create.request.body.definition.settings).toEqual(jasmine.objectContaining({ delayMs: 250, stopOnFailure: false }));
    create.flush({ id: 's1', name: 'Checkout', description: '', createdAt: '', updatedAt: '', lastRun: null });
    expect(fixture.componentInstance.loadedScenario()?.id).toBe('s1');
    dialog.start([]);
    fixture.detectChanges();
    expect(fixture.componentInstance.loadedScenario()).toBeNull();
  });

  it('opening the library lazily fetches the scenario list', () => {
    fixture.componentInstance.openLibrary();
    fixture.detectChanges();
    const req = http.expectOne('http://backend/scenarios');
    req.flush([]);
  });

  it('run history is a no-op without a loaded scenario', () => {
    fixture.componentInstance.openRunHistory();
    expect(fixture.componentInstance.runHistoryOpen()).toBeFalse();
  });

  it('run history fetches the run list then every run in full, for the compare view', () => {
    (fixture.componentInstance.loadedScenario as unknown as { set: (v: unknown) => void }).set({ id: 's1', name: 'Book flow', description: '', createdAt: '', updatedAt: '', lastRun: null });
    fixture.componentInstance.openRunHistory();
    const listReq = http.expectOne('http://backend/scenarios/s1/runs');
    listReq.flush([{ id: 'r1', scenarioId: 's1', startedAt: 't1', finishedAt: 't1', summary: { total: 1, passed: 1, failed: 0, errored: 0 } }]);
    const detailReq = http.expectOne('http://backend/scenarios/s1/runs/r1');
    detailReq.flush({ id: 'r1', scenarioId: 's1', startedAt: 't1', finishedAt: 't1', summary: { total: 1, passed: 1, failed: 0, errored: 0 }, results: { draftResults: [], assertionResults: {} } });
    expect(fixture.componentInstance.runs().length).toBe(1);
    expect(fixture.componentInstance.runsLoading()).toBeFalse();
  });
});
