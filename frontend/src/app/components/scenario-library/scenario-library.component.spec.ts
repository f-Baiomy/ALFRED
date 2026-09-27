import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { ScenarioLibraryComponent } from './scenario-library.component';
import { Scenario } from '../../shared/utils/scenario-types';

const scenario: Scenario = { id: 's1', name: 'Book flow', description: '', createdAt: '', updatedAt: '', lastRun: { total: 3, passed: 2, failed: 1, errored: 0 } };

describe('ScenarioLibraryComponent', () => {
  let fixture: ComponentFixture<ScenarioLibraryComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScenarioLibraryComponent],
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ScenarioLibraryComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('http://backend/scenarios').flush([scenario]);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('lists a scenario with its last-run summary', () => {
    expect(fixture.nativeElement.textContent).toContain('Book flow');
    expect(fixture.nativeElement.textContent).toContain('2/3 passed');
  });

  it('opening a scenario fetches its full definition and emits it', () => {
    let opened: Scenario | null = null;
    fixture.componentInstance.opened.subscribe((s: Scenario) => (opened = s));
    (fixture.nativeElement.querySelector('.scenario-library-open') as HTMLButtonElement).click();
    const req = http.expectOne('http://backend/scenarios/s1');
    req.flush({ ...scenario, definition: { version: 1, drafts: [], groups: {}, settings: { delayMs: 0, stopOnFailure: false, useCurrentSession: false, maxParallel: null, retry: null }, datasets: {} } });
    expect(opened).toBeTruthy();
  });
});
