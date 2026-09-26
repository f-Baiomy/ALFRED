import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from './app-config.service';
import { GlobalVariablesService } from './global-variables.service';

describe('GlobalVariablesService', () => {
  let service: GlobalVariablesService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: AppConfigService, useValue: { backendUrl: 'http://backend' } },
      ],
    });
    service = TestBed.inject(GlobalVariablesService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('serializes rapid edits and keeps the newest value visible', () => {
    service.upsert('name', 'one');
    const first = http.expectOne('http://backend/settings/variables');
    expect(first.request.method).toBe('PUT');
    service.upsert('name', 'two');
    expect(service.state().variables['name']).toBe('two');
    expect(http.match('http://backend/settings/variables').length).toBe(0);
    first.flush({ variables: { name: 'one' }, fallbacks: {} });
    const second = http.expectOne('http://backend/settings/variables');
    expect(second.request.body.variables['name']).toBe('two');
    second.flush({ variables: { name: 'two' }, fallbacks: {} });
    expect(service.state().variables['name']).toBe('two');
    expect(service.saving()).toBeFalse();
  });

  it('keeps authored tokens visible after delete and applies the selected fallback', () => {
    service.upsert('name', 'value');
    http.expectOne('http://backend/settings/variables').flush({ variables: { name: 'value' }, fallbacks: {} });
    service.remove('name', 'custom text');
    http.expectOne('http://backend/settings/variables').flush({ variables: {}, fallbacks: { name: 'custom text' } });
    expect(service.resolve('before {{name}} after')).toBe('before custom text after');
    expect(service.resolve('{{missing}}')).toBe('{{missing}}');
  });

  it('retries a failed initial load', () => {
    service.load();
    http.expectOne('http://backend/settings/variables').flush('unavailable', { status: 503, statusText: 'unavailable' });
    expect(service.error()).toContain('Could not load');
    service.retry();
    http.expectOne('http://backend/settings/variables').flush({ variables: { name: 'value' }, fallbacks: {} });
    expect(service.state().variables['name']).toBe('value');
    expect(service.error()).toBe('');
  });
});
