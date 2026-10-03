import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReliveSessionPanelComponent } from './relive-session-panel.component';
import { FrozenCall, ReliveSettings, Step } from '../../shared/utils/relive-types';

function step(key: string, recording: Partial<FrozenCall>): Step {
  return {
    key,
    parentKey: null,
    label: key,
    enabled: true,
    optional: false,
    direction: 'inbound',
    serviceName: 'odeysys',
    callRule: { name: key, enabled: true, priority: 0, match: {}, actions: [] } as unknown as Step['callRule'],
    unattributed: 'BLOCK',
    recording: {
      method: 'GET',
      url: `http://localhost:8080/${key}`,
      requestHeaders: {},
      requestBody: null,
      status: 200,
      responseHeaders: {},
      responseBody: '',
      timestamp: 't',
      durationMs: 1,
      source: 'inbound',
      ...recording,
    },
    source: { callId: key, cycleId: null, direction: 'inbound' },
    extract: [],
    assertions: [],
    noise: [],
  };
}

const settings: ReliveSettings = { inboundMode: 'LIVE', onFailure: 'HOLD', onDifferences: 'CONTINUE', defaultDriver: 'AUTOMATIC', internalHosts: [] };

describe('ReliveSessionPanelComponent', () => {
  let fixture: ComponentFixture<ReliveSessionPanelComponent>;
  const login = step('login', {
    responseHeaders: { 'Set-Cookie': 'JSESSIONID=SESS-4455667788; Path=/' },
    responseBody: '{"accessToken":"tok-abcdef123"}',
  });
  const home = step('home', { requestHeaders: { Cookie: 'JSESSIONID=SESS-4455667788', Authorization: 'Bearer tok-abcdef123' } });

  beforeEach(() => {
    fixture = TestBed.createComponent(ReliveSessionPanelComponent);
    fixture.componentRef.setInput('steps', [login, home]);
    fixture.componentRef.setInput('settings', settings);
    fixture.detectChanges();
  });

  it('counts only the token as pending while cookies are carried, and Use all extracts it', () => {
    const emitted: Step[][] = [];
    fixture.componentInstance.stepsChange.subscribe((steps) => emitted.push([...steps]));

    expect(fixture.nativeElement.textContent).toContain('1 value passed between steps not used yet');
    (fixture.nativeElement.querySelector('.rl-primary') as HTMLButtonElement).click();

    expect(emitted[0][0].extract).toEqual([{ from: 'JSON', path: 'accessToken', as: 'accessToken', missing: 'SKIP', recordedValue: 'tok-abcdef123' }]);
  });

  it('offers the cookie too once carrying cookies is off', () => {
    fixture.componentRef.setInput('settings', { ...settings, carryCookies: false });
    fixture.detectChanges();

    expect(fixture.componentInstance.pending().map((c) => c.kind)).toEqual(jasmine.arrayWithExactContents(['JSON', 'COOKIE']));
  });

  it('turns the settings off from the review list', () => {
    const emitted: ReliveSettings[] = [];
    fixture.componentInstance.settingsChange.subscribe((s) => emitted.push(s));
    fixture.componentInstance.expanded.set(true);
    fixture.detectChanges();

    const boxes = fixture.nativeElement.querySelectorAll('label.rl-check-row input') as NodeListOf<HTMLInputElement>;
    boxes[0].click();
    boxes[1].click();

    expect(emitted[0].carryCookies).toBeFalse();
    expect(emitted[1].replayIgnoresCredentials).toBeFalse();
  });

  it('unticks a used value, and Clear all stops using every one', () => {
    const used = [{ ...login, extract: [{ from: 'JSON' as const, path: 'accessToken', as: 'accessToken', missing: 'SKIP' as const, recordedValue: 'tok-abcdef123' }] }, home];
    const emitted: Step[][] = [];
    fixture.componentInstance.stepsChange.subscribe((steps) => emitted.push([...steps]));
    fixture.componentRef.setInput('steps', used);
    fixture.componentInstance.expanded.set(true);
    fixture.detectChanges();

    const token = Array.from(fixture.nativeElement.querySelectorAll('label.rl-session-chain input') as NodeListOf<HTMLInputElement>).find((box) => box.checked && !box.disabled)!;
    token.click();
    const clearAll = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find((b) => b.textContent!.includes('Clear all'))!;
    clearAll.click();

    expect(emitted.length).toBe(2);
    expect(emitted[0][0].extract).toEqual([]);
    expect(emitted[1][0].extract).toEqual([]);
  });

  it('a cookie carried by the jar is ticked and locked', () => {
    fixture.componentInstance.expanded.set(true);
    fixture.detectChanges();

    const cookieBox = (fixture.nativeElement.querySelectorAll('label.rl-session-chain input') as NodeListOf<HTMLInputElement>)[0];
    expect(fixture.componentInstance.chains()[0].kind).toBe('COOKIE');
    expect(cookieBox.checked).toBeTrue();
    expect(cookieBox.disabled).toBeTrue();
  });
});
