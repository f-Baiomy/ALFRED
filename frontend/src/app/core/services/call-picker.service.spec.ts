import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CallRecord } from '../models/call.model';
import { CallPickerService, PickRequest } from './call-picker.service';

describe('CallPickerService', () => {
  let picker: CallPickerService;
  let navigated: string[];

  const call = (id: string, source: 'external' | 'internal' = 'external'): CallRecord => ({
    id,
    original_url: `https://a.com/${id}`,
    url: `https://a.com/${id}`,
    method: 'GET',
    timestamp: 't',
    duration_ms: 1,
    source,
    request: { headers: { authorization: 'secret' }, body: 'big body' },
    response: { status: 200, headers: { 'set-cookie': 's' }, body: 'big response' },
  });

  const request = (overrides: Partial<PickRequest> = {}): PickRequest => ({
    requester: 'test',
    title: 'Pick something',
    mode: 'single',
    returnUrl: '/back',
    returnLabel: 'the test',
    resume: { form: 'state' },
    ...overrides,
  });

  beforeEach(() => {
    sessionStorage.removeItem('alfred_call_picker');
    navigated = [];
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { navigateByUrl: (url: string) => navigated.push(url) } }],
    });
    picker = TestBed.inject(CallPickerService);
  });

  afterEach(() => sessionStorage.removeItem('alfred_call_picker'));

  it('replaces the pick in single mode, and toggles it off on a second press', () => {
    picker.start(request());
    picker.toggle(call('a'), null, 'Live calls');
    picker.toggle(call('b'), null, 'Live calls');
    expect(picker.picked().map((p) => p.ref.callId)).toEqual(['b']);

    picker.toggle(call('b'), null, 'Live calls');
    expect(picker.picked()).toEqual([]);
  });

  it('collects in multi mode, and tells the same call in the live log and in a cycle apart', () => {
    picker.start(request({ mode: 'multi' }));
    picker.toggle(call('a'), null, 'Live calls');
    picker.toggle(call('a'), 'cy1', 'Cycle "x"');
    expect(picker.picked().map((p) => p.ref.cycleId)).toEqual([null, 'cy1']);
    expect(picker.isPicked(call('a'), 'cy1')).toBeTrue();
    expect(picker.isPicked(call('a'), 'cy2')).toBeFalse();
  });

  it('keeps no bodies or headers in a pick', () => {
    picker.start(request());
    picker.toggle(call('a'), null, 'Live calls');
    const kept = picker.picked()[0].call;
    expect(kept.request).toBeUndefined();
    expect(kept.response).toEqual({ status: 200 });
  });

  it('refuses calls from a refused origin, with the reason', () => {
    picker.start(request({ mode: 'multi', refuseOrigin: { cycleId: 'cy1', reason: 'Already in this cycle' } }));
    expect(picker.refusal(call('a'), 'cy1')).toBe('Already in this cycle');
    picker.toggle(call('a'), 'cy1', 'Cycle');
    expect(picker.picked()).toEqual([]);
    expect(picker.refusal(call('a'), null)).toBeNull();
  });

  it('hands the result and resume back once, then goes back', () => {
    picker.start(request());
    picker.toggle(call('a', 'internal'), 'cy1', 'Cycle "x"');
    picker.finish();

    expect(picker.active()).toBeFalse();
    expect(navigated).toEqual(['/back']);
    expect(picker.hasResult('test')).toBeTrue();
    const result = picker.takeResult('test')!;
    expect(result.picked[0].ref).toEqual({ source: 'internal', callId: 'a', cycleId: 'cy1' });
    expect(result.resume).toEqual({ form: 'state' });
    expect(picker.takeResult('test')).toBeNull();
  });

  it('does not finish with nothing picked', () => {
    picker.start(request());
    picker.finish();
    expect(picker.active()).toBeTrue();
    expect(navigated).toEqual([]);
  });

  it('still hands back resume on cancel, with no picks, so unsaved work is never lost', () => {
    picker.start(request());
    picker.toggle(call('a'), null, 'Live calls');
    picker.cancel();
    const result = picker.takeResult('test')!;
    expect(result.picked).toEqual([]);
    expect(result.resume).toEqual({ form: 'state' });
    expect(navigated).toEqual(['/back']);
  });

  it('survives a reload through sessionStorage', () => {
    picker.start(request());
    picker.toggle(call('a'), null, 'Live calls');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: Router, useValue: { navigateByUrl: () => true } }] });
    const reloaded = TestBed.inject(CallPickerService);
    expect(reloaded.request()?.title).toBe('Pick something');
    expect(reloaded.picked().map((p) => p.ref.callId)).toEqual(['a']);
  });
});
