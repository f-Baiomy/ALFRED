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
      { id: 'c-1', name: 'Book flow', description: 'A full booking', stepCount: 4, liveCount: 1, lastRun: null, createdAt: null, updatedAt: null, isTransient: false },
    ]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('renders one row per cycle', () => {
    const names = fixture.nativeElement.querySelectorAll('h2');
    expect(names.length).toBe(1);
    expect(names[0].textContent).toContain('Book flow');
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
