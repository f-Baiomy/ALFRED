import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { ScenarioStateService } from './scenario-state.service';

describe('ScenarioStateService', () => {
  let service: ScenarioStateService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    service = TestBed.inject(ScenarioStateService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('load() fetches once and sets loaded/scenarios', () => {
    service.load();
    const req = http.expectOne('http://backend/scenarios');
    req.flush([{ id: 's1', name: 'A', description: '', createdAt: '', updatedAt: '', lastRun: null }]);
    expect(service.loaded()).toBeTrue();
    expect(service.scenarios().length).toBe(1);
  });

  it('load() again does nothing once loaded', () => {
    service.load();
    http.expectOne('http://backend/scenarios').flush([]);
    service.load();
    http.expectNone('http://backend/scenarios');
  });

  it('refresh() always re-fetches', () => {
    service.load();
    http.expectOne('http://backend/scenarios').flush([]);
    service.refresh();
    http.expectOne('http://backend/scenarios').flush([]);
  });

  it('remove() deletes then refetches', () => {
    service.load();
    http.expectOne('http://backend/scenarios').flush([]);
    service.remove('s1');
    http.expectOne('http://backend/scenarios/s1').flush(null);
    http.expectOne('http://backend/scenarios').flush([]);
  });

  it('sets an error message when the fetch fails', () => {
    service.load();
    http.expectOne('http://backend/scenarios').flush('boom', { status: 500, statusText: 'Server Error' });
    expect(service.error()).toContain('Could not load');
  });
});
