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

  it('upsert() PUTs to the per-name endpoint, URL-encoding the name', () => {
    service.upsert('a-b', 'one');
    expect(service.state().variables['a-b']).toBe('one');
    const req = http.expectOne('http://backend/settings/variables/a-b');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ value: 'one' });
    req.flush({ variables: { 'a-b': 'one' }, fallbacks: {} });
    expect(service.state().variables['a-b']).toBe('one');
    expect(service.saving()).toBeFalse();
  });

  it('remove() DELETEs the per-name endpoint with no query when there is no fallback', () => {
    service.upsert('name', 'value');
    http.expectOne('http://backend/settings/variables/name').flush({ variables: { name: 'value' }, fallbacks: {} });
    service.remove('name', null);
    const req = http.expectOne('http://backend/settings/variables/name');
    expect(req.request.method).toBe('DELETE');
    req.flush({ variables: {}, fallbacks: {} });
    expect(service.resolve('{{name}}')).toBe('{{name}}');
  });

  it('remove() DELETEs with a ?fallback= query when a replacement is given', () => {
    service.upsert('name', 'value');
    http.expectOne('http://backend/settings/variables/name').flush({ variables: { name: 'value' }, fallbacks: {} });
    service.remove('name', 'custom text');
    const req = http.expectOne('http://backend/settings/variables/name?fallback=custom%20text');
    expect(req.request.method).toBe('DELETE');
    req.flush({ variables: {}, fallbacks: { name: 'custom text' } });
    expect(service.resolve('before {{name}} after')).toBe('before custom text after');
  });

  it('queues rapid edits to the same name and sends them strictly in order', () => {
    service.upsert('name', 'one');
    const first = http.expectOne('http://backend/settings/variables/name');
    expect(first.request.body).toEqual({ value: 'one' });
    service.upsert('name', 'two');
    expect(service.state().variables['name']).toBe('two');
    // The second op isn't sent until the first's response comes back.
    expect(http.match('http://backend/settings/variables/name').length).toBe(0);
    first.flush({ variables: { name: 'one' }, fallbacks: {} });
    const second = http.expectOne('http://backend/settings/variables/name');
    expect(second.request.body).toEqual({ value: 'two' });
    second.flush({ variables: { name: 'two' }, fallbacks: {} });
    expect(service.state().variables['name']).toBe('two');
    expect(service.saving()).toBeFalse();
  });

  it('re-bases a still-queued edit onto a fresh response instead of losing it', () => {
    service.upsert('name', 'one');
    const first = http.expectOne('http://backend/settings/variables/name');
    service.upsert('name', 'two');
    // The response reports an unrelated promotion alongside the applied edit.
    first.flush({ variables: { name: 'one', promoted: 'new' }, fallbacks: {} });
    expect(service.state().variables['promoted']).toBe('new');
    expect(service.state().variables['name']).toBe('two');
    http.expectOne('http://backend/settings/variables/name').flush({ variables: { name: 'two', promoted: 'new' }, fallbacks: {} });
  });

  it('a queue failure sets an error and retry() resends the same queued op', () => {
    service.upsert('name', 'one');
    const req = http.expectOne('http://backend/settings/variables/name');
    req.flush('unavailable', { status: 503, statusText: 'unavailable' });
    expect(service.error()).toContain('Could not save');
    expect(service.state().variables['name']).toBe('one');
    service.retry();
    const retried = http.expectOne('http://backend/settings/variables/name');
    expect(retried.request.body).toEqual({ value: 'one' });
    retried.flush({ variables: { name: 'one' }, fallbacks: {} });
    expect(service.error()).toBe('');
  });

  it('a refetch while an op is held after failure keeps the unsent edit visible', () => {
    service.load();
    http.expectOne('http://backend/settings/variables').flush({ variables: {}, fallbacks: {} });
    service.upsert('name', 'mine');
    http.expectOne('http://backend/settings/variables/name').flush('down', { status: 503, statusText: 'down' });
    service.refresh();
    http.expectOne('http://backend/settings/variables').flush({ variables: { promoted: 'new' }, fallbacks: {} });
    expect(service.state().variables['promoted']).toBe('new');
    expect(service.state().variables['name']).toBe('mine');
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

  it('refresh() refetches even after a load', () => {
    service.load();
    http.expectOne('http://backend/settings/variables').flush({ variables: { name: 'one' }, fallbacks: {} });
    service.refresh();
    http.expectOne('http://backend/settings/variables').flush({ variables: { name: 'two' }, fallbacks: {} });
    expect(service.state().variables['name']).toBe('two');
  });

  it('refresh() during a save waits for the save, then refetches', () => {
    service.load();
    http.expectOne('http://backend/settings/variables').flush({ variables: {}, fallbacks: {} });
    service.upsert('name', 'mine');
    const put = http.expectOne('http://backend/settings/variables/name');
    service.refresh();
    expect(service.loading()).toBe(false);
    put.flush({ variables: { name: 'mine' }, fallbacks: {} });
    http.expectOne('http://backend/settings/variables').flush({ variables: { name: 'mine', promoted: 'new' }, fallbacks: {} });
    expect(service.state().variables['promoted']).toBe('new');
    expect(service.state().variables['name']).toBe('mine');
  });

  it('save() still PUTs the full state, for callers that need bulk replace', () => {
    service.save({ variables: { name: 'one' }, fallbacks: {} });
    const req = http.expectOne('http://backend/settings/variables');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ variables: { name: 'one' }, fallbacks: {} });
    req.flush({ variables: { name: 'one' }, fallbacks: {} });
    expect(service.state().variables['name']).toBe('one');
  });
});
