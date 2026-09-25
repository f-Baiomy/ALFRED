import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { CallRecord, SourceKey } from '../models/call.model';
import { CallFocusService, FocusableList } from './call-focus.service';
import { RuleDialogService, sourceCallOf } from './rule-dialog.service';

describe('RuleDialogService and CallFocusService', () => {
  let navigations: unknown[][];

  beforeEach(() => {
    navigations = [];
    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { navigate: (...args: unknown[]) => (navigations.push(args), Promise.resolve(true)) } }],
    });
  });

  const call = {
    id: 'in-7',
    source: 'internal',
    service_name: 'odeysys',
    method: 'post',
    url: 'http://localhost:8081/app/cart?x=1',
    original_url: 'http://localhost:8081/app/cart?x=1',
    response: { status: 409 },
  } as unknown as CallRecord;
  const ref = { source: 'internal' as const, callId: 'in-7', cycleId: 'cy1' };

  it('describes a call as the reference a rule keeps', () => {
    expect(sourceCallOf(call, ref)).toEqual({
      direction: 'inbound',
      callId: 'in-7',
      cycleId: 'cy1',
      label: 'POST localhost:8081/app/cart · 409',
      serviceName: 'odeysys',
    });
  });

  it('parks the form, goes to the call filtered to it, and brings the same form back', () => {
    const dialog = TestBed.inject(RuleDialogService);
    const focus = TestBed.inject(CallFocusService);
    dialog.openFromCall(call, ref);
    expect(dialog.request()?.fromCall?.ref).toEqual(ref);

    const snapshot = { ruleId: null, draft: { name: 'Rule for POST /app/cart', match: {}, actions: [] }, answerPath: [] };
    dialog.goToCall(sourceCallOf(call, ref), snapshot, null);
    expect(dialog.parked()).toBeTrue();
    expect(dialog.parkedTitle()).toBe('Rule for POST /app/cart');
    expect(dialog.request()).toEqual({ snapshot, rule: null });
    expect(navigations).toEqual([[['/cycles', 'cy1'], { queryParams: { requestId: 'in-7' } }]]);
    expect(focus.highlight()).toBe('in-7');

    // The cycle page: filtered to the call, its project selected - once.
    const selected = new Set<SourceKey>(['external']);
    const filters: string[] = [];
    const list: FocusableList = {
      selectedSources: () => selected,
      toggleSource: (key) => selected.add(key),
      setRequestIdFilter: (id) => filters.push(id),
    };
    focus.applyTo(list, 'other-cycle', 'in-7');
    expect(selected.has('odeysys')).withContext('a focus for another cycle is left alone').toBeFalse();
    focus.applyTo(list, 'cy1', 'in-7');
    expect(filters).toEqual(['in-7', 'in-7']);
    expect(selected.has('odeysys')).toBeTrue();

    dialog.returnToRule();
    expect(dialog.parked()).toBeFalse();
    expect(dialog.request()?.snapshot).toBe(snapshot);
    dialog.close();
    expect(dialog.request()).toBeNull();
  });
});
