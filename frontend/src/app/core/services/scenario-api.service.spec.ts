import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { ScenarioApiService } from './scenario-api.service';
import { Scenario, ScenarioDefinition } from '../../shared/utils/scenario-types';

const definition: ScenarioDefinition = {
  version: 1,
  drafts: [],
  groups: {},
  settings: { delayMs: 0, stopOnFailure: false, useCurrentSession: false, maxParallel: null, retry: null },
  datasets: {},
};

describe('ScenarioApiService', () => {
  let service: ScenarioApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    service = TestBed.inject(ScenarioApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('list() GETs /scenarios', () => {
    service.list().subscribe();
    const req = http.expectOne('http://backend/scenarios');
    expect(req.request.method).toBe('GET');
    req.flush([]);
  });

  it('get() GETs one scenario', () => {
    service.get('s1').subscribe();
    const req = http.expectOne('http://backend/scenarios/s1');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 's1' } as Scenario);
  });

  it('create() POSTs name/description/definition', () => {
    service.create({ name: 'Book flow', description: '', definition }).subscribe();
    const req = http.expectOne('http://backend/scenarios');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ name: 'Book flow', description: '', definition });
    req.flush({ id: 's1' } as Scenario);
  });

  it('update() PUTs to the scenario id', () => {
    service.update('s1', { name: 'Book flow 2', definition }).subscribe();
    const req = http.expectOne('http://backend/scenarios/s1');
    expect(req.request.method).toBe('PUT');
    req.flush({ id: 's1' } as Scenario);
  });

  it('delete() DELETEs the scenario id', () => {
    service.delete('s1').subscribe();
    const req = http.expectOne('http://backend/scenarios/s1');
    expect(req.request.method).toBe('DELETE');
    req.flush(null);
  });

  it('listRuns()/getRun()/createRun() hit the runs sub-resource', () => {
    service.listRuns('s1').subscribe();
    expect(http.expectOne('http://backend/scenarios/s1/runs').request.method).toBe('GET');

    service.getRun('s1', 'r1').subscribe();
    expect(http.expectOne('http://backend/scenarios/s1/runs/r1').request.method).toBe('GET');

    service.createRun('s1', {
      startedAt: 'now', finishedAt: 'now', summary: { total: 0, passed: 0, failed: 0, errored: 0 },
    }).subscribe();
    const createReq = http.expectOne('http://backend/scenarios/s1/runs');
    expect(createReq.request.method).toBe('POST');
    createReq.flush({ id: 'r1', scenarioId: 's1' } as ScenarioRunStub);
  });
});

interface ScenarioRunStub {
  id: string;
  scenarioId: string;
}
