import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { defaultCallRule } from '../../shared/utils/relive-call-rule';
import { FrozenCall, ReliveSettings, Step } from '../../shared/utils/relive-types';
import { ReliveStepDrawerComponent } from './relive-step-drawer.component';

const recording: FrozenCall = {
  method: 'POST',
  url: 'https://api.supplier-a.com/v2/search',
  requestHeaders: {},
  requestBody: '{"origin":"DXB"}',
  status: 200,
  responseHeaders: {},
  responseBody: '{"results":12}',
  timestamp: '2026-09-27T10:00:00Z',
  durationMs: 420,
  sessionId: null,
  operationId: null,
  serviceName: 'odeysys',
  source: 'outbound',
};

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

function makeStep(): Step {
  return {
    key: 'c-supA',
    parentKey: 's-search',
    label: 'POST /v2/search',
    enabled: true,
    optional: false,
    direction: 'outbound',
    serviceName: 'odeysys',
    callRule: defaultCallRule({ key: 'c-supA', parentKey: 's-search', label: 'POST /v2/search', recording }, settings),
    unattributed: 'BLOCK',
    recording,
    source: { callId: 'call-1', cycleId: null, direction: 'outbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

describe('ReliveStepDrawerComponent', () => {
  let fixture: ComponentFixture<ReliveStepDrawerComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [ReliveStepDrawerComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    fixture = TestBed.createComponent(ReliveStepDrawerComponent);
    fixture.componentRef.setInput('step', makeStep());
    fixture.detectChanges();
  });

  it('shows the recorded request on the Request tab', () => {
    fixture.componentInstance.setTab('request');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('"origin":"DXB"');
  });

  it('shows the recorded response on the Response tab', () => {
    fixture.componentInstance.setTab('response');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('"results":12');
  });

  it('editing the label emits an updated step', () => {
    let emitted: Step | null = null;
    fixture.componentInstance.stepChange.subscribe((s: Step) => (emitted = s));

    const input: HTMLInputElement = fixture.nativeElement.querySelector('input:not([type="checkbox"])');
    input.value = 'Renamed';
    input.dispatchEvent(new Event('input'));

    expect(emitted!.label).toBe('Renamed');
  });

  it('closing emits closed', () => {
    const closedSpy = jasmine.createSpy('closed');
    fixture.componentInstance.closed.subscribe(closedSpy);
    fixture.nativeElement.querySelector('.icon-btn').click();
    expect(closedSpy).toHaveBeenCalled();
  });
});
