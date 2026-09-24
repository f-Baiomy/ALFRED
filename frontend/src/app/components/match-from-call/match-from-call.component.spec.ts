import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AppConfigService } from '../../core/services/app-config.service';
import { MatchForm } from '../../shared/utils/match-from-call';
import { MatchFillResult, MatchFromCallComponent } from './match-from-call.component';

const BACKEND = 'http://backend.test:5000';

describe('MatchFromCallComponent', () => {
  let fixture: ComponentFixture<MatchFromCallComponent>;
  let component: MatchFromCallComponent;
  let http: HttpTestingController;
  let applied: MatchFillResult[];

  const summary = { id: 'c1', original_url: 'https://api.sabre.com/v2/order/88123?mode=x', url: 'https://api.sabre.com/v2/order/88123?mode=x', method: 'POST', timestamp: 't', duration_ms: 1, status: 200 };
  const current: MatchForm = { source: 'both', serviceNames: [], host: '', pathContains: '/old', pathRegex: '', methods: [], tests: [] };

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MatchFromCallComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MatchFromCallComponent);
    component = fixture.componentInstance;
    applied = [];
    component.applied.subscribe((r) => applied.push(r));
    fixture.componentRef.setInput('current', current);
  });

  afterEach(() => http.verify({ ignoreCancelled: true }));

  function flushState(): void {
    for (const url of ['rules', 'paused', 'enabled', 'sensitive-headers', 'action-types']) {
      http.match(`${BACKEND}/interception/${url}`).forEach((r) => r.flush(url === 'sensitive-headers' ? { names: ['authorization'] } : url === 'enabled' ? { enabled: true } : []));
    }
  }

  function openPreloaded(): void {
    fixture.componentRef.setInput('preload', { ref: { source: 'external', callId: 'c1', cycleId: 'cy1' }, call: summary });
    fixture.detectChanges();
    flushState();
    http.expectOne(`${BACKEND}/session-cycles/cy1/calls/c1/detail`).flush({
      request: { headers: { SOAPAction: '"Confirm"', Authorization: 'Bearer x', 'Content-Length': '3' } },
      response: { status: 200 },
    });
    fixture.detectChanges();
  }

  it('opens a call picked on another tab at "choose and adjust", tests unchecked, and fills the match', () => {
    openPreloaded();
    expect(component.where()).toBe('a session cycle');
    expect(component.choices()?.tests.map((t) => `${t.name}:${t.on}`)).toEqual(['SOAPAction:false', 'Authorization:false', 'mode:false']);
    expect(fixture.nativeElement.textContent).toContain('contains /old');

    component.apply();
    expect(applied[0].fill).toEqual({ source: 'outbound', host: 'api.sabre.com', pathContains: '/v2/order/88123', pathRegex: '', methods: ['POST'], tests: [] });
    expect(applied[0].label).toBe('POST api.sabre.com/v2/order/88123');
  });

  it('switches host and path variants, and editing a test checks it', () => {
    openPreloaded();
    component.setHost('*.sabre.com');
    const regex = component.pathOptions().findIndex((o) => o.label.startsWith('regex'));
    component.choosePath(String(regex));
    const soap = component.choices()!.tests.findIndex((t) => t.name === 'SOAPAction');
    component.editTest(soap, { operator: 'CONTAINS', value: 'Confirm' });

    component.apply();
    expect(applied[0].fill.host).toBe('*.sabre.com');
    expect(applied[0].fill.pathRegex).toBe('^/v\\d+/order/\\d+(?:\\?|$)');
    expect(applied[0].fill.pathContains).toBe('');
    expect(applied[0].fill.tests).toEqual([{ kind: 'headers', name: 'SOAPAction', operator: 'CONTAINS', value: 'Confirm' }]);
  });

  it('offers a secret like any test - "equals" its value - tagged, and copies the value once checked', () => {
    openPreloaded();
    const i = component.choices()!.tests.findIndex((t) => t.name === 'Authorization');
    const auth = component.choices()!.tests[i];
    expect(auth.secret).toBeTrue();
    expect(auth.operator).toBe('EQUALS');
    expect(component.needsValue(auth)).toBeTrue();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cfc-secret')).not.toBeNull();

    component.patchTest(i, { on: true });
    component.apply();
    expect(applied[0].fill.tests).toEqual([{ kind: 'headers', name: 'Authorization', operator: 'EQUALS', value: 'Bearer x' }]);
  });
});
