import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppConfigService } from '../services/app-config.service';
import { ProjectCaptureStatus } from '../models/db-capture.model';
import { DbCaptureStateService } from './db-capture-state.service';

const BACKEND = 'http://localhost:1';

const project = (name: string, enabled: boolean, inboundLogging = true): ProjectCaptureStatus => ({
  project: name, enabled, inboundLogging, attached: true, agent: null,
});

/**
 * One switch, three places: the Sources bar, the cycle widget and Settings all read DbCaptureStateService, so a
 * capture-settings-changed message from any of them (or another user) refreshes all three at once.
 */
describe('DbCaptureStateService', () => {
  let service: DbCaptureStateService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AppConfigService, useValue: { backendUrl: BACKEND } }],
    });
    service = TestBed.inject(DbCaptureStateService);
    http = TestBed.inject(HttpTestingController);
    http.expectOne(`${BACKEND}/db-capture/projects`).flush([project('wallet-app', false), project('core-service', false, false)]);
  });

  it('does nothing while inbound logging is off, and says why', () => {
    service.toggle('core-service', false);
    http.expectNone(`${BACKEND}/db-capture/projects/core-service/enabled`);
    expect(service.isOn('core-service', false)).toBeFalse();
    expect(service.switchTitle('core-service', false)).toContain('Turn inbound logging on first');
  });

  it('flips the switch and takes the server\'s list as the new state', () => {
    service.toggle('wallet-app', true);
    const req = http.expectOne(`${BACKEND}/db-capture/projects/wallet-app/enabled`);
    expect(req.request.body).toEqual({ enabled: true });
    req.flush([project('wallet-app', true), project('core-service', false, false)]);
    expect(service.isOn('wallet-app', true)).toBeTrue();
  });

  it('flips the ▤ Logs switch beside ◆ - blocked while inbound logging is off, refusals shown', () => {
    service.toggleLogs('core-service', false);
    http.expectNone(`${BACKEND}/db-capture/projects/core-service/logs`);
    expect(service.logsOn('core-service', false)).toBeFalse();
    expect(service.logsTitle('core-service', false)).toContain('Turn logging on first');

    service.toggleLogs('wallet-app', true);
    const req = http.expectOne(`${BACKEND}/db-capture/projects/wallet-app/logs`);
    expect(req.request.body).toEqual({ on: true });
    req.flush([{ ...project('wallet-app', false), logsOn: true }, project('core-service', false, false)]);
    expect(service.logsOn('wallet-app', true)).toBeTrue();
    expect(service.isOn('wallet-app', true)).toBeFalse(); // ◆ untouched
    expect(service.logsTitle('wallet-app', true)).toContain('click to stop');
    expect(service.logsTitle('wallet-app', true)).toContain('ERROR and above'); // the default Log level

    service.setLogsOn('wallet-app', true);
    http.expectOne(`${BACKEND}/db-capture/projects/wallet-app/logs`)
      .flush({ error: 'Inbound logging is off for wallet-app' }, { status: 409, statusText: 'Conflict' });
    expect(service.switchError()).toContain('Inbound logging is off');
  });

  it('shows the server\'s refusal next to the switch', () => {
    service.setEnabled('wallet-app', true);
    http.expectOne(`${BACKEND}/db-capture/projects/wallet-app/enabled`)
      .flush({ error: 'Inbound logging is off for wallet-app' }, { status: 409, statusText: 'Conflict' });
    expect(service.switchError()).toContain('Inbound logging is off');
  });

  it('refreshes every view of the switch when another tab or user changes it', () => {
    (service as unknown as { onEvent(e: unknown): void }).onEvent({ type: 'capture-settings-changed', project: 'wallet-app' });
    http.expectOne(`${BACKEND}/db-capture/projects`).flush([project('wallet-app', true), project('core-service', false, false)]);
    expect(service.projectStatus('wallet-app')?.enabled).toBeTrue();
  });

  it('batches chip summaries into one request', async () => {
    service.requestSummary('c1');
    service.requestSummary('c2');
    service.requestSummary('c1');
    await Promise.resolve();
    const req = http.expectOne((r) => r.url === `${BACKEND}/db-capture/summaries`);
    expect(req.request.params.get('callIds')).toBe('c1,c2');
    req.flush({ c1: { callId: 'c1', statementCount: 2 } });
    expect(service.summaries().has('c1')).toBeTrue();
    expect(service.summaries().has('c2')).toBeFalse();
  });

  it('asks at most 100 ids a request - a longer URL is refused by the gateway (414)', async () => {
    for (let i = 0; i < 182; i++) service.requestSummary(`call-${i}`);
    await Promise.resolve();
    const reqs = http.match((r) => r.url === `${BACKEND}/db-capture/summaries`);
    expect(reqs.map((r) => r.request.params.get('callIds')!.split(',').length)).toEqual([100, 82]);
    reqs.forEach((r) => r.flush({}));
  });
});
