import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../services/app-config.service';
import { TeamApiService } from './team-api.service';
import { TeamTokenStore } from './team-token.store';

/** specs/027 R10: the viewer's token rides only on the calls that reach the provider (refresh, history). */
describe('TeamApiService', () => {
  let http: HttpTestingController;
  let api: TeamApiService;
  let tokens: TeamTokenStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: 'http://alfred' } }],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(TeamApiService);
    tokens = TestBed.inject(TeamTokenStore);
    tokens.set('c1', 'secret-pat');
    tokens.setWho('Sara');
  });

  afterEach(() => {
    tokens.clear('c1');
    http.verify();
  });

  it('sends the token and the name on refresh and on history', () => {
    api.refresh('c1').subscribe();
    const r = http.expectOne('http://alfred/teamboards/connections/c1/refresh');
    expect(r.request.headers.get('X-Alfred-Team-Token')).toBe('secret-pat');
    expect(r.request.headers.get('X-Alfred-Team-Who')).toBe('Sara');
    r.flush({ changed: 0, fetchedAt: '' });

    api.revisions('c1', '7', true).subscribe();
    const h = http.expectOne((req) => req.url === 'http://alfred/teamboards/items/c1/7/revisions');
    expect(h.request.headers.get('X-Alfred-Team-Token')).toBe('secret-pat');
    expect(h.request.params.get('fetch')).toBe('true');
    h.flush([]);
  });

  it('never sends the token on reads of the cache or on settings writes', () => {
    api.items('c1', { q: 'refund', squad: '' }).subscribe();
    const i = http.expectOne((req) => req.url === 'http://alfred/teamboards/connections/c1/items');
    expect(i.request.headers.has('X-Alfred-Team-Token')).toBeFalse();
    expect(i.request.params.get('q')).toBe('refund');
    expect(i.request.params.has('squad')).toBeFalse();
    i.flush({ items: [], total: 0 });

    api.item('c1', '7').subscribe();
    expect(http.expectOne('http://alfred/teamboards/items/c1/7').request.headers.has('X-Alfred-Team-Token')).toBeFalse();

    api.createConnection({ kind: 'azure', name: 'X', baseUrl: 'https://dev.azure.com/x', scope: { projects: [], teams: [] } }).subscribe();
    const c = http.expectOne('http://alfred/teamboards/connections');
    expect(c.request.headers.has('X-Alfred-Team-Token')).toBeFalse();
    expect(JSON.stringify(c.request.body)).not.toContain('secret-pat');
  });
});
