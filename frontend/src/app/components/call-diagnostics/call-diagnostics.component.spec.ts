import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { CallDiagnosticsComponent } from './call-diagnostics.component';
import { CallRecord, CallTiming } from '../../core/models/call.model';
import { CallTiming as Timing } from '../../shared/utils/call-diagnostics';

function timingFor(measured: CallTiming | null, durationMs: number): Timing {
  return {
    call: { id: 'c', url: 'https://host/x', method: 'POST', timing: measured } as unknown as CallRecord,
    offsetMs: 0,
    durationMs,
    endMs: durationMs,
    slackMs: 0,
    onCriticalPath: true,
    failed: false,
  };
}

describe('CallDiagnosticsComponent phases', () => {
  let component: CallDiagnosticsComponent;

  beforeEach(async () => {
    // The component fetches an endpoint baseline on expand, so it injects CallsApiService.
    await TestBed.configureTestingModule({
      imports: [CallDiagnosticsComponent],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    component = TestBed.createComponent(CallDiagnosticsComponent).componentInstance;
  });

  it('subtracts the handshake out of time-to-first-byte so the phases sum to the duration', () => {
    // Measured live against example.com: mitmproxy connects lazily, so connect and TLS happen
    // INSIDE the ttfb window. Treated as consecutive segments these sum to 328ms for a 196.62ms
    // call - a bar 167% wide.
    const result = component.phases(
      timingFor({ connect_ms: 74.5, tls_ms: 57.03, ttfb_ms: 193.82, download_ms: 2.77, reused_connection: false }, 196.62)
    )!;

    const total = result.segments.reduce((sum, segment) => sum + parseFloat(segment.width), 0);
    expect(total).toBeGreaterThan(99);
    expect(total).toBeLessThan(101);
  });

  it('reports the upstream think time left after the handshake', () => {
    const result = component.phases(
      timingFor({ connect_ms: 74.5, tls_ms: 57.03, ttfb_ms: 193.82, download_ms: 2.77, reused_connection: false }, 196.62)
    )!;

    // 193.82 - 74.5 - 57.03 = 62.29ms actually waiting on the server itself.
    const thinking = result.segments.find((segment) => segment.kind === 'ttfb')!;
    expect(thinking.title).toBe('upstream thinking 62ms');
  });

  it('calls out connection churn when the handshake dominates', () => {
    const result = component.phases(
      timingFor({ connect_ms: 300, tls_ms: 400, ttfb_ms: 900, download_ms: 100, reused_connection: false }, 1000)
    )!;

    expect(result.summary).toContain('connect and TLS');
    expect(result.summary).toContain('not being reused');
  });

  it('says a call rode a reused connection when there was no handshake to pay for', () => {
    const result = component.phases(
      timingFor({ connect_ms: null, tls_ms: null, ttfb_ms: 800, download_ms: 50, reused_connection: true }, 850)
    )!;

    expect(result.summary).toContain('reused connection');
    expect(result.segments.some((segment) => segment.kind === 'connect')).toBe(false);
  });

  it('renders nothing at all for a call logged before the proxy measured phases', () => {
    expect(component.phases(timingFor(null, 500))).toBeNull();
  });

  it('never renders a negative segment when ttfb is smaller than the handshake it contains', () => {
    // Clock granularity can make the parts cross over on a very fast local call.
    const result = component.phases(
      timingFor({ connect_ms: 40, tls_ms: 40, ttfb_ms: 50, download_ms: 10, reused_connection: false }, 100)
    )!;

    expect(result.segments.every((segment) => parseFloat(segment.width) >= 0)).toBe(true);
    expect(result.segments.some((segment) => segment.kind === 'ttfb')).toBe(false);
  });
});
