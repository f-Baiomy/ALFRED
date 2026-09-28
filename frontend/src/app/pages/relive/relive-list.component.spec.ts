import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router } from '@angular/router';
import { AppConfigService } from '../../core/services/app-config.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveListComponent } from './relive-list.component';
import { Step } from '../../shared/utils/relive-types';
import { SessionCyclesStateService } from '../../core/state/session-cycles-state.service';

describe('ReliveListComponent', () => {
  let fixture: ComponentFixture<ReliveListComponent>;
  let http: HttpTestingController;
  let confirmDialog: ConfirmDialogService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ReliveListComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
        { provide: SessionCyclesStateService, useValue: { cycles: () => [] } },
      ],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
    confirmDialog = TestBed.inject(ConfirmDialogService);
    fixture = TestBed.createComponent(ReliveListComponent);
    fixture.detectChanges();

    // The state service's constructor already issued the initial list() call.
    http.expectOne('http://backend/relive-cycles').flush([
      { id: 'c-1', name: 'Book flow', description: 'A full booking', stepCount: 4, childCount: 3, liveCount: 1, cycleRuleCount: 1, lastRun: null, createdAt: null, updatedAt: null, isTransient: false },
    ]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('renders one row per cycle', () => {
    const names = fixture.nativeElement.querySelectorAll('h2');
    expect(names.length).toBe(1);
    expect(names[0].textContent).toContain('Book flow');
  });

  it('shows the step hierarchy, live state, and cycle rule count', () => {
    const card: HTMLElement = fixture.nativeElement.querySelector('.rl-cyc');
    expect(card.textContent).toContain('1 step · 3 children');
    expect(card.textContent).toContain('1 LIVE external');
    expect(card.textContent).toContain('1 cycle rule');
  });

  it('keeps multiple cycles in separate cards and shows the replay state', () => {
    fixture.componentInstance.state.load();
    http.expectOne('http://backend/relive-cycles').flush([
      { id: 'c-1', name: 'Book flow', stepCount: 4, childCount: 3, liveCount: 1, cycleRuleCount: 1, lastRun: null, isTransient: false },
      { id: 'c-2', name: 'Hotel search', stepCount: 4, childCount: 0, liveCount: 0, cycleRuleCount: 0, lastRun: null, isTransient: false },
    ]);
    fixture.detectChanges();
    const cards: NodeListOf<HTMLElement> = fixture.nativeElement.querySelectorAll('.rl-cyc');
    expect(cards.length).toBe(2);
    expect(cards[1].textContent).toContain('all REPLAY');
    expect(cards[1].textContent).toContain('0 cycle rules');
  });

  it('asks for confirmation before deleting, and only calls DELETE once confirmed', () => {
    const confirmSpy = spyOn(confirmDialog, 'confirm').and.returnValue(Promise.resolve(true));

    const deleteBtn: HTMLButtonElement = fixture.nativeElement.querySelector('.rl-danger');
    deleteBtn.click();

    expect(confirmSpy).toHaveBeenCalled();
  });

  it('does not delete when the user declines the confirmation', async () => {
    spyOn(confirmDialog, 'confirm').and.returnValue(Promise.resolve(false));

    const deleteBtn: HTMLButtonElement = fixture.nativeElement.querySelector('.rl-danger');
    deleteBtn.click();
    await fixture.whenStable();

    http.expectNone('http://backend/relive-cycles/c-1');
    expect().nothing();
  });

  it('opens call selection without creating an empty cycle, and cancel leaves nothing', () => {
    const newButton: HTMLButtonElement = fixture.nativeElement.querySelector('.rl-primary');
    newButton.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.newCycleOpen()).toBeTrue();
    expect(fixture.nativeElement.textContent).toContain('Add calls to this cycle');
    http.expectNone((request) => request.method === 'POST' && request.url === 'http://backend/relive-cycles');
    const cancel: HTMLButtonElement = fixture.nativeElement.querySelector('.dialog-btn.secondary');
    cancel.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.newCycleOpen()).toBeFalse();
    http.expectNone((request) => request.method === 'POST' && request.url === 'http://backend/relive-cycles');
  });

  it('creates the new cycle with the selected steps', () => {
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    const step: Step = {
      key: 'selected-step', parentKey: null, label: 'POST /search', enabled: true, optional: false, direction: 'inbound',
      callRule: { name: 'replay', match: {}, actions: [] }, unattributed: 'BLOCK',
      recording: { method: 'POST', url: 'http://app/search', requestHeaders: {}, status: 200, responseHeaders: {}, timestamp: '2026-01-01', durationMs: 1, source: 'inbound' },
      source: { callId: 'call-1', cycleId: 'sc-1', direction: 'inbound' }, extract: [], assertions: [], noise: [],
    };
    fixture.componentInstance.createFromSteps([step]);
    const request = http.expectOne('http://backend/relive-cycles');
    expect(request.request.method).toBe('POST');
    expect(request.request.body.steps[0].callRule).toEqual({ rule: step.callRule, copiedFrom: null });
    request.flush({ id: 'new-cycle' });
    http.expectOne('http://backend/relive-cycles').flush([]);
  });
});
