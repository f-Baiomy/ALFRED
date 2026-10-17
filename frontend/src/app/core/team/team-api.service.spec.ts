import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../services/app-config.service';
import { TeamApiService } from './team-api.service';

/** specs/028 FR-001: the token goes to Alfred once, in a PUT body; no other call carries it, and the browser keeps none. */
describe('TeamApiService', () => {
  let http: HttpTestingController;
  let api: TeamApiService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: 'http://alfred' } }],
    });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(TeamApiService);
  });

  afterEach(() => http.verify());

  it('puts the token in the body of the token PUT only', () => {
    api.putToken('c1', 'secret-pat').subscribe();
    const t = http.expectOne('http://alfred/teamboards/connections/c1/token');
    expect(t.request.method).toBe('PUT');
    expect(t.request.body).toEqual({ token: 'secret-pat' });
    t.flush({ live: true, owner: null, expiresAt: null });

    api.search('c1', { text: 'refund' }).subscribe();
    const s = http.expectOne('http://alfred/teamboards/connections/c1/search');
    expect(s.request.method).toBe('POST');
    expect(s.request.headers.has('X-Alfred-Team-Token')).toBeFalse();
    expect(JSON.stringify(s.request.body)).not.toContain('secret-pat');
    s.flush({ items: [], total: 0, fullText: true, page: 0, pageSize: 50 });
  });

  it('keeps nothing in browser storage', () => {
    const before = { local: localStorage.length, session: sessionStorage.length };
    api.putToken('c1', 'secret-pat').subscribe();
    http.expectOne('http://alfred/teamboards/connections/c1/token').flush({ live: true, owner: null, expiresAt: null });
    expect(localStorage.length).toBe(before.local);
    expect(sessionStorage.length).toBe(before.session);
    for (let i = 0; i < localStorage.length; i++) expect(localStorage.getItem(localStorage.key(i)!) ?? '').not.toContain('secret-pat');
  });

  it('reads an item with what to include, and a direct change as PATCH', () => {
    api.item('c1', '7', 'history').subscribe();
    const i = http.expectOne((r) => r.url === 'http://alfred/teamboards/connections/c1/items/7');
    expect(i.request.params.get('include')).toBe('history');
    i.flush({});

    api.direct('c1', '7', { state: 'Resolved' }).subscribe();
    const d = http.expectOne('http://alfred/teamboards/connections/c1/items/7');
    expect(d.request.method).toBe('PATCH');
    d.flush({});
  });
});
