import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { AppConfigService } from '../../core/services/app-config.service';
import { ConfirmDialogService } from '../../core/services/confirm-dialog.service';
import { ReliveListComponent } from './relive-list.component';

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
});
